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

A local agent profile is required before any UCP operation that contacts a merchant. The bundled global catalog still works for `catalog search/lookup/get_product` against a default profile, but state-mutating ops (cart/checkout/order) require an initialized profile.

```sh
# Health-check first; if active-profile is missing, init.
ucp doctor

# Idempotent: no-op if a profile with this name already exists.
ucp profile init --name <name>

# Re-verify.
ucp doctor
```

The init writes a small JSON file under `~/.ucp/profiles/<name>/` and sets it active in `~/.ucp/active.yaml`. To self-host the agent profile (advanced; for callers serving their own `.well-known/ucp`):

```sh
ucp profile init --name <name> --profile-url https://my-agent.example.com/.well-known/ucp
```

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

## Doctor

`ucp doctor` runs a battery of local + network checks: profile parses, cache directory writable, default catalog endpoint reachable, etc.

```sh
ucp doctor                   # full check
ucp doctor --skip-network    # local-only (CI, offline)
```

The `--help` output is authoritative for current check coverage.

