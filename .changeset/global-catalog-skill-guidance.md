---
"@shopify/ucp-cli": patch
---

Correct and clarify the bundled UCP agent skill's Shopify Global Catalog guidance:

- **Seller identity**: match a buyer-named brand or first-party store on `seller.url` (the buyer-facing storefront); `seller.domain` is the permanent handle for addressing the API (`--business`), not a brand signal.
- **Checkout**: `eligible.native_checkout` indicates whether a checkout can be *finalized* in-protocol — `false` still supports building and negotiating a cart/checkout in-protocol, with finalizing handled via escalation (`continue_url`); it is not a redirect-only dead end.
- **Currency**: prices are returned in each seller's market presentment currency (keyed off `context.address_country`), so a result set can span multiple currencies — read `price_range.min.currency` per item.
- **get_product**: copy `selected` option names/labels verbatim from the response's `options[]`; `options` may be `null` (no variant picker — use the featured variant or hand off to the product `url`).
- **filters.attributes**: names/values come from the Shopify Standard Product Taxonomy (category-specific; canonical name or GID), with a pointer to the public taxonomy.

Also consolidates the duplicated response-field documentation into `references/CATALOG.md`.
