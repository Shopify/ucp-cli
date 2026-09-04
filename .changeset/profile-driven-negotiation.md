---
"@shopify/ucp-cli": minor
---

**Adds UCP 2026-08-25, and makes the protocol version a property of your profile.**

`ucp-cli` supports two UCP releases: **2026-04-08** and **2026-08-25**. Which one you speak is set by the profile you activate — not by which version of the CLI you installed.

```sh
ucp --version                                        # ucp 0.7.0 (UCP 2026-04-08, 2026-08-25)
ucp profile init --name legacy --version 2026-04-08  # a profile pinned to the older release
ucp discover shop.example.com --profile legacy       # ...speaks 2026-04-08
```

An agent profile declares exactly one `ucp.version` and merchants validate that exact version on every request, so switching version means switching profile. Fixes #48.

The CLI never puts its profile body on the wire — it sends `meta.ucp-agent.profile`, a URL, and the merchant GETs that URL. So: **you give `ucp-cli` a public URL for your agent profile (`--profile-url`), or it assigns the release default.** That URL is what goes on the wire, what merchants read, and the whole of version selection. `~/.ucp/profiles/<name>/profile.json` is a local working copy of what you claim is at that URL — if you own the URL, you upload the document there yourself, because `ucp-cli` has no command that writes to it.

**`ucp-cli` never fetches that URL; `ucp doctor` does.** To negotiate it needs its own `ucp.version` and declared services, and it reads both locally: from its bundled copy of the published document when the URL is a release default, or from your `profile.json` when the URL is yours. One consequence worth knowing: **editing `profile.json` while pointed at a release-default URL changes nothing merchants can see** — `ucp doctor` is what surfaces that.

## Breaking changes

**1. Profiles created by 0.6.x now negotiate 2026-08-25 instead of 2026-04-08.** 0.6.x clamped every profile to a build-time `protocolMax` of 2026-04-08 regardless of what `profile.json` declared. Version now comes from the profile's URL, and a profile with no `meta.profile_url` resolves to the latest release default — so the version in force moves. Both releases are supported, and the jump is permissive rather than restrictive — 2026-04-08 has the narrower `reverse_domain_name` grammar (breaking change 3), so keys valid before stay valid. `ucp doctor`'s `protocol` check names the version actually in force. If you need the old release, pin it.

To pin 2026-04-08, set **one field** — `meta.profile_url` in `~/.ucp/profiles/<name>/meta.json` — to that release's published profile URL.

```jsonc
// ~/.ucp/profiles/<name>/meta.json
{ "profile_url": "https://shopify.dev/ucp/agent-profiles/2026-04-08/valid-with-capabilities.json" }
```

That URL is the whole of version selection, and your `profile.json` — including any edits you made to it — is untouched. `ucp profile init --name <name> --version 2026-04-08 --force` is the clean-slate alternative: it preserves `created_at` but **overwrites `profile.json` with that release's published template, discarding local edits**, so reach for it only when you want the stock document back.

**2. If you own your profile URL, `profile.json` is what the CLI declares — and a self-inconsistent document is now fatal.**
- Its `ucp.version` selects the merchant rendering and its `ucp.services` decide what gets negotiated, so keep it matching what you serve. `ucp doctor` fails when the two disagree on `ucp.version`.
- A `dev.ucp.*` service or capability declared at a version other than the document's own `ucp.version` is now `AGENT_PROFILE_VERSION_MISMATCH` — fatal, pre-network. Fatal **only** when the URL is yours; on a release default the CLI warns and proceeds rather than hard-stopping every install over a publisher's defect nobody local can fix.
- Re-initting rewrites `profile.json` from the release's **verbatim published snapshot** instead of the old hand-written template: it gains `dev.ucp.shopping.buyer_consent` and loses the `keys: []` stub plus several `spec`/`schema` URLs the template invented. Upload the rewritten file, or `profile-drift` warns until you do.
- Note on `signing_keys` → `keys` (renamed in the 2026-08-25 profile schema): this CLI validates neither and reads neither — request signing is not implemented — so a profile carrying the old field name still parses at both releases. It matters to whoever verifies your signatures, not to `ucp-cli`.

**3. `reverse_domain_name` is strictly narrower at 2026-04-08, and the grammar now follows the negotiated release.** Extension keys are validated against `RELEASES[<negotiated version>].reverseDomainPattern`, generated per release from the spec rather than hand-copied. `com.example-shop.checkout` (hyphen), `com.2example.cart` (digit-leading segment), and punycode labels like `xn--p1ai.example.svc` are valid at 2026-08-25 and **rejected at 2026-04-08**. Pinning an older profile can therefore turn payloads that used to pass into `SCHEMA_VALIDATION_FAILED`.

**4. Bare `ucp discover` no longer hydrates business services your profile does not declare.** `negotiated` is now `keys(agent.services) ∩ keys(business.ucp.services)` — there is no platform side to negotiate the rest against. Skipped services remain visible in the lossless `profile` field and are listed by `--verbose` (never silently dropped). Requesting one explicitly (`--capability`, or an operation that needs it) is `AGENT_PROFILE_SERVICE_UNDECLARED`, which names both what you declare and what they offer.

**5. `ucp --version` output changed shape.** `0.7.0` → `ucp 0.7.0 (UCP 2026-04-08, 2026-08-25)`. Scripts parsing the bare semver need `sed 's/^ucp //; s/ .*//'` or similar. The MCP `serverInfo.version` and the update checker still see the bare semver.

**6. `--protocol-min` / `--protocol-max` are removed**, along with `package.json#ucp.{protocolMin,protocolMax,specVersion,default_profile_url_template}`, the `__PROTOCOL_MIN__` / `__PROTOCOL_MAX__` / `__SPEC_VERSION__` / `__DEFAULT_PROFILE_URL__` build defines, and the `meta.protocol_versions` write. `profile init --version <v>` replaces them. The range was documented, persisted, and read by nothing — a root cause of #48. A `meta.protocol_versions` left over from an older CLI is ignored, and the profile still loads.

**7. `ucp doctor` exits 1 when the verdict is `ok: false`.** It always exited 0, which made the `fail` severity decoration — including `protocol`, whose failure predicts total failure rather than local inconvenience (the merchant GETs the same profile URL and hard-fails `-32001 profile_unreachable` if it cannot read it, or negotiates a different release than the one the CLI speaks). The JSON envelope on stdout is byte-identical to before; only the exit status changed, so `ucp doctor` can now gate a CI job. **Plainly: because `protocol` makes a network request, transient network trouble — DNS blip, proxy hiccup, a slow CDN — can now fail a build.** `ucp doctor --skip-network` is the offline/flake escape and omits the hosted-identity checks (`protocol`, `profile-drift`, `profile-cache-control`). Under `--mcp` the exit code is untouched (the checks are a tool result there).

**8. Error codes: `PROFILE_*` now always means the merchant's document, `AGENT_PROFILE_*` always means yours.** No code means both, and `code → layer` is now a function enforced by a test. Nothing was renamed away; six codes were added and several conditions moved:

| Condition | Before | Now |
|---|---|---|
| Merchant reports it could not fetch our profile URL | `MCP_RPC_ERROR` | `AGENT_PROFILE_UNREACHABLE` (`client`, `reason: business_reported`); `ucp doctor` raises the same code for `network` / `http_status` / `not_json` |
| Our profile declares a version `ucp-cli` does not support | (unchecked) | `AGENT_PROFILE_VERSION_UNSUPPORTED` (`client`) |
| Our profile fails its release schema | `SCHEMA_VALIDATION_FAILED` (local file only) | `AGENT_PROFILE_SCHEMA_INVALID` (`client`) |
| Our profile contradicts itself about its version | (unchecked) | `AGENT_PROFILE_VERSION_MISMATCH` (`client`) |
| Merchant offers a service we do not declare | (unchecked — the profile was never consulted) | `AGENT_PROFILE_SERVICE_UNDECLARED` (`client`) |
| Service version lines do not intersect | `NO_COMPATIBLE_TRANSPORT` (the #48 misdiagnosis) | `SERVICE_VERSION_INCOMPATIBLE` (`transport`) |
| Merchant document contradicts itself (mislabelled `supported_versions` leaf, or a `dev.ucp.*` service with no entry at the rendering's own version) | `PROFILE_VERSION_MISMATCH` (leaf case only) | `PROFILE_VERSION_MISMATCH`, both cases (`transport`) |
| Requested id neither side has | `CAPABILITY_NOT_OFFERED` | unchanged — a typo is not a "go edit your profile" problem |
| Right version, no transport we speak | `NO_COMPATIBLE_TRANSPORT` | unchanged, but now names all three sets (merchant offers / profile declares / ucp-cli supports) |

`context` is never serialized to CLI consumers, so every remedy that depends on a value now carries it in `message` or `cta`.

## Also in this release

- **UCP 2026-08-25 support.** Shopify storefronts and `catalog.shopify.com` publish 2026-08-25; with the old `protocolMax` pinned to 2026-04-08, `discover`/`cart`/`checkout` failed against any Shopify storefront and `catalog search` failed with `PROTOCOL_VERSION_INCOMPATIBLE` (#48). Profile schemas are generated per release into `src/core/generated/<version>/`, with a CI drift gate per release.
- **`supported_versions` fallback**, retargeted to exact-version selection: when `/.well-known/ucp` is not at the profile's version, the leaf linked from `supported_versions[<version>]` is fetched (https only) and its `ucp.version` verified against the key before use, per the spec's MUST. Leaves are not followed recursively. Version-specific documents cache under `businesses/<version>/<origin>.json`.
- **`ucp discover` output** gains `protocol: { version, source: 'well-known' | 'supported_versions', businessProfileUrl }` and `expectedCapabilities`. There is deliberately no second version field to compare against `protocol.version`: `source` carries the same information without inviting date-order reasoning. `expectedCapabilities` is a client-side **prediction** for planning; the merchant's `ucp.capabilities` on each response is the authority.
- **`ucp doctor` is now the only thing that fetches your profile URL**, and its checks split cleanly: `protocol` owns *can this URL be used, and does what it serves agree with what we will actually send with* (reachable, 200, JSON, valid for its release, a version `ucp-cli` supports, **and that version equal to the one the request path uses** — the bundled snapshot on a release default, `profile.json` when the URL is yours; the failure names both versions). `profile-drift` owns *does your local authoring copy match what your URL publishes*. New `profile-cache-control` warns — self-hosted URLs only — when the document you serve is not shared-cacheable with `max-age>=60`, as UCP's hosting rules require; merchants fetch it per request. Diagnostics never gate a request, but a `fail` gates the exit code (breaking change 7). The old `profile-url` check is **deleted**: it HEAD-probed the same URL at `warn` severity, which `protocol` strictly subsumes with a GET at `fail`, and keeping both produced contradictory pairs with no added information (a host that 405s HEAD but serves GET reported `profile-url: warn` beside `protocol: ok`).
- **CTA extension hints follow the active profile.** They used to be filtered against the capability keys of the bundled profile template, frozen at module load, so a capability you declared in your own hosted profile was invisible to the CTA layer even when both sides had negotiated it. The set is now `active profile ∩ merchant`, which preserves the property that matters — the merchant cannot expand it — while letting the principal (you) do so.
- **`PROTOCOL_VERSION_INCOMPATIBLE` suggests switching profiles** when another local profile speaks a version the merchant offers, naming all matches. Derived from each profile's hosted URL, never from its on-disk `profile.json`, which may be stale.
- **`ucp profile publish` is removed.** It never uploaded anything — the upload function it called was a no-op, so its success branch was unreachable in every shipped build. Nothing that worked stops working. Gone with it: `src/core/profile-publisher.ts` and the `profile_id` / `etag` / `published_at` fields in `meta.json`, which only ever existed to receive an upload response (`profileMetaSchema` is `.loose()`, so an old `meta.json` carrying them still parses). Remedies that used to say "re-publish it" now tell you to upload the document to your URL yourself.
- **Reading your own identity costs no network at all.** The CLI needs three things per request — the URL to send, its own `ucp.version`, and its declared services — and all three are local. On the default path `profile_url` is a release's published Shopify profile and `ucp-cli` ships that document verbatim, so it reads the bundled copy; when the URL is yours, it reads your `profile.json`. That removes a round trip from every command and, more importantly, a hard availability dependency: a blip on a profile host can no longer block a request the merchant would have served from its own cache. `ucp doctor` reads the URL live — it is the drift detector, and a check answered from a snapshot detects nothing.
