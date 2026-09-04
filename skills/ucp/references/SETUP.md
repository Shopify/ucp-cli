# UCP CLI — Setup reference

One-time machine wiring — install path, profile init, health check. Read once during initial setup. (Escalation hook configuration lives in the main SKILL.md alongside the escalation flow it gates, since it's part of normal operation, not just one-time setup.)

## Install

The CLI ships as `@shopify/ucp-cli` on npm. Two practical install paths:

```sh
# Ephemeral (no global install — fetched per invocation):
npx @shopify/ucp-cli <command>
bunx @shopify/ucp-cli <command>
pnpm dlx @shopify/ucp-cli <command>

# Project-scoped (added to a package.json):
pnpm add -D @shopify/ucp-cli
npm install --save-dev @shopify/ucp-cli
# Then invoke via `npx ucp <command>` or `pnpm ucp <command>` from the project.

# Global install (less common; one-shot for the user's whole shell):
npm install -g @shopify/ucp-cli
# Then invoke as bare `ucp <command>`.
```

The rest of this guide and the main SKILL.md write `ucp <command>` as shorthand for whichever invocation form is in use. Substitute `npx @shopify/ucp-cli` (etc.) when calling from an environment without a globally-installed binary.

## Profile init

A local agent profile is required for any UCP operation, including the bundled global catalog (`catalog search/lookup/get_product`). Run `ucp profile init --name <name>` once before issuing any UCP command. The init is idempotent (no-op if the profile already exists, exit 0), so call it unconditionally at the start of a session rather than tracking state.

```sh
# Idempotent; safe to run unconditionally. No-op if a profile with this name already exists.
ucp profile init --name <name>

# Optional: verify install + active profile. Exits 1 if any check is `fail`
# (see Doctor below) — read the `checks` array before treating that as fatal.
ucp doctor
```

The init writes `profile.json` + `meta.json` under `~/.ucp/profiles/<name>/` and sets the profile active in `~/.ucp/active.yaml`.

### The profile decides the protocol version

`ucp --version` prints the CLI version and the UCP releases it supports:

```sh
ucp --version     # ucp 0.7.0 (UCP 2026-04-08, 2026-08-25)
```

Which release you speak is set by the active profile:

```sh
ucp profile init --name agent                              # the latest supported release (default)
ucp profile init --name legacy --version 2026-04-08        # create a profile pinned to an older release
ucp discover shop.example.com --profile legacy             # ...and use it
```

An unsupported value is rejected and the message lists the supported set. Switch versions by switching profiles — `--profile <name>` per call, or `ucp profile use <name>`; no reinstall.

`meta.profile_url` is the identity: it is sent as `meta.ucp-agent.profile` on every call, and the **merchant** fetches it. `profile.json` is your local copy of what should be at that URL — keeping the two in sync is your responsibility, and `ucp doctor` checks it (`protocol` fails while they disagree on `ucp.version`; `profile-drift` warns while the hosted copy is otherwise stale).

On the default URL the document is Shopify's, so the identity is "a stock \<version\> agent" and **editing your local copy changes nothing merchants can see.**

### Hosting the profile yourself (the only way to advertise a custom capability set)

```sh
ucp profile init --name mine --profile-url https://you.example/agent.json
# edit ~/.ucp/profiles/mine/profile.json (add com.acme.*, drop what you don't drive)
# upload it to that URL yourself — scp, S3, whatever you host with
#   serve it as Content-Type: application/json, Cache-Control: public, max-age>=60
ucp doctor       # verifies the two agree: `protocol` fails while the hosted copy
                 # disagrees on `ucp.version`; `profile-drift` warns while it is
                 # otherwise stale
```

Nothing is signed, so **whoever controls that URL controls what this agent claims.** If it stops resolving, merchants that cannot fetch it report `AGENT_PROFILE_UNREACHABLE`.

To pin a default catalog URL for the profile:

```sh
ucp profile init --name <name> --catalog https://my-catalog.example.com
```

## Profile management

```sh
ucp profile list            # list configured profiles
ucp profile show <name>     # dump full profile body (capabilities, payment handlers, etc.)
```

The active profile is stored in `~/.ucp/active.yaml`. To switch:

```sh
ucp use <business-url>      # set session-default merchant for subsequent calls
ucp use --clear             # drop the session merchant
```

## Profile errors

Every code below means **your side is misconfigured**, and none of them are the merchant's fault — the merchant fetches your `meta.profile_url` on every call, so it fails the same way. Retrying does not help; fix the document, then re-run. `ucp doctor` diagnoses all of them.

These are operator fixes, which is why `references/REFERENCE.md` collapses the whole family into a single "stop and report" row: an agent mid-task cannot re-host a document or upload a new copy of it.

| Code | Meaning | Fix |
|---|---|---|
| `AGENT_PROFILE_UNREACHABLE` | At request time this means one thing: **the merchant** could not fetch your profile URL and said so (`business_reported`). `ucp doctor` raises the same code for what it finds itself — `network`, `http_status`, `not_json` (a 200 serving an HTML error page — the most common self-hosting mistake) | Fix hosting at that URL, or point at a reachable one with `--profile-url`. `ucp doctor` probes it |
| `AGENT_PROFILE_VERSION_UNSUPPORTED` | The profile document declares a UCP version `ucp-cli` does not support | `ucp profile init --name <name> --version <v>` at a supported version (`ucp --version` prints them), or upgrade the CLI |
| `AGENT_PROFILE_SCHEMA_INVALID` | The profile document failed its release's schema | Fix `profile.json` (and upload it to your profile URL if that URL is yours) |
| `AGENT_PROFILE_VERSION_MISMATCH` | The profile document is internally inconsistent: a `dev.ucp.*` entry at a version other than its own `ucp.version`. Fatal only for self-hosted URLs — on a published default the CLI warns and proceeds | Align the entry versions with the profile's `ucp.version`, then upload the corrected document to your profile URL (`ucp profile show`, `ucp doctor`) |
| `AGENT_PROFILE_SERVICE_UNDECLARED` | The merchant offers a service your profile does not declare, so there is no platform side to negotiate. `message` lists both `declared:` and `business offers:` | Add the service to your profile and upload it to your profile URL (`ucp profile show`) |
| `SERVICE_VERSION_INCOMPATIBLE` | The merchant offers the negotiated protocol version, but a requested service's own version line does not intersect what your profile declares (third-party services version independently) | If the profile is yours: update its declared version for that service and upload the corrected document to your URL. If `message` says **"the published agent profile at … is not something you can edit"**, the defect is in a platform-published document — host a corrected copy at a URL you own (`ucp profile init --profile-url <your-url>`) or accept unavailability |

## Doctor

`ucp doctor` is the **only** thing in the CLI that fetches your profile URL. It runs a battery of local + network checks: runtime version, writable state directories, `active.yaml`, the active profile parsing, proxy configuration, plus the hosted-identity checks:

| Check | Answers |
|---|---|
| `protocol` | can this URL be used as an identity, and does what it serves agree with the document `ucp-cli` negotiates from? Reports the version in force, whether `ucp-cli` supports it, whether it is the latest, and the resolved URL. **Fails** when the URL cannot be fetched or parsed (transport failure / HTTP status / non-JSON or schema-invalid body — the merchant fetches the same URL, so this predicts total failure), **and when its `ucp.version` differs from the one the CLI will actually send with** — the snapshot on a release default, your `profile.json` when self-hosted. That last one is the check that keeps both sides speaking the same release; its message names both versions |
| `profile-drift` | does your local authoring copy match what your URL publishes? On a published default URL the local copy is decorative (informational), and a `ucp.version` difference there **warns**: the CLI negotiates the published release, so your edits are invisible to merchants. When the URL is yours, a structural difference **warns** — "the hosted copy is stale, upload yours" |
| `profile-cache-control` | self-hosted URLs only: does the document you serve carry `Cache-Control: public, max-age>=60`, as UCP's hosting rules require? **Warn** only — merchants fetch this URL per request, and `no-store`/missing/short policies just make them refetch it every time |

An older-but-supported release (e.g. 2026-04-08 while 2026-08-25 is latest) is `ok`, not a warning: `ucp-cli` supports a set of releases, not a minimum. A deliberately pinned profile — `meta.profile_url` set to a release's published URL, local copy matching — stays green.

`ucp doctor` **exits 1 when any check is `fail`** (verdict `ok: false`), so it can gate CI; the same JSON is printed either way. Since `protocol` fetches the network, transient network trouble can fail a build — use `--skip-network` for offline or flaky-network jobs.

```sh
ucp doctor                   # full check; exit 1 when ok:false
ucp doctor --skip-network    # local-only (CI, offline); omits the three hosted-identity checks
```

The `--help` output is authoritative for current check coverage.

