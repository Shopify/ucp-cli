---
"@shopify/ucp-cli": minor
---

**A profile speaks exactly one UCP release, and the business must offer that release.**

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
