# Deploying the demo proxy (Cloudflare Worker)

Ten minutes, one Cloudflare account (free tier is plenty: 100k requests/day).
The worker holds the API key server-side; the public pages route live calls to
it via the `PROXY` constant, so no key ever ships to a browser.

## Steps

1. `cd worker`
2. `npx wrangler login` (opens a browser for the Cloudflare account)
3. `npx wrangler kv namespace create RATE` — paste the returned `id` into the
   commented `[[kv_namespaces]]` block in `wrangler.toml`. Skipping this
   disables rate limiting entirely — don't skip it for a public deploy.
4. In `wrangler.toml`, set `ALLOWED_ORIGINS` to your Cloudflare Pages origins
   (e.g. `https://<project>.pages.dev` plus your custom domain) — leave `*`
   only while testing. Copy `wrangler.toml.example` to `wrangler.toml` and fill
   in the KV id.
5. `npx wrangler secret put ANTHROPIC_API_KEY` — use a key from a dedicated
   workspace with a monthly spend limit set in the Anthropic Console. The
   Console limit is the real backstop; the worker caps are the polite layer.
6. `npx wrangler deploy` — note the printed URL, e.g.
   `https://step-out-proxy.<account>.workers.dev`

## Wire the pages to it

Publish with the proxy URL injected:

```
PROXY_URL="https://step-out-proxy.<account>.workers.dev" bin/publish-portfolio.sh <target-dir>
```

The private-repo pages keep `PROXY=""` (direct call with your own key —
localhost and demo behaviour unchanged); only the published copies get the URL.

## Smoke test

```
curl -s https://step-out-proxy.<account>.workers.dev \
  -X POST -H 'content-type: application/json' \
  -d '{"model":"ignored","max_tokens":64,"messages":[{"role":"user","content":"Say OK."}]}'
```

Expect a normal Anthropic message response (model will report the Haiku tier).
Eleventh call from the same IP in a day should return 429 with a friendly
message — the pages render that as the full-board fallback.

## What the worker enforces

- Model forced to `MODEL` (claude-haiku-4-5) whatever the client sends, so a
  tampered request can't run an expensive model on the demo key.
- `max_tokens` clamped to `MAX_TOKENS`; `thinking` and `output_config.effort`
  stripped (Haiku 4.5 rejects effort; structured-output `format` is kept).
- Per-IP and global daily caps in KV; 429s degrade to the pages' friendly
  full-board fallback.
- Origin allowlist; 8MB body cap (Snap sends base64 images/PDFs).
