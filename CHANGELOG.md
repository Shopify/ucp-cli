# @shopify/ucp-cli

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
