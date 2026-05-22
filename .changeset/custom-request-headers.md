---
"@shopify/ucp-cli": minor
---

Custom HTTP headers on UCP requests, with a built-in User-Agent default.

Adds a four-source resolver merged into a single header bag per dispatch:

1. CLI built-in: `User-Agent: @shopify/ucp-cli/<version>` (lowest priority — identifies CLI traffic in merchant logs / WAFs).
2. `~/.ucp/profiles/<name>/headers.json` `default` block — apply to every request.
3. `~/.ucp/profiles/<name>/headers.json` `businesses[<origin>]` block — per-origin add/override.
4. `--header 'Name: Value'` (repeatable) — per-call (highest priority).

Higher source wins on header-name conflict (case-insensitive); non-conflicting headers from every source ship. Empty values unset for that scope. `${ENV_VAR}` interpolation in config values keeps secrets out of the file. Reserved framing headers (`Content-Type`, `Accept`, `Host`, `Connection`, hop-by-hop, `MCP-Protocol-Version`) are silently dropped from user sources. Sensitive header values (`Authorization`, `Cookie`, and any name ending in `-Token`, `-Key`, `-Secret`, `-Password`) are redacted in verbose traces.

One generic mechanism, no per-feature aliases. Bearer auth is just `--header 'Authorization: Bearer <token>'` — the same shape works for any merchant's chosen scheme without growing the CLI flag surface per auth pattern.

Outbound requests now includes `User-Agent` on every fetch: `tools/call`, `tools/list`, ..., discovery.
