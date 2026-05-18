# `@shopify/ucp-cli`

**A shopping skill for AI agents, powered by the [Universal Commerce Protocol](https://github.com/Shopify/ucp-spec).**

- **Search products across millions of merchants** via a unified global catalog
- **Build carts and complete checkouts** against any UCP-enabled merchant
- **Hand off gracefully** when escalation is requested
- **Track orders** after purchase

Designed agent-first. Structured JSON I/O on every command. Schema introspection on every operation (`--input-schema`), so the agent composes payloads from the merchant's advertised schemas instead of stale docs. Built-in escalation hooks, response shaping, and first-class knowledge of UCP best practices for presentation requirements, error handling, and more. Works with any agent that supports the [skills format](https://agentskills.io/).

## 60-second tour for carbon life forms

```sh
$> npm install -g @shopify/ucp-cli
$> ucp skills add
$> ucp profile init --name shopper
```
### 1. Find products

```sh
ucp catalog search \
  --set /query='keychron b1 pro' \
  --set /context/intent='looking for great mechanical keyboard' \
  --set /context/address_country=US \
  --view :compact \
  --format md
```

The query resolves against global catalog, searching across millions of merchants. `--view` projects the response (a [JMESPath](https://jmespath.org) expression — inline, `@<file>`, or package-local `:<alias>`); `--format md` renders the projection as a table:

| title | price | currency | variant | buy |
|---|---|---|---|---|
| Keychron B1 Pro Ultra-Slim Wireless Keyboard | 3999 | USD | gid://shopify/ProductVariant/41293818167385 | https://www.keychron.com/cart/41293818167385:1 |
| Keychron B1 Pro 75% Wireless Low Profile Keyboard | 3700 | USD | gid://shopify/ProductVariant/49158410436908 | https://mechanicalkeyboards.com/cart/49158410436908:1 |
| KEYCHRON B1 PRO WIRELESS KEYBOARD | 4600 | USD | gid://shopify/ProductVariant/50230394749266 | https://eloquentclicks.com/cart/50230394749266:1 |

Note: passing `--business <url>` scopes the search to that merchant — the CLI discovers the merchant's search endpoint and queries it directly. Omit `--business` to search the bundled global catalog (the default).

### 2. Add it to a cart at the chosen merchant

```sh
ucp cart create --business https://keytron.myshopify.com \
  --set /line_items/0/item/id='gid://shopify/ProductVariant/41293818167385' \
  --set /line_items/0/quantity=1 \
  --set /context/address_country=US \
  --view 'result.{id: id, items: length(line_items), currency: currency, continue_url: continue_url}'
```

The merchant returns a cart with confirmed pricing and `continue_url` that the buyer can optionally open to checkout. Want to add more items? Save and pass the returned `cart.id` to update the cart. For existing lines, `result.line_items[N].id` is the targetable line id; `result.line_items[N].item.id` is the underlying item/variant id. Net-new create lines do not have a line id yet — do not invent one.

Need a shipping-cost preview before checkout? Inspect `ucp cart update --input-schema`; if the merchant accepts fulfillment destinations on cart update, send the buyer destination there to get merchant-provided estimates. Use checkout for the complete shipping/pickup option map and final selectable options.

### 3. Convert to checkout, configure handoff, complete
Some checkouts require additional buyer input or review that the agent can't negotiate on the buyer's behalf. When the merchant returns an escalation status with a continue URL, configure a custom hook and the CLI will call it to handle the handoff. 

```sh
export UCP_ON_ESCALATION='jq -r .url | xargs open'   # macOS; xdg-open on Linux

# Convert the cart from step 2 into a checkout. For buy-now flows (no cart), pass line_items directly.
ucp checkout create --business https://keytron.myshopify.com \
  --input '{"cart_id":"<cart_id from step 2>","line_items":[]}' \
  --view 'result.{id: id, status: status}'

# … then `ucp checkout update <id>` for fulfillment address/selection. Cart can
# estimate shipping, but checkout returns the full-fidelity option map and final
# selectable shipping/pickup choices. Then `ucp checkout complete <id>`.
```

Multi-merchant flows are negotiated by passing relevant `--business` parameter for each call. 

_NOTE: Shopify-powered merchants support unauthenticated catalog access. Checkout requires a Catalog JWT — sign in to the Shopify Developer Dashboard to obtain one._

---

## Use with agents

After `ucp skills add`, your agent has the bundled `SKILL.md` — it teaches the agent how to find products and walk the buyer through the purchase journey against any UCP merchant. 


| Buyer asks... | Agent runs... |
|---|---|
| "Find me wireless headphones under $200" | `ucp catalog search` against the bundled global catalog (no merchant pinning needed) |
| "Buy this from store.example.com" | `ucp discover --business <url>` to confirm UCP support, then `cart create` / `checkout create` scoped to that merchant |
| "Where's my order?" | `ucp order get <order_id> --business <url>` |
| Anything mid-flow that the merchant requires the buyer to confirm | The configured escalation hook opens the buyer's browser to `result.continue_url`; the agent waits for the buyer to confirm, then resumes |

The skill packages the agent-facing operating model — when to search vs discover, how to compose payloads from the merchant's live schema, how to render totals correctly, how to surface required disclosures, when and how to hand off — in one curated [`skills/ucp/SKILL.md`](skills/ucp/SKILL.md) plus on-demand reference files.


## How it works

A **business** is a URL — `https://shop.example.com`. The CLI fetches the business's UCP profile (cached on disk per spec TTL), negotiates a compatible protocol version + transport, and dispatches operations against its endpoint. UCP CLI abstracts transport, service + capability negotiation, ..., and error handling.

Two scopes for picking which business an operation targets:

- **Global catalog (no `--business`)** — for product discovery across thousands of merchants. Each result names its merchant via `seller.domain`.
- **Per-merchant (`--business <url>`)** — for cart, checkout, order, or catalog operations scoped to a single merchant. 

**Live introspection so the agent never guesses.** Both `discover` and `--input-schema` make a real network call to the merchant; they're not static doc lookups. The schema you get back is whatever the merchant currently advertises — including extensions they've added since you last shopped there. Merchants stay in authoritative control of their own schemas; they can evolve, deprecate, or extend without coordinated releases against the CLI or the agent. Capability negotiation is real: the agent and merchant agree on what to use based on what's actually offered right now.

```sh
ucp discover --business https://<seller-domain>                         # what operations are offered
ucp catalog search --input-schema --business https://<seller-domain>    # exact shape this operation accepts
ucp cart update --input-schema --business https://<seller-domain>       # cart-stage shipping estimates, if supported
ucp checkout update --input-schema --business https://<seller-domain>   # full fulfillment option map/final fields
```

**Every response carries a `cta`.** The CLI is context-aware — it tracks where you are in the flow and surfaces the next-best step(s) as structured recommendations the agent should consider. Successful responses point forward (cart created → here are the checkout / refine / search-more commands); error responses point at recovery (schema validation failed → here's the `--input-schema` command to introspect first). The agent doesn't have to memorize the operating model; the CLI threads it through.

```sh
$ ucp cart create --business https://shop.example.com \
    --set /line_items/0/item/id='gid://shopify/ProductVariant/123' \
    --set /line_items/0/quantity=1 \
    --format json | jq '.cta'
{
  "description": "Cart saved. Ready to buy? Create a checkout from this cart by passing cart_id and line_items: [] in --input. Need shipping cost before checkout? Cart can provide merchant estimates when its schema accepts fulfillment destinations; use checkout for the complete option map.",
  "commands": [
    { "command": "ucp checkout create --business <business> --input '{\"cart_id\":\"<cart_id>\",\"line_items\":[]}'", "description": "convert this cart to a checkout" },
    { "command": "ucp cart update --input-schema --business <business>", "description": "inspect cart schema before requesting shipping estimates" },
    { "command": "ucp cart update <cart_id> --business <business> --input '...'", "description": "request cart-stage shipping estimates with fulfillment destinations" },
    { "command": "ucp catalog search ...", "description": "find more items — add them to this cart before proceeding" }
  ]
}
```

## Beyond the basics

### Composing operation calls

Three input surfaces — pick the right one for what you're providing:

- **Positional `<id>`** — for operations that address an existing resource: `cart get/update/cancel`, `checkout get/update/complete/cancel`, `order get`, `catalog get_product`. Pass the id as the first argument; it's not a body field, so don't duplicate it in `--input`/`--set`. Creating/searching operations (`cart create`, `checkout create`, `catalog search`, `catalog lookup`, `discover`) take no positional. Cart-to-checkout conversion is a normal `checkout create` body: pass `cart_id` in `--input` when the merchant's input schema advertises it.
- **`--input '<json>'`** — the operation body as a single JSON object. Also accepts `@path` (load from file) or `-` (read from stdin).
- **`--set <path>=<value>`** — overlay one body field at a [JSON Pointer (RFC 6901)](https://datatracker.ietf.org/doc/html/rfc6901) path. Numeric segments auto-create arrays (the cart example above); `-` as the final segment appends (`--set '/line_items/-=<json>'`). Repeatable. `--set-string` forces string interpretation for numeric-looking values like ZIP codes.

`--input` and `--set` mix freely: `--input '{...base...}' --set /context/address_country=US`. See [`skills/ucp/references/REFERENCE.md`](skills/ucp/references/REFERENCE.md) for the full `--set` syntax (escape rules, array indices, append, etc.). 

### Project responses before reasoning over them

UCP responses carry full product and negotiation details — variant trees, options, pricing, fulfillment shape, messages. Tailor and filter the response before passing it to your output formatter (or to an agent reasoning over it). One source response, many projections, no re-fetch required.

**Built-in: `--view <expr|@file|:alias>`.** A [JMESPath](https://jmespath.org) projection. The expression runs over the whole response envelope (`business`, `endpoint`, `transport`, `ucp`, `result`) and its output **replaces** the envelope, so the view has full control over the rendered shape. The `cta` survives the projection. `:<alias>` loads from the CLI package's `skills/ucp/views` directory for the current operation capability (`catalog search --view :summary` → `catalog.summary.jmespath`); `@file` loads a custom or edited view. Composes with `--format` (project first, render second), so `--view ... --format md` is one command from raw payload to a markdown table.

```sh
# Inline expression — reach into `result` from envelope root
ucp catalog search --set /query='running shoes' \
  --view 'result.products[*].{title: title, seller_domain: variants[0].seller.domain, seller_url: variants[0].seller.url, price: price_range.min.amount}'

# Package-local view alias — resolves inside the CLI package's skills/ucp/views;
# --format md gives a table
ucp catalog search --set /query='running shoes' \
  --view :summary \
  --format md
```

**JMESPath cheatsheet** for the patterns you'll reach for most (root is the envelope; reach into `result.<...>` for the operation payload):

| Pattern | Does |
|---|---|
| `field` / `a.b.c` | Pluck a field / nested path (`result.id`, `ucp.version`) |
| `[*]` / `a[*].b` | Project over every element of an array (`result.products[*].title`) |
| `` [?expr] `` | Filter — numeric literals need backticks (`` result.products[?price_range.min.amount<`5000`] ``) |
| `[N]` / `[N:M]` | Index / slice (`variants[0]`, `result.products[:5]`) |
| `sort_by(@, &expr)` | Sort by an expression (`sort_by(result.products, &price_range.min.amount)`) |
| `length(@)` | Count (`length(result.products)`) |
| `{a: x, b: y}` | Build a multi-key object (the projections above) |

Full spec at [jmespath.org](https://jmespath.org). `jq` and other tools (Python, Node, etc.) still work fine if you prefer — pipe the default JSON output into them. `--filter-output` remains for path-narrowing one field without an expression engine.

### Escalation hook recipes

The hook fires only when checkout `result.status === "requires_escalation"`; message severities such as `requires_buyer_input` / `requires_buyer_review` affect framing, not the firing condition. It receives a compact payload (`status`, `url`, `reason`, `business`, `operation`) as JSON on stdin. Auth-class errors such as `AUTH_REQUIRED` / `INSUFFICIENT_PERMISSIONS` do not fire the hook; they return structured error CTAs so the agent can hand the buyer off using the best URL it already has. Configure per-call with `--on-escalation '<cmd>'`, sticky across a shell session with `export UCP_ON_ESCALATION='<cmd>'`, or persistently via `~/.ucp/config.yaml` (`escalation.command`) or an executable `~/.ucp/hooks/escalation`. Resolution order: per-call flag wins, then env, then config, then hook file. The hook-file convention is POSIX-oriented; on Windows prefer a shell command via flag/env/config.

One-shot, interactive (browser open):

```sh
ucp checkout complete <id> --business https://<seller-domain> \
  --on-escalation 'jq -r .url | xargs open'
```

Sticky for the rest of your session (or for an agent that calls `ucp` many times):

```sh
# Browser open
export UCP_ON_ESCALATION='jq -r .url | xargs open'        # macOS
export UCP_ON_ESCALATION='jq -r .url | xargs xdg-open'    # Linux

# Generic webhook (Slack, Discord, internal alerting — pipe JSON to your endpoint)
export UCP_ON_ESCALATION='curl -sX POST -H "Content-Type: application/json" --data @- "$WEBHOOK_URL"'

# Browser open + macOS notification
export UCP_ON_ESCALATION='jq -r .url | tee >(xargs open) | xargs -I{} osascript -e "display notification \"Confirm checkout: {}\""'
```

### Preview before issuing mutations

```sh
ucp cart update <id> --business https://<seller-domain> \
  --input '{"line_items":[{"id":"<line_item_id>","item":{"id":"<variant_id>"},"quantity":2}]}' \
  --dry-run
```

Builds and validates the request, prints the exact payload that would hit the wire (including auto-injected `meta.idempotency-key` and `meta.ucp-agent`), skips the network call. Cart and checkout updates are full-replace: carry forward request-shaped line items, using `line_items[].id` only for existing lines and `line_items[].item.id` for the underlying item/variant. Useful for debugging payloads or confirming a mutation before issuing it.

### Environment variables

| Variable | Effect |
|---|---|
| `UCP_BUSINESS` | Default merchant URL when `--business` is omitted |
| `UCP_PROFILE` | Override which local profile is active |
| `UCP_ON_ESCALATION` | Shell command for the escalation hook (JSON payload on stdin) |
| `UCP_HOME` | Override the local state directory (default `~/.ucp`) |
| `UCP_VERBOSE` | Set `1`/`true` to print trace lines to stderr |


## Development

```sh
pnpm install       # install deps + activate husky hooks
pnpm build         # bundle to dist/
pnpm test          # unit tests
pnpm test:full     # unit + integration tests (builds first)
pnpm lint          # biome check
pnpm typecheck     # tsc --noEmit
```

Symlink globally for active dev:

```sh
pnpm build && pnpm link --global
# Now `ucp` everywhere points at this repo's dist/bin.js. Re-run pnpm build
# after changes; the symlink stays valid.
```

### Debug tracing

`--verbose` (or `UCP_VERBOSE=1`) prints discover/cache/transport trace lines to stderr. Useful when an operation silently no-ops, a cache hit looks stale, or the request that hit the wire doesn't match what you expected. The flag is muted under `--mcp` (stdio JSON-RPC has no human reader and trace lines would confuse log scrapers).

Not listed in `ucp --help`'s Global Options because incur 0.4.5 hard-codes that block with no extension hook — the flag is intercepted in the launcher before incur sees argv. Until upstream exposes a registration API, this is the canonical doc for it.
