# @shopify/ucp-cli

## 0.9.0

### Minor Changes

- cb59279: **A profile speaks exactly one UCP release, and the business must offer that release.**
  
  `ucp-cli` supports UCP **2026-04-08** and **2026-08-25**. This explicit set replaces the `2026-01-23`–`2026-08-25` range that `0.8.0` accepted; the profile selects which release it speaks when you create it:
  
  ```sh
  ucp profile init --name legacy --version 2026-04-08
  ucp discover shop.example.com --profile legacy
  ```
  
  Upgrading also raises the runtime floor to Node.js `22.19.0` (breaking change 7).
  
  ## Breaking changes
  
  1. **The selected profile's release must exactly match a version the business offers.** `0.8.0` accepted a business service entry anywhere in its `2026-01-23`–`2026-08-25` range. Now a `2026-08-25` profile against a business publishing only `2026-04-08` fails with `PROTOCOL_VERSION_INCOMPATIBLE` before any commerce operation is sent — and when another local profile speaks a version the business offers, the error names that profile. A business offering neither supported release (for example, only `2026-01-23`) can no longer negotiate at all.
  
     The match can also come through `supported_versions`: whenever the top-level `/.well-known/ucp` document is at any different version and its `supported_versions` entry links a document for your profile's release, `ucp-cli` fetches and validates that leaf. Extension-key validation follows the selected release: `2026-04-08` rejects hyphens and digit-leading reverse-domain segments; `2026-08-25` behavior is unchanged.
  
  2. **A profile's local `profile.json` controls negotiation, whether its profile URL is a release default or a URL you own.** Its `ucp.version`, services, and capabilities are what `ucp-cli` uses. Requests advertise the profile URL, the business reads the copy served there, and `ucp doctor` compares the two. If an operation reports `AGENT_PROFILE_SERVICE_UNDECLARED`, declare that service in `profile.json` and make the profile URL serve the corrected file — switching to a URL you own if the current one cannot change.
  
     Upgrading does not rewrite an existing `profile.json`, so a stock `0.8.0` file can report a non-failing `profile-drift` warning against the currently served document. `ucp profile init --name <name> --version <release> --force` replaces the file and discards local edits; pass `--profile-url` again when the URL is yours.
  
  3. **`ucp profile init` takes `--version <release>`; the removed `--protocol-min` / `--protocol-max` flags now fail as unknown flags.** A stale `meta.protocol_versions` field in existing profiles is tolerated but ignored.
  
     **`ucp profile publish` is removed** and invoking it fails as an unknown command. The `0.8.0` command never uploaded a document; publish `profile.json` through your hosting workflow.
  
  4. **Bare `ucp discover` negotiates only the services both your agent profile and the business document declare.** Business-only services stay visible in the returned `profile`, are not contacted, get no `negotiated` entry — and no longer fail a bare `ucp discover` merely because they cannot negotiate. Explicitly requesting an undeclared service still raises `AGENT_PROFILE_SERVICE_UNDECLARED`.
  
     Output gains `protocol` — fields `version`, `source` (`well-known` or `supported_versions`), and `businessProfileUrl` — plus `expectedCapabilities`, the intersection of agent profile and business declarations. `expectedCapabilities` is advisory; each response's `ucp.capabilities` remains authoritative.
  
  5. **`ucp doctor` exits 1 when any check fails; warnings alone exit 0.** `--skip-network` skips exactly four checks: `protocol`, `profile-redirect`, `profile-drift`, and `profile-cache-control`.
  
     Those four replace `0.8.0`'s `profile-url` check id — update scripts that match check ids. An unreachable profile URL or a version disagreement is a failure; non-version document drift and cache-control issues are warnings.
  
  6. **`ucp --version` prints `ucp <cli-version> (UCP 2026-04-08, 2026-08-25)`** instead of `0.8.0`'s bare semver. Update scripts to read `<cli-version>` from the second field.
  
  7. **Node.js `22.19.0` or later is required.** npm's default behavior reports the `engines` mismatch as an `EBADENGINE` warning and completes the install, so a successful install is not proof of compatibility.
  
     `ucp doctor`'s `runtime` check now compares the full `major.minor.patch` and fails below the floor; `0.8.0` compared the major version only. Upgrade Node before invoking the CLI.
  
  8. **Redirect responses are refused: UCP requires profile, identity, and schema documents to be served directly, with no redirect to follow.** `ucp-cli` refuses `301`, `302`, `303`, `307`, and `308` on every outbound UCP fetch, and applies the same policy to negotiated service endpoints, so the endpoint it calls is the endpoint the business document declares.
  
     Direct refusals raise `TRANSPORT_REDIRECT_REFUSED`, naming the status and the refused `Location`. A redirecting agent profile URL surfaces in `ucp doctor` as a single failing `profile-redirect` check. Serve documents directly and put each final HTTPS URL in the declaration that names it.
  
  ## Error codes
  
  Eight codes are added relative to `0.8.0`, and none are removed: `AGENT_PROFILE_SCHEMA_INVALID`, `AGENT_PROFILE_SERVICE_UNDECLARED`, `AGENT_PROFILE_UNREACHABLE`, `AGENT_PROFILE_VERSION_MISMATCH`, `AGENT_PROFILE_VERSION_UNSUPPORTED`, `PROFILE_VERSION_MISMATCH`, `SERVICE_VERSION_INCOMPATIBLE`, and `TRANSPORT_REDIRECT_REFUSED`.
  
  Within this added set, the `AGENT_PROFILE_*` codes identify your agent document — the one your requests advertise. `PROFILE_VERSION_MISMATCH` identifies the business document. `SERVICE_VERSION_INCOMPATIBLE` means the two sides' service declarations share no common version. `TRANSPORT_REDIRECT_REFUSED` is a redirect refused directly at the transport (breaking change 8).

## 0.8.0

### Minor Changes

- fa28179: Support UCP 2026-08-25.
  
  Shopify storefronts and `catalog.shopify.com` now publish UCP 2026-08-25. With `protocolMax` pinned to 2026-04-08, `ucp discover`, `cart`, and `checkout` against any Shopify storefront failed with `NO_COMPATIBLE_TRANSPORT` (the only in-range entry was the embedded one), and `ucp catalog search` failed with `PROTOCOL_VERSION_INCOMPATIBLE` (#48).
  
  - Negotiation range is now 2026-01-23 through 2026-08-25; the default agent profile URL and the local `profile init` template move to the 2026-08-25 spec (spec/schema URLs, `signing_keys[]` -> `keys[]`).
  - Generated profile schemas regenerated from 2026-08-25 (`keys[]`, `map_order`, widened reverse-domain identifiers); the codegen script follows the spec's new `schemas/profile.json` entry point.

## 0.7.0

### Minor Changes

- 3ef5367: Honor standard proxy environment variables. When `HTTPS_PROXY`/`https_proxy`/`HTTP_PROXY`/`http_proxy` is set, the CLI routes requests through the proxy (respecting `NO_PROXY`) instead of silently ignoring it and stalling until the request timeout. Adds a `proxy` check to `ucp doctor`, a `--verbose` trace line, and names the proxy in transport, HTTP, and invalid-body error messages so a proxy failure can't be misread as an unreachable merchant. Credentials are redacted everywhere. Implemented via undici's `EnvHttpProxyAgent`, loaded only when a proxy variable is set.

### Patch Changes

- 2d93b97: Restore the per-command MCP tool surface (`catalog_search`, `cart_create`, ...). a later incur 0.4.x release flipped its MCP tool discovery default to 'progressive', which replaced this CLI's published tools with four search/inspect/execute meta-tools on any fresh install resolving a newer incur. Tool discovery is now pinned to 'direct' and covered by an integration test, and the locked incur is aligned with what fresh installs resolve (0.4.26).

## 0.6.3

### Patch Changes

- cc166b2: Correct and clarify the bundled UCP agent skill's Shopify Global Catalog guidance:

  - **Seller identity**: match a buyer-named brand or first-party store on `seller.url` (the buyer-facing storefront); `seller.domain` is the permanent handle for addressing the API (`--business`), not a brand signal.
  - **Checkout**: `eligible.native_checkout` indicates whether a checkout can be _finalized_ in-protocol — `false` still supports building and negotiating a cart/checkout in-protocol, with finalizing handled via escalation (`continue_url`); it is not a redirect-only dead end.
  - **Currency**: prices are returned in each seller's market presentment currency (keyed off `context.address_country`), so a result set can span multiple currencies — read `price_range.min.currency` per item.
  - **get_product**: copy `selected` option names/labels verbatim from the response's `options[]`; `options` may be `null` (no variant picker — use the featured variant or hand off to the product `url`).
  - **filters.attributes**: names/values come from the Shopify Standard Product Taxonomy (category-specific; canonical name or GID), with a pointer to the public taxonomy.

  Also consolidates the duplicated response-field documentation into `references/CATALOG.md`.

## 0.6.2

### Patch Changes

- 72a84f3: Point the baked-in default agent profile URL at the canonical shopify.dev
  version (`/ucp/agent-profiles/2026-04-08/valid-with-capabilities.json`).
- d18c3ed: Expand the bundled UCP agent skill with a dedicated Shopify Global Catalog reference, including search, lookup/re-pricing, PDP variant selection, multimodal search, single-shop filtering, auth tiers, ID formats, and Catalog-specific recovery guidance.

## 0.6.1

### Patch Changes

- 7d048b9: Fix `MCP_INVALID_RESPONSE` errors on every dispatch against businesses that
  publish JSON Schema draft 2020-12 inputSchemas, and make client-side
  pre-flight validation best-effort instead of fail-closed.

  The pre-flight input validator previously used AJV's draft-07-only build and
  threw on the 2020-12 meta-schema URI (`https://json-schema.org/draft/2020-12/schema`)
  before inspecting any payload. Every `catalog search`, `cart create`,
  `checkout *`, and `order *` call against MCP servers that advertise the
  2020-12 dialect returned:

  ```
  MCP_INVALID_RESPONSE: business returned an invalid input schema for "<tool>"
  Details: no schema with key or ref "https://json-schema.org/draft/2020-12/schema"
  ```

  Three changes:

  1. **2020-12 dialect support.** The validator now uses AJV's 2020-12 build
     (`Ajv2020`), which registers the 2020-12 meta-schema. Schemas declaring
     2020-12 — or no `$schema` at all — compile and validate normally.

  2. **Soft signals replace hard throws for client-side uncertainty.** When
     the published schema cannot be compiled (unknown dialect, malformed JSON
     Schema) or when an argument carries a plain key not listed in the
     published schema, the dispatcher no longer fails the call. The server is
     the authoritative validator and returns `SCHEMA_VALIDATION_FAILED` for
     genuinely bad payloads. Three modes:

     - **default** — silent; the request proceeds and the server decides.
     - **`--verbose` / `UCP_VERBOSE=1`** — emit a `vlog()` trace so operators
       can see what was flagged and why.
     - **`UCP_STRICT_SCHEMA=1`** — restore the throw (`MCP_INVALID_RESPONSE`
       for compile failures, `SCHEMA_VALIDATION_FAILED` for unknown plain
       keys). Useful in CI or for paranoid local development.

     Payload validation against a successfully compiled schema still throws
     `SCHEMA_VALIDATION_FAILED` in every mode — local typo-catching saves a
     server round-trip.

  3. **Removed `patchKnownUpstreamSchemaDefects` (the `\A` regex stopgap).**
     The upstream defect it worked around is fixed in production, and the
     new soft-fail path handles any future regex-incompatibility regression
     without a hard failure.

  Upgrade impact:

  - Agents and scripts that previously branched on `MCP_INVALID_RESPONSE` from
    the pre-flight path will no longer see it in the default mode. Set
    `UCP_STRICT_SCHEMA=1` to restore the old strict behavior.
  - The previous client-side rejection of "unknown plain fields" no longer
    fires by default. Reverse-DNS extension keys remain the recommended
    convention; the CLI just doesn't enforce it client-side anymore.
  - No new error codes.

## 0.6.0

### Minor Changes

- 917c375: Custom HTTP headers on UCP requests, with a built-in User-Agent default.

  Adds a four-source resolver merged into a single header bag per dispatch:

  1. CLI built-in: `User-Agent: @shopify/ucp-cli/<version>` (lowest priority — identifies CLI traffic in merchant logs / WAFs).
  2. `~/.ucp/profiles/<name>/headers.json` `default` block — apply to every request.
  3. `~/.ucp/profiles/<name>/headers.json` `businesses[<origin>]` block — per-origin add/override.
  4. `--header 'Name: Value'` (repeatable) — per-call (highest priority).

  Higher source wins on header-name conflict (case-insensitive); non-conflicting headers from every source ship. Empty values unset for that scope. `${ENV_VAR}` interpolation in config values keeps secrets out of the file. Reserved framing headers (`Content-Type`, `Accept`, `Host`, `Connection`, hop-by-hop, `MCP-Protocol-Version`) are silently dropped from user sources. Sensitive header values (`Authorization`, `Cookie`, and any name ending in `-Token`, `-Key`, `-Secret`, `-Password`) are redacted in verbose traces.

  One generic mechanism, no per-feature aliases. Bearer auth is just `--header 'Authorization: Bearer <token>'` — the same shape works for any merchant's chosen scheme without growing the CLI flag surface per auth pattern.

  Outbound requests now includes `User-Agent` on every fetch: `tools/call`, `tools/list`, ..., discovery.

## 0.5.0

### Minor Changes

- 4c2c387: Drop the `~/.ucp/hooks/escalation` file-source for escalation hooks. The escalation hook contract is now three sources — `--on-escalation` flag, `UCP_ON_ESCALATION` env, `~/.ucp/config.yaml` `escalation.command` — all shell command strings, identical on every OS.

  The file convention duplicated config-source ("put your command in a file" vs "point config at a file"), had no meaningful `X_OK` semantics on Windows, and forced platform asymmetry users had to learn around. To run an existing script, point config at it directly:

  ```yaml
  # POSIX
  escalation:
    command: '/path/to/escalation.sh'

  # Windows
  escalation:
    command: 'powershell -NoProfile -File C:\path\escalation.ps1'
  ```

## 0.4.3

### Patch Changes

- f720ae7: Fix the installed package bin so package-manager symlinks run the CLI instead of exiting 0 with no output.
