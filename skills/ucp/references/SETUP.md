# UCP CLI — Setup reference

Install paths, optional Profile configuration, and health checks. (Escalation hook configuration lives in the main SKILL.md alongside the escalation flow it gates, since it's part of normal operation, not just one-time setup.)

## Install

The CLI requires Node.js `22.19.0` or later and ships as `@shopify/ucp-cli` on npm. Two practical install paths:

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

## Profiles

Commands use the Shopify-managed Profile by default. It appears alongside local Profiles in `list`, and `show` displays the effective selection.

```sh
ucp profile list
ucp profile show
```

See [REFERENCE](REFERENCE.md#profile-selection) for selection precedence and discovery output.

## DIY authoring and URL ownership

`ucp profile init` creates a named DIY Profile. `--version` accepts one installed release; without it, the latest installed release is fixed at creation. The new Profile is selected only with `--activate`.

```sh
ucp profile init --name pinned-0408 --version 2026-04-08
ucp discover --business https://shop.example.com --profile pinned-0408
ucp profile init --name custom --profile-url https://you.example/agent.json --activate
```

An existing Profile remains unchanged unless `--force` is passed; `--activate` may select that unchanged Profile. Forced init replaces `profile.json` and discards edits. Unless `--profile-url` is given, it retains a readable custom URL or uses the selected release's URL; provide the URL again if the existing configuration is unreadable.

The authored document is `~/.ucp/profiles/<name>/profile.json`; `meta.json` stores its URL and local defaults, and `headers.json` optionally stores persistent request headers. CLI upgrades do not rewrite the authored document.

The Profile URL must serve the same document as local `profile.json`. A release URL already serves the generated body; custom capabilities require a URL under the author's control:

```sh
ucp profile init --name custom --profile-url https://you.example/agent.json
# Edit ~/.ucp/profiles/custom/profile.json and publish that file at the URL.
ucp profile use custom
ucp doctor
```

`ucp-cli` does not upload Profile documents. Profile URLs are unsigned, so control of the URL controls the advertised Profile. `--catalog <url>` stores an optional catalog fallback on the DIY Profile.

## Selection and Profile URL overrides

Profile names and Profile URLs resolve independently:

| Value | Highest to lowest precedence |
|---|---|
| Profile name | per-call `--profile` → `UCP_PROFILE` → `active.yaml.profile` → managed |
| Profile URL | per-call `--profile-url` → `UCP_AGENT_PROFILE_URL` → selected DIY URL/release URL → selected managed Profile URL |

A Profile URL override pins one advertised URL. With a named DIY Profile, commands still use local `profile.json` while advertising the override URL. With the managed Profile or a named managed Profile, a known Shopify release URL selects that release; another URL uses the latest bundled document and warns. A URL override does not suppress a Profile name selected through the other precedence chain.

`ucp profile use <name>` and `ucp profile use --managed` update `~/.ucp/active.yaml` but do not outrank environment variables. The `--managed` flag clears a named selection; positional `managed` is an ordinary local Profile name. Business selection is stored separately:

```sh
ucp use https://shop.example.com
ucp use --clear
```

MCP mode ignores Profile and Business values in `active.yaml` because one server can serve unrelated conversations. Explicit tool arguments and `UCP_PROFILE`, `UCP_AGENT_PROFILE_URL`, and `UCP_BUSINESS` still apply.

## Persistent headers

Persistent `~/.ucp/profiles/<name>/headers.json` is available only for a named Profile. Per-call `--header 'Name: Value'` works with any selection; creating a DIY Profile only for persistent headers also pins its release.

Headers merge from low to high priority: CLI `User-Agent`, `headers.json` `default`, `headers.json` `businesses[<origin>]`, then repeatable per-call `--header`. Names compare case-insensitively, and an empty value unsets a header for its scope.

```json
{
  "default": {
    "Trace-Id": "my-agent-${HOSTNAME}"
  },
  "businesses": {
    "https://shop.example.com": {
      "Authorization": "Bearer ${EXAMPLE_TOKEN}"
    }
  }
}
```

Values support `${ENV_VAR}` interpolation so secrets can remain outside the file. Reserved transport headers are ignored, and sensitive values are redacted from verbose traces.

## Pin before creating a long-lived resource

The CLI does not remember which Profile created a resource. A resource that must stay on one release needs an intentional DIY pin at creation and the same explicit Profile on later calls. First reset to the managed Profile as described above, then:

```sh
BUSINESS=https://shop.example.com
unset UCP_PROFILE UCP_AGENT_PROFILE_URL
VERSION=$(ucp discover --refresh --business "$BUSINESS" | jq -er '.result.protocol.version')
ucp profile init --name shop-pin --version "$VERSION"
CART_ID=$(ucp cart create --profile shop-pin --business "$BUSINESS" --input @cart-create.json | jq -er '.result.id')
ucp cart get "$CART_ID" --profile shop-pin --business "$BUSINESS"
```

Discovery is enveloped, so the selected release is `.result.protocol.version`. `--refresh` bypasses cached discovery and forces a live compatibility check; every later update, checkout, completion, or order call for the resource uses `--profile shop-pin`.

## Doctor

`ucp doctor` checks the same effective Profile as commerce commands and fetches its advertised URL. Local checks cover the Node runtime, writable state directories, `active.yaml`, Profile parsing, and proxy configuration.

| Hosted check | Result |
|---|---|
| `protocol` | **Fail** when a URL is unusable or its release differs from the selected Profile. |
| `profile-redirect` | **Fail** when the Profile URL redirects instead of serving directly. |
| `profile-drift` | **Warn** when releases agree but the hosted and selected Profile documents differ. |
| `profile-cache-control` | **Warn** when hosting lacks `Cache-Control: public, max-age>=60`. |

Managed selection audits every bundled release; a DIY Profile or Profile URL override audits one. Any failure sets `ok: false` and exits `1`; warnings alone exit `0`. `--skip-network` omits exactly the four hosted checks. Error-code meanings are in [REFERENCE](REFERENCE.md#error-codes).

```sh
ucp doctor
ucp doctor --skip-network
```
