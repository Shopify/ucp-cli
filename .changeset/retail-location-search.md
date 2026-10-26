---
"@shopify/ucp-cli": minor
---

Add `ucp location search` and `ucp location lookup` for the UCP 2026-08-25 `dev.ucp.common.location.search` / `.lookup` capabilities, so agents can find a business's physical retail stores and check which ones carry specific items.

- Both commands bind to the `dev.ucp.common` service and are negotiated on its own business-profile entry, even when a business (e.g. Shopify storefronts) serves it from the same MCP endpoint as `dev.ucp.shopping`. Body fields are CLI-facing and wrapped under `/location` on the wire; `--input-schema`, `--dry-run`, `--header`, and `--view` work as on every other operation. Exposed over MCP as `location_search` and `location_lookup`.
- The bundled 2026-08-25 managed rendering is refreshed from Shopify's published agent profile, which now declares `dev.ucp.common` and both location capabilities.
- Location CTAs carry the spec's buyer-safety guidance — send `distance.center` only from a location the buyer shared, and treat item matches as provisional — plus next-page, re-check-by-id, `batch_limit_applied`, and business-rejected-filter recovery paths.
- New package-local view: `ucp location search --view :compact` flattens each store to id, name, address, and coordinates.
