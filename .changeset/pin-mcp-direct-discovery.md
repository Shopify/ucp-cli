---
'@shopify/ucp-cli': patch
---

Restore the per-command MCP tool surface (`catalog_search`, `cart_create`, ...). a later incur 0.4.x release flipped its MCP tool discovery default to 'progressive', which replaced this CLI's published tools with four search/inspect/execute meta-tools on any fresh install resolving a newer incur. Tool discovery is now pinned to 'direct' and covered by an integration test, and the locked incur is aligned with what fresh installs resolve (0.4.26).
