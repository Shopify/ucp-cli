---
"@shopify/ucp-cli": minor
---

Add `ucp permalink build` (MCP: `permalink_build`, annotated read-only) for the UCP 2026-08-25 `dev.ucp.shopping.permalink` capability: build a browser link that opens a business's cart with items, quantities, discount codes, context, and attribution already applied.

- Takes the same body as `cart create`. `line_items` become the compact item path (ids outside `[A-Za-z0-9._-]`, such as Shopify GIDs, are encoded as `~` + base64url); every other field becomes a JSON Pointer query parameter, the same paths `--set` uses. `--continue-to` sets the spec's same-origin landing path; `--view` projects the result like any operation.
- The link is built locally from the business profile's `config.endpoint`, and no request is ever made to the link. Opening it makes the business build a cart and redirect; it never places an order.
- Field check: businesses silently drop permalink fields they don't recognize, so the body is checked against the business's `create_cart` schema when it can be discovered; misses are listed in `result.unrecognized_fields` and the CTA says to fix them before sharing. The check is best-effort and never fails the command.
- Client-side refusals (`INVALID_INPUT`): payment instruments and credentials (only a `context/payment/<n>/handler` preference is allowed), tokens/secrets/API keys anywhere in the path, and server-owned fields such as `id`, `totals`, and `status`. `buyer/*` prefill requires `--allow-buyer-prefill`, for links sent directly to that buyer.
- `result.fits` reports which spec URL budgets the link meets (QR 512, SMS 1024, email 2048 octets); the CTA frames the link as a handoff, warns on buyer prefill and budget overruns, and offers in-protocol `cart create` as the alternative.
- `CAPABILITY_NOT_OFFERED` when the business doesn't advertise the capability at the negotiated release; `PROFILE_SCHEMA_INVALID` when its advertised endpoint breaks the spec pattern.
