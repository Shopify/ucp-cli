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

A profile is two halves with one contract between them:

- **`profile.json`** is the document `ucp-cli` declares. Its `ucp.version` is the release you speak; its services and capabilities are what you offer to negotiate. Every request is built from this file.
- **`meta.profile_url`** is where that document lives on the web. It is sent as `meta.ucp-agent.profile` on every call, and the **merchant** fetches it and negotiates against whatever it serves.

**The two must say the same thing**, and keeping them equal is your job — `ucp doctor` is what checks (`protocol` fails while they disagree on `ucp.version` or the URL cannot be read; `profile-drift` warns while anything else differs). `profile init` starts them in agreement: it writes the release's published document to disk — exactly what the default URL serves, and exactly what you upload when the URL is yours.

So an edit to `profile.json` takes effect immediately in what `ucp-cli` sends — and becomes real to merchants only once the URL serves it too. On the default URL you cannot change what is served, so an edit there is a disagreement `ucp doctor` will report. Point the profile at a URL you control before editing.

### Advertising a capability set of your own

```sh
ucp profile init --name mine --profile-url https://you.example/agent.json
# edit ~/.ucp/profiles/mine/profile.json (add com.acme.*, drop what you don't drive)
# upload it to that URL yourself — scp, S3, whatever you host with
#   serve it as Content-Type: application/json, Cache-Control: public, max-age>=60
ucp doctor       # confirms the two agree
```

Nothing is signed, so **whoever controls that URL controls what this agent claims.** If it stops resolving, merchants that cannot fetch it report `AGENT_PROFILE_UNREACHABLE`.

`ucp profile init --name <name> --version <v> --force` is the only command that rewrites `profile.json`; upgrading `ucp-cli` does not, so what you declare survives upgrades untouched.

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
| `AGENT_PROFILE_UNREACHABLE` | At request time this means one thing: **the merchant** could not fetch your profile URL and said so (`business_reported`). `ucp doctor` raises the same code for what it finds itself — `network`, `http_status`, `not_json` (a 200 serving an HTML error page — the most common hosting mistake), `redirect` (the URL answers a redirect, which UCP forbids on profiles) | Fix hosting at that URL, or point at a reachable one with `--profile-url`. `ucp doctor` probes it |
| `AGENT_PROFILE_VERSION_UNSUPPORTED` | The profile document declares a UCP version `ucp-cli` does not support | `ucp profile init --name <name> --version <v>` at a supported version (`ucp --version` prints them), or upgrade the CLI |
| `AGENT_PROFILE_SCHEMA_INVALID` | The profile document failed its release's schema | Fix `profile.json` (and upload it to your profile URL if that URL is yours) |
| `AGENT_PROFILE_VERSION_MISMATCH` | The profile document is internally inconsistent: a `dev.ucp.*` entry at a version other than its own `ucp.version`. Those entries can never negotiate, so this is fatal before the first call | Align the entry versions with the profile's `ucp.version` in `profile.json`, then make the profile URL serve the corrected document (`ucp profile show`, `ucp doctor`) |
| `AGENT_PROFILE_SERVICE_UNDECLARED` | The merchant offers a service your profile does not declare, so there is no platform side to negotiate. `message` lists both `declared:` and `business offers:` | Add the service to `profile.json` and make the profile URL serve the corrected document; if you cannot change that URL, use one you own (`ucp profile show`, `ucp doctor`) |
| `SERVICE_VERSION_INCOMPATIBLE` | The merchant offers the negotiated protocol version, but a requested service's own version line does not intersect what your profile declares (third-party services version independently) | Update the service declaration in `profile.json` to a version the merchant offers, then make the profile URL serve the corrected document; if you cannot change that URL, use one you own. Otherwise, accept unavailability (`ucp profile show`, `ucp doctor`) |

## Doctor

`ucp doctor` is the **only** thing in the CLI that fetches your profile URL. It runs a battery of local + network checks: runtime version, writable state directories, `active.yaml`, the active profile parsing, proxy configuration, plus the hosted-identity checks:

| Check | Answers |
|---|---|
| `protocol` | can this URL be used as an identity, and does it serve the release you send? Reports the version in force, whether `ucp-cli` supports it, whether it is the latest, and the resolved URL. **Fails** when the URL cannot be fetched or used (transport failure / HTTP status / non-JSON / schema-invalid / a UCP version `ucp-cli` does not support — the merchant fetches the same URL, so this predicts total failure), **and when the `ucp.version` it serves differs from the one in your `profile.json`**, which is what `ucp-cli` sends. That last one is the check that keeps both sides speaking the same release; its message names both versions |
| `profile-drift` | the versions agree — does the rest of the served document match `profile.json`? **Warn**: your requests stay well-formed, but the merchant grants capabilities off the document at the URL while `ucp-cli` plans against your file, so the two disagree about what you can do |
| `profile-redirect` | does the profile URL serve the document itself, without a hop? UCP forbids redirects (3xx) on published profiles. `ucp doctor` is the only part of `ucp-cli` that fetches this URL, and it refuses the hop itself; your commerce requests only advertise the URL, and a conforming merchant dereferencing it is bound by the same rule — so it cannot resolve your identity and those requests cannot negotiate (local commands like `ucp profile list` are unaffected). **Fail**, and the detail names the `Location` plus both fixes: serve the document at the URL you advertise, or advertise the URL that serves it |
| `profile-cache-control` | does the document at the profile URL carry `Cache-Control: public, max-age>=60`, as UCP's hosting rules require? **Warn** only — merchants fetch this URL per request, and `no-store`/missing/short policies just make them refetch it every time |

Only `fail` gates the verdict (`ok: false`, exit 1). A `warn` never does — read the `checks` array when you want it.

An older-but-supported release (e.g. 2026-04-08 while 2026-08-25 is latest) is `ok`, not a warning: `ucp-cli` supports a set of releases, not a minimum. A deliberately pinned profile — `meta.profile_url` set to a release's published URL, `profile.json` matching — stays green.

`ucp doctor` **exits 1 when any check is `fail`** (verdict `ok: false`), so it can gate CI; the same JSON is printed either way. Since `protocol` fetches the network, transient network trouble can fail a build — use `--skip-network` for offline or flaky-network jobs.

```sh
ucp doctor                   # full check; exit 1 when ok:false
ucp doctor --skip-network    # local-only (CI, offline); omits every hosted-identity check
```

The `--help` output is authoritative for current check coverage.

