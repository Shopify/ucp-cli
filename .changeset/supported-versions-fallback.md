---
"@shopify/ucp-cli": minor
---

Follow `supported_versions` when a business profile is ahead of the CLI's protocol range.

Discovery implements the spec's "Protocol Version" fallback: when `/.well-known/ucp` is rendered at a version outside `[protocolMin, protocolMax]`, the most recent in-range `supported_versions` document is fetched and negotiated against instead, after verifying its `ucp.version` matches the key. A future spec release that keeps publishing an in-range rendering no longer breaks the CLI until it is updated.

- New `PROFILE_VERSION_MISMATCH` error code for a `supported_versions` document whose `ucp.version` disagrees with its key (the spec says such a document must not be used).
- `PROTOCOL_VERSION_INCOMPATIBLE` now lists the versions the business offered.
- Version-specific documents cache under `businesses/<version>/<origin>.json`.
