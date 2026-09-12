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
| `stock-a-2026-04-08.json` | STOCK-A | `v0.7.0:src/core/profile.ts` | npm 0.4.2 … 0.7.0 (identical body in all nine builds of that range) | `508d145091f0efb805aacd7b21bc738b3dfa108c7b1d59748c66c00fe391b3cd` |
| `stock-b-2026-08-25.json` | STOCK-B | `v0.8.0:src/core/profile.ts` | npm 0.8.0 | `3a75f9cf8e416ecbc716c303b6356dc1c9f6dce702f419654460eda0bf692ff5` |
| `stock-a0-prerelease-2026-04-08.json` | STOCK-A0 | `89f0074:src/core/profile.ts` (branch `local/init-history`) | never published; dev builds of the internal 0.1.x tree | `c928a7ed8d841f2da6571203845c8cb87d42c7d94fac28d48b39a65073e55c76` |

Notes on each:

- **STOCK-A** declares `dev.ucp.shopping` at UCP `2026-01-23` inside a
  `2026-04-08` profile. Today's `loadAgentProfile` snapshot rule rejects that
  with `AGENT_PROFILE_VERSION_MISMATCH`, so without the upgrade every profile
  created by 0.4.2 … 0.7.0 fails at dispatch. This is the case the migration
  exists for.
- **STOCK-B** is snapshot-clean and loads today; it upgrades for reach
  (managed offers both installed releases), not for repair.
- **STOCK-A0** differs from STOCK-A by exactly one field — an
  `endpoint: "https://example.invalid/agent/no-endpoint"` on the
  `dev.ucp.shopping` service entry. It predates the OSS release and reached no
  npm user, but the repo was internal through 0.4.1 and dev builds of that tree
  wrote this document. Recognized deliberately: as a DIY declaration it is
  useless (it pins an unreachable endpoint), and no hand-authored profile is
  going to collide with it byte-for-byte.

## Current templates are NOT frozen here

`src/core/releases.ts` already carries the current per-release published
documents (`agentProfileJson`, byte-verbatim, CI drift-gated). The classifier
hashes those at load instead of duplicating them, so `pnpm gen:schemas` cannot
turn a freshly-initialized profile into "user-authored".

## What ships

Nothing. `package.json#files` publishes `dist`, `README.md`, `skills`, and
`src` minus tests; `test/` is not included.
