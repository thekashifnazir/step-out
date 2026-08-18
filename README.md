# Step Out

A community notice board that answers back. Tell it where you live and it sketches a board of the community life around you. Tell it your situation the way you'd tell a neighbour, and it picks out the three or four things worth your time and says why each one fits, in whatever language you wrote it in.

**[Open the site →](https://stepout.kashifnazir.com/)** No account, no tracking, nothing to install.

![A Step Out board sketched for Market Harborough: a conversational "what do you want to do?" box up top, a reachability filter, and a grid of community opportunities. Every card is labelled "sketch, unverified, from public knowledge" with a "find this locally" link.](board.jpg)

## Four decisions worth explaining

**Claude does the judging, a search engine does the finding.** Every board card links to the real page behind it, and that started as a Claude web search per card. It worked and it cost about $0.15 a board. An ordinary Brave search finds the same page, so it now does the finding and a single Claude call confirms the pick loads and is on topic. That's about $0.03 for a place nobody has looked up yet, and nothing at all for one already cached. The model kept the job it was better at and lost the one it was only equal at.

**The matcher prompt is on v2.2 because v1 made things up.** Earlier versions kept flagging unmet needs the person had never asked for, inferring a gap from the shape of the request. An explicit-asks-only rule went in and the whole 40-check battery was re-run live against it. It's the failure I'd have shipped if the evals hadn't been there from the first hour.

**Self-hosting doesn't survive contact with the numbers.** I looked properly at running an open model to get the per-call cost to zero. A GPU server costs more per day than months of pay-per-call at the traffic a portfolio project sees. The version of that idea that does work is bring-your-own-agent: serve the board data and its verbs to whatever model you already run, and the cost sits with whoever's asking.

**Every card says where it came from.** Real entries name their source, sketched entries wear an unverified stamp, snapped entries are marked pending re-verification. That discipline exists because of one measurement: comparing the same community newsletter a year apart, 18 of the 21 opportunities it listed had ended, moved or changed, which is 86%. Freshness has to be a field rather than a hope, and a board with no provenance can't have one.

## Where the AI is

Every model call goes to Claude with structured outputs, so the response is guaranteed to parse. Three live uses:

**The sketcher.** Name a UK place and one call drafts a board from public knowledge, stamped unverified, hedged to "check locally" instead of inventing times. The honest cold start is the design: a sketch that a local then verifies.

**The matcher.** Free text plus the active board goes up, ranked matches with a specific reason each come back, in the language you wrote. The prompt weighs anchors for newcomers, meaning recurring, role-giving, low-pressure things, and spreads across every opportunity type from volunteering to grants. When nothing on the board fits, it says so instead of stretching a bad match.

**Extraction.** Snap turns a photo or PDF into schema-valid entries and refuses to output personal contact details. A name and mobile on a flyer becomes "activity coordinator".

One idea here is a concept, not a live feature. Turning unmet asks into demand signals, where several people asking for the same missing thing becomes a reason to start it, needs real usage logged over time, and I never put real people's data behind it. The frozen hackathon demo shows the shape of it; the live site doesn't run it.

## Architecture

The whole thing runs on Cloudflare's edge. Static pages call one Worker that holds the API key and decides where each request goes: the AI jobs go to Claude, finding a card's link goes to Brave, and a shared cache means a place is only ever searched once.

![Step Out architecture: static Cloudflare Pages call one Worker that holds the key and routes AI jobs (match, sketch, extract) to Claude; a separate link job runs /enrich, which checks a shared KV cache, and on a miss searches Brave then confirms with one Haiku call before caching the result so repeat places are free. A planned bring-your-own-agent path is not built yet.](arch.svg)

## What it costs to run

Nearly nothing, by design. Browsing is static files on Cloudflare Pages. Live calls route through a Worker of about 100 lines on the same edge, which holds the API key server-side, pins public traffic to a fast cheap model, and caps usage per visitor and per day, with a workspace spend limit behind it as the real backstop.

A matcher call costs under a penny and realistic traffic costs pennies a month. A shared edge cache means a place is searched once and then loads in a fraction of a second for everyone after it, so the cache saves money and makes the repeat visit instant.

## Running it

Every page works with no key and no network. The mock-first machinery came out of hackathon paranoia and stayed because it makes the repo openable by anyone.

```
git clone https://github.com/thekashifnazir/step-out.git && cd step-out
python3 -m http.server 8000
# then open http://localhost:8000
```

Browsing the example boards is free. Append `?mock=1` to any page for canned AI responses without a key, or paste your own Anthropic key for live calls.

Repo map:

```
index.html  board.html  snap.html  about.html   the live product
hackathon.html                                  the build story
hackathon/                                      the original build, frozen and unchanged
worker/                                         the Cloudflare Worker: proxy + /enrich (worker.js, enrich.js)
README.md  LICENSE  arch.svg  board.jpg
```

Two harnesses guard it: a 180-check browser suite, and an end-to-end test of the published output. The 40-check matcher battery is still runnable in mock.

## Where to look

If you're reading the code, the parts worth your time:

- `worker/worker.js` — the proxy: the API key held server-side, the model pinned to Haiku, per-IP and per-day rate limits in KV, and an origin allowlist.
- `worker/enrich.js` — the cost engineering: the `/enrich` cache-first loop (KV cache, then Brave, then one Haiku call to confirm, then cache the result).
- `board.html` — the product itself: the sketcher, the matcher, and the first-week path, all client-side over the proxy.
- `hackathon/step-out-eval.html` — the 40-check matcher eval battery, runnable in mock.

## The pages

| Page | What it does |
| --- | --- |
| [Board](https://stepout.kashifnazir.com/board.html) | Two hand-checked example boards, Somers Town in London and Foxton in Leicestershire, every entry sourced. The matcher runs on top and returns a shortlist, or a step-by-step first-week path when it's a project. A sketcher drafts a board for any UK place. |
| [Snap](https://stepout.kashifnazir.com/snap.html) | Photograph a noticeboard or drop in a PDF newsletter. Structured entries fall out, contact details stripped to roles, ready to add to your own board. |
| [Hackathon](https://stepout.kashifnazir.com/hackathon.html) | The original build, preserved unchanged at [/hackathon/](https://stepout.kashifnazir.com/hackathon/index.html) and tagged `hackathon-build`. |

## Where it came from

A solo three-hour-ten-minute build at Claude Impact Lab London on 30 July 2026, run as one integrator session orchestrating parallel Claude Code agent streams in git worktrees, each owning disjoint files and each feature stamped against the commit it passed at. Twenty-eight landed that way.

The site has been tidied up and condensed since, into what you're reading about now. The original is frozen at [/hackathon/](https://stepout.kashifnazir.com/hackathon/index.html) so you can compare.

The one thing I'd change for my next hackathon is fewer features. Three or four polished properly would have made a better demo than twenty-eight that mostly work. The full story, including the rest of what I'd do differently, is in [the writeup](https://stepout.kashifnazir.com/hackathon.html).

## Reuse

© Kashif Nazir 2026. Shared for portfolio review only and not licensed for reuse. If you'd like to use any of it, get in touch.
