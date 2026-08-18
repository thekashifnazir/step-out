// Step Out demo proxy — Cloudflare Worker.
// Holds the Anthropic API key server-side so the public demo pages never ship one.
// Forwards POST bodies to /v1/messages with the key injected, the model forced to a
// cheap tier, and coarse daily rate limits (global + per-IP) via KV.
// The pages' failure ladder treats any non-OK response as "show the full board with
// a friendly line", so a 429 here degrades gracefully on the demo side.
//
// Bindings (see wrangler.toml / DEPLOY.md):
//   secret ANTHROPIC_API_KEY   — the real key (wrangler secret put)
//   kv     RATE                — rate-limit counters (optional; limits skip if absent)
//   var    ALLOWED_ORIGINS     — comma-separated origins, e.g. "https://<project>.pages.dev"
//   var    MODEL               — forced model for proxied traffic (default claude-haiku-4-5)
//   var    MAX_TOKENS          — clamp on max_tokens (default 2048)
//   var    DAILY_CAP           — global calls/day (default 200)
//   var    IP_CAP              — calls/day per IP (default 10)

import { handleEnrich } from "./enrich.js";

const UPSTREAM = "https://api.anthropic.com/v1/messages";
const MAX_BODY_BYTES = 8 * 1024 * 1024; // snap sends base64 images/PDFs
// Only these anthropic-beta flags are forwarded upstream (web_fetch needs one).
const ALLOWED_BETAS = new Set(["web-fetch-2025-09-10"]);

export function prepareUpstreamBody(body, env) {
  // Force the public-traffic model and strip params it doesn't accept.
  // Haiku 4.5 rejects output_config.effort and has no default thinking, so both
  // the effort field and any thinking config are dropped; structured-output
  // format is kept (Haiku 4.5 supports it).
  const model = (env && env.MODEL) || "claude-haiku-4-5";
  const cap = parseInt((env && env.MAX_TOKENS) || "2048", 10);
  const out = { ...body, model };
  out.max_tokens = Math.min(Math.max(1, out.max_tokens || 1024), cap);
  delete out.thinking;
  if (out.output_config && typeof out.output_config === "object") {
    const oc = { ...out.output_config };
    delete oc.effort;
    out.output_config = oc;
  }
  return out;
}

function corsHeaders(origin, env) {
  const allowed = ((env && env.ALLOWED_ORIGINS) || "*").split(",").map(s => s.trim());
  const ok = allowed.includes("*") || (origin && allowed.includes(origin));
  return {
    ok,
    headers: {
      "access-control-allow-origin": ok ? (origin || "*") : "null",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers":
        "content-type, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access, anthropic-beta",
      "access-control-max-age": "86400",
      "vary": "origin",
    },
  };
}

function refuse(status, message, headers) {
  return new Response(
    JSON.stringify({ type: "error", error: { type: "rate_limit_error", message } }),
    { status, headers: { ...headers, "content-type": "application/json" } },
  );
}

async function bumpCounter(env, key, cap) {
  // KV is eventually consistent — these are coarse cost caps, not precision limits.
  const current = parseInt((await env.RATE.get(key)) || "0", 10);
  if (current >= cap) return false;
  await env.RATE.put(key, String(current + 1), { expirationTtl: 172800 });
  return true;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("origin");
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors.headers });
    }
    if (!cors.ok) {
      return refuse(403, "origin not allowed", cors.headers);
    }
    if (request.method !== "POST") {
      return refuse(405, "POST only", cors.headers);
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return refuse(413, "request too large for the demo proxy", cors.headers);
    }
    let body;
    try { body = JSON.parse(raw); } catch {
      return refuse(400, "invalid JSON", cors.headers);
    }

    if (env.RATE) {
      const day = new Date().toISOString().slice(0, 10);
      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      const ipOk = await bumpCounter(env, `ip:${day}:${ip}`, parseInt(env.IP_CAP || "10", 10));
      if (!ipOk) return refuse(429, "today's live-search limit for this connection is reached — the page will show canned samples; live returns tomorrow", cors.headers);
      const dayOk = await bumpCounter(env, `d:${day}`, parseInt(env.DAILY_CAP || "200", 10));
      if (!dayOk) return refuse(429, "the shared daily budget for live search is spent — the page will show canned samples; live returns tomorrow", cors.headers);
    }

    // Cheap link enrichment (Brave search + Haiku fetch-verify + shared KV cache)
    // is handled in its own module; all other POSTs fall through to the passthrough.
    if (new URL(request.url).pathname.endsWith("/enrich")) {
      return handleEnrich(env, cors.headers, body);
    }

    // Forward ONLY allowlisted anthropic-beta flags — never pass a crafted value
    // straight through, which could unlock other (billable) beta-gated tools.
    const beta = (request.headers.get("anthropic-beta") || "")
      .split(",").map(s => s.trim()).filter(b => ALLOWED_BETAS.has(b)).join(",");
    const upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": request.headers.get("anthropic-version") || "2023-06-01",
        ...(beta ? { "anthropic-beta": beta } : {}),
      },
      body: JSON.stringify(prepareUpstreamBody(body, env)),
    });

    const respHeaders = { ...cors.headers, "content-type": "application/json" };
    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
  },
};
