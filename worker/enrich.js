// Step Out — cheap link enrichment (Tier 3).
// The board's honest "🔎 Find this locally" search links get upgraded to real,
// fetch-verified official pages WITHOUT paying Anthropic's per-search fee:
//   1. shared KV cache (link:<place>:<title>) — a place verified once is free for
//      every later visitor (positive TTL 60d, negative "" TTL 7d).
//   2. cache misses → Brave Search API (free tier) finds candidate URLs — this is
//      the step that used to be Anthropic web_search ($0.01 each).
//   3. ONE Haiku call with web_fetch (NO web_search) fetch-verifies the best
//      candidate per title — keeps the "we actually loaded and read it" guarantee
//      that makes this more than a search. Never invents a URL.
// Best-effort throughout: any failure just returns fewer links, and the page keeps
// the honest search link. Wired from worker.js:
//   import { handleEnrich } from "./enrich.js";
//   if (new URL(request.url).pathname.endsWith("/enrich")) return handleEnrich(env, cors.headers, body);
//
// Extra bindings (beyond worker.js's):
//   secret BRAVE_API_KEY  — Brave Search API token (wrangler secret put)
//   kv     LINKS          — verified-link cache (optional; skips caching if absent)

const UPSTREAM = "https://api.anthropic.com/v1/messages";
const BRAVE_URL = "https://api.search.brave.com/res/v1/web/search";
const MAX_TITLES = 12;

const slug = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
// The title keeps its punctuation/word distinctions (only case + whitespace are
// normalised) so two different cards can't collapse onto one cache key the way a
// full slug would ("Mums & Tots" vs "Mums Tots!"). KV keys allow this charset.
const normTitle = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);
const kvKey = (place, t) => `link:${slug(place)}:${normTitle(t)}`;
const isUrl = s => /^https?:\/\//i.test(String(s || "").trim());

function json(data, cors) {
  return new Response(JSON.stringify(data), { status: 200, headers: { ...cors, "content-type": "application/json" } });
}

// Pull the outermost JSON array/object out of prose/``` fences (mirrors the page's extractJson).
function extractJson(s) {
  const str = String(s);
  const fence = str.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : str;
  const first = Math.min(...["[", "{"].map(c => { const i = body.indexOf(c); return i < 0 ? Infinity : i; }));
  const last = Math.max(body.lastIndexOf("]"), body.lastIndexOf("}"));
  if (first === Infinity || last < first) return null;
  try { return JSON.parse(body.slice(first, last + 1)); } catch { return null; }
}

// Brave web search → up to 4 candidate {url,title} for one query. The Search plan
// allows 50 req/s, so handleEnrich fans these out in parallel; any failure — incl.
// the monthly free-credit cap pausing the API — returns [] (best-effort: the page
// then just keeps its honest "find this locally" link).
async function braveSearch(env, query) {
  if (!env.BRAVE_API_KEY) return [];
  try {
    const r = await fetch(`${BRAVE_URL}?q=${encodeURIComponent(query)}&count=5&country=gb`, {
      headers: { "Accept": "application/json", "X-Subscription-Token": env.BRAVE_API_KEY },
    });
    if (!r.ok) return [];
    const d = await r.json();
    return (((d.web && d.web.results) || []).slice(0, 4)).map(x => ({ url: x.url, title: x.title }));
  } catch { return []; }
}

function buildVerifyPrompt(place, candidates) {
  const lines = Object.entries(candidates).map(([t, cs]) =>
    `- "${t}"\n` + cs.map(c => `    • ${c.url}${c.title ? " — " + c.title : ""}`).join("\n")
  ).join("\n");
  return `You are checking real web pages for a UK community board in ${place}.
For each opportunity below you are given candidate URLs from a web search. For each opportunity:
1. Pick the single best candidate that is the real, official/first-party, on-topic page for THIS opportunity in ${place} — the organisation's own site, the council/parish/library listing, or an official community directory entry. Prefer first-party/official over aggregators.
2. Use web_fetch to CONFIRM that URL actually loads and is genuinely about this opportunity in ${place}. If it fails, 404s, redirects to something unrelated, or is off-topic, try another candidate for that opportunity, or drop it.
Then return ONLY a JSON array and nothing else — no prose, no markdown fences:
[{"t":"<title copied exactly>","url":"<the exact URL you fetched and confirmed>"}]
Hard rules — a wrong or dead link is FAR worse than none:
- Only use URLs from the candidates I gave you. NEVER invent, guess, or modify a URL.
- NEVER return a URL you did not successfully web_fetch and confirm is live and on-topic.
- Omit any opportunity with no confirmed page. An empty array is a perfectly good answer.

Opportunities and candidates:
${lines}`;
}

// ONE Anthropic call (Haiku, web_fetch only) that fetch-verifies + picks the best
// candidate per title. Returns { "<title>": "<url>" } for confirmed links only.
// Resumes the server tool loop on pause_turn. Throws on a hard upstream failure.
async function verifyPick(env, place, candidates) {
  const messages = [{ role: "user", content: buildVerifyPrompt(place, candidates) }];
  const n = Object.keys(candidates).length;
  const cap = Math.min(10, Math.max(6, n + 2));
  for (let i = 0; i < 4; i++) {
    const r = await fetch(UPSTREAM, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-fetch-2025-09-10",
      },
      body: JSON.stringify({
        model: (env && env.MODEL) || "claude-haiku-4-5",
        max_tokens: 1500,
        tools: [{ type: "web_fetch_20250910", name: "web_fetch", max_uses: cap }],
        messages,
      }),
    });
    if (!r.ok) throw new Error("upstream " + r.status);
    const msg = await r.json();
    if (msg.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: msg.content }); continue; }
    if (msg.stop_reason !== "end_turn") throw new Error("stop " + msg.stop_reason);
    const texts = (msg.content || []).filter(b => b.type === "text");
    const arr = texts.length ? extractJson(texts[texts.length - 1].text) : null;
    // Key each confirmed URL back to the INPUT title it was a candidate for — the
    // model paraphrases "t" (returns the page's own name, not our exact string), so
    // matching on its text fails. The URL is the reliable join. This also enforces
    // "only a URL we actually offered": a non-candidate URL isn't in the map, so a
    // hallucinated/coaxed link can never be cached and served as "verified".
    const urlToTitle = new Map();
    Object.entries(candidates).forEach(([t, cs]) => cs.forEach(c => { if (!urlToTitle.has(c.url)) urlToTitle.set(c.url, t); }));
    const out = {};
    if (Array.isArray(arr)) arr.forEach(o => {
      if (!o || !isUrl(o.url)) return;
      const url = String(o.url).trim();
      const title = urlToTitle.get(url);
      if (title) out[title] = url; // our title, not the model's rename
    });
    return out;
  }
  throw new Error("too many pauses");
}

// POST /enrich  { place, titles:[...] }  ->  [{ t, url }]  (confirmed links only)
export async function handleEnrich(env, cors, body) {
  const place = String((body && body.place) || "").slice(0, 120);
  const titles = Array.isArray(body && body.titles)
    ? body.titles.filter(t => typeof t === "string" && t.trim()).slice(0, MAX_TITLES)
    : [];
  if (!place || !titles.length) return json([], cors);

  // 1. shared cache — a hit (incl. a negative "") skips search+verify entirely.
  const cached = {};       // title -> url ("" = confirmed no link found before)
  const misses = [];
  for (const t of titles) {
    let hit = null;
    if (env.LINKS) { try { hit = await env.LINKS.get(kvKey(place, t)); } catch { hit = null; } }
    if (hit !== null) cached[t] = hit; else misses.push(t);
  }

  // 2. + 3. Brave search the misses, then one Haiku fetch-verify pass.
  let picks = {};
  if (misses.length) {
    const candidates = {};
    // Brave Search allows 50 req/s, so fan the misses out in parallel (a full
    // board is ~8 titles — well under the cap) rather than trickling them.
    const searches = await Promise.all(misses.map(t => braveSearch(env, `${t} ${place}`)));
    misses.forEach((t, i) => { if (searches[i].length) candidates[t] = searches[i]; });
    if (Object.keys(candidates).length) {
      try { picks = await verifyPick(env, place, candidates); } catch { picks = {}; } // best-effort: keep search links on failure
    }
    // Cache what we learned: real URL 60d, "nothing found" 7d (retry sooner).
    if (env.LINKS) {
      await Promise.all(misses.map(t => {
        const u = picks[t] || "";
        return env.LINKS.put(kvKey(place, t), u, { expirationTtl: u ? 60 * 86400 : 7 * 86400 }).catch(() => {});
      }));
    }
  }

  // Return confirmed links only — the page keeps its honest search link for the rest.
  const out = titles
    .map(t => ({ t, url: (t in cached ? cached[t] : (picks[t] || "")) }))
    .filter(o => isUrl(o.url));
  return json(out, cors);
}
