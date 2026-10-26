// `dev.ucp.common` service binding.
//
// Parallel to services/shopping.ts: this file owns only the mapping from the
// UCP common service's published tool names to typed CLI/library helpers. The
// dispatcher (core/operation.ts) stays generic — meta.ucp-agent injection,
// idempotency-key injection, schema validation, and OPERATION_NOT_OFFERED all
// behave exactly as they do for shopping.
//
// Per spec/source/services/common/mcp.openrpc.json (UCP 2026-08-25), every
// tool's params are { meta, …body }. `dev.ucp.common` is a separate SERVICE
// from `dev.ucp.shopping`, so discovery negotiates it on its own entry in the
// business profile — even when a business (e.g. Shopify storefronts) points
// both services at the same MCP endpoint. Agents whose profile does not
// declare `dev.ucp.common` get AGENT_PROFILE_SERVICE_UNDECLARED, not a silent
// fallback through the shopping endpoint.

import { serviceOp } from '../core/operation.js'

// Service-level id. Fine-grained capabilities (`dev.ucp.common.location.search`,
// `dev.ucp.common.location.lookup`) are feature flags the server negotiates
// against the agent profile and surfaces via tools/list — the same model as
// `dev.ucp.shopping.catalog.*` under `dev.ucp.shopping`.
const COMMON = 'dev.ucp.common'

const op = (toolName: string, opName: string) => serviceOp(COMMON, toolName, opName)

// ─── location ────────────────────────────────────────────────────────────────
// Body nests under /location. Two tools, one per fine-grained capability:
//   search_locations → { meta, location }   dev.ucp.common.location.search
//   lookup_locations → { meta, location }   dev.ucp.common.location.lookup
//
// search: an empty `location` object lists the first page; narrow with
// `query`, a `distance` relation (explicit `center` + `max` meters), and
// `filters.items` (variant ids, AND-combined); page with `pagination`.
// lookup: `location.ids` (required); Shopify processes the first 10 distinct
// ids and reports the overflow as a `batch_limit_applied` info message.
//
// Item matches follow the business's store-availability policy — they are
// not stock counts, pickup promises, or reservations.

export const searchLocations = op('search_locations', 'location')
export const lookupLocations = op('lookup_locations', 'location')
