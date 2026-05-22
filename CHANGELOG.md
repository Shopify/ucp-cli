# @shopify/ucp-cli

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
