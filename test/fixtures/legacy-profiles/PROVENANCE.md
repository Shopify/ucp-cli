# Legacy `profile.json` fixtures

Frozen copies of every body `ucp profile init` has ever generated in a build
that predates the managed/DIY split. `src/core/legacy-profile.ts` recognizes
them by sha256 over canonical JSON; `src/core/legacy-profile.test.ts` re-derives
those digests from these files, so the table and the fixtures cannot drift
apart silently.

Bytes are exactly what the old `saveUserProfile` wrote:
`JSON.stringify(body, null, 2) + "\n"`.

## How these were derived

Historical `profile init` did `const body = localAgentProfileBody()` — a source
literal in `src/core/profile.ts` interpolated with tsup build defines
(`__PROTOCOL_MAX__`, `__SPEC_VERSION__`, from `package.json#ucp`). Each fixture
was produced by extracting that function at the named git ref, evaluating it
with that ref's own `package.json` defines, and serializing as above.

Every commit reachable from `main`, plus each release tag, was evaluated this
way. The complete set of distinct results for pre-split builds is the three
files below.

Published npm versions of `@shopify/ucp-cli` (registry.npmjs.org, verified):
`0.4.2, 0.4.3, 0.5.0, 0.6.0, 0.6.1, 0.6.2, 0.6.3, 0.7.0, 0.8.0`.

| file | id | git ref | shipped in | sha256 (canonical JSON) |
| --- | --- | --- | --- | --- |
| `profile-0.4.2-to-0.7.0.json` | ucp-cli 0.4.2–0.7.0 | `v0.7.0:src/core/profile.ts` | npm 0.4.2 … 0.7.0 (identical body in all nine builds of that range) | `508d145091f0efb805aacd7b21bc738b3dfa108c7b1d59748c66c00fe391b3cd` |
| `profile-0.8.0.json` | ucp-cli 0.8.0 | `v0.8.0:src/core/profile.ts` | npm 0.8.0 | `3a75f9cf8e416ecbc716c303b6356dc1c9f6dce702f419654460eda0bf692ff5` |
| `profile-prepublic-0.1.x.json` | pre-publication 0.1.x | `89f0074:src/core/profile.ts` (branch `local/init-history`) | never published; dev builds of the internal 0.1.x tree | `c928a7ed8d841f2da6571203845c8cb87d42c7d94fac28d48b39a65073e55c76` |

Notes on each:

- **ucp-cli 0.4.2–0.7.0 Profile** declares `dev.ucp.shopping` at UCP
  `2026-01-23` inside a `2026-04-08` profile. Untouched copies upgrade to the
  managed Profile. For edited DIY copies, `createDiyProfile` recognizes only
  that complete published service entry and changes its version to
  `2026-04-08` in a runtime clone; the fixture and the user's source bytes
  remain unchanged. Strict hosted validation does not apply this local
  normalization.
- **ucp-cli 0.8.0 Profile** is snapshot-clean and loads directly; it upgrades
  for reach (managed offers both installed releases), not for repair.
- **Pre-publication 0.1.x Profile** differs from the ucp-cli 0.4.2–0.7.0
  Profile by exactly one field: an
  `endpoint: "https://example.invalid/agent/no-endpoint"` on the
  `dev.ucp.shopping` service entry. It predates the OSS release and reached no
  npm user, but the repo was internal through 0.4.1 and dev builds of that tree
  wrote this document. Its untouched fingerprint safely upgrades to managed:
  the endpoint is unusable and a hand-authored document cannot plausibly
  collide with the full canonical fingerprint. Its extra endpoint deliberately
  excludes an edited or explicitly DIY pre-publication document from the
  runtime matcher.

## Current templates are NOT frozen here

`src/core/releases.ts` already carries the current per-release published
documents (`agentProfileJson`, byte-verbatim, CI drift-gated). The classifier
hashes those at load instead of duplicating them, so `pnpm gen:schemas` cannot
turn a freshly-initialized profile into "user-authored".

## What ships

Nothing. `package.json#files` publishes `dist`, `README.md`, `skills`, and
`src` minus tests; `test/` is not included.
