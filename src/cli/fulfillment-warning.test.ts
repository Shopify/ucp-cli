import { describe, expect, it } from 'vitest'
import type { DiscoveredBusiness } from '../core/discover.js'
import { unsupportedFulfillmentMethods } from './fulfillment-warning.js'

const fulfillment = 'dev.ucp.shopping.fulfillment'
const combination = (methods: unknown) => ({
  version: '2026-08-25',
  config: { allows_method_combinations: methods },
})
function discovery(entries: unknown): DiscoveredBusiness {
  return {
    profile: { ucp: { capabilities: { [fulfillment]: entries } } },
    protocol: { version: '2026-08-25' },
  } as DiscoveredBusiness
}
function checkout(types: unknown[]): Record<string, unknown> {
  return { checkout: { fulfillment: { methods: types.map((type) => ({ type })) } } }
}

describe('unsupportedFulfillmentMethods', () => {
  it('identifies pickup absent from shipping-only combinations, without flagging shipping', () => {
    expect(
      unsupportedFulfillmentMethods(
        discovery([combination([['shipping']])]),
        checkout(['shipping', 'pickup', 'pickup']),
      ),
    ).toEqual(['pickup'])
  })
  it('uses the union of declared combinations, including mixed choices', () => {
    const d = discovery([combination([['shipping'], ['shipping', 'pickup']])])
    expect(unsupportedFulfillmentMethods(d, checkout(['pickup', 'shipping']))).toEqual([])
    expect(unsupportedFulfillmentMethods(d, checkout(['courier', 'pickup']))).toEqual(['courier'])
  })
  it('does not infer an unsupported method from absent, malformed, ambiguous, or other-version config', () => {
    for (const entries of [
      undefined,
      [],
      [combination([])],
      [combination([['shipping'], [1]])],
      [combination([['shipping']]), combination([['pickup']])],
      [{ version: '2026-04-08', config: { allows_method_combinations: [['shipping']] } }],
    ]) {
      expect(unsupportedFulfillmentMethods(discovery(entries), checkout(['pickup']))).toEqual([])
    }
  })
  it('ignores non-checkout payloads', () => {
    expect(
      unsupportedFulfillmentMethods(discovery([combination([['shipping']])]), {
        cart: { fulfillment: { methods: [{ type: 'pickup' }] } },
      }),
    ).toEqual([])
  })
})
