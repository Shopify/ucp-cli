// Advisory only: discovery predicts merchant capabilities, but the server's
// response is authoritative. Never suppress or rewrite a checkout call here.
import type { DiscoveredBusiness } from '../core/discover.js'

const FULFILLMENT = 'dev.ucp.shopping.fulfillment'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Return only method types definitely absent from an unambiguous declaration. */
export function unsupportedFulfillmentMethods(
  discovered: DiscoveredBusiness,
  input: Record<string, unknown>,
): string[] {
  const checkout = record(input.checkout)
  const fulfillment = record(checkout?.fulfillment)
  const methods = record(fulfillment)?.methods
  if (!Array.isArray(methods)) return []

  const entries = record(discovered.profile.ucp.capabilities)?.[FULFILLMENT]
  if (!Array.isArray(entries)) return []
  const matching = entries.filter((entry) => record(entry)?.version === discovered.protocol.version)
  // Several matching entries can disagree. Do not claim absence in that case.
  if (matching.length !== 1) return []
  const combinations = record(record(matching[0])?.config)?.allows_method_combinations
  if (!Array.isArray(combinations) || combinations.length === 0) return []
  const supported = new Set<string>()
  for (const combination of combinations) {
    if (!Array.isArray(combination) || combination.length === 0) return []
    for (const type of combination) {
      if (typeof type !== 'string' || type.length === 0) return []
      supported.add(type)
    }
  }
  const requested = new Set<string>()
  for (const method of methods) {
    const type = record(method)?.type
    if (typeof type === 'string' && type.length > 0 && !supported.has(type)) requested.add(type)
  }
  return [...requested]
}
