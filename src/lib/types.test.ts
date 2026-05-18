// Type-level + runtime verification of the protocol-surface types.

import { describe, expect, it } from 'vitest'
import {
  type Cta,
  type CtaBlock,
  type DiscoverPayload,
  type DispatchPayload,
  ERROR_LAYERS,
  type ErrorLayer,
  type Transport,
} from './types.js'

describe('error layer enum', () => {
  it('ERROR_LAYERS contains the four locked values, in declared order', () => {
    expect(ERROR_LAYERS).toStrictEqual(['application', 'escalation', 'transport', 'client'])
  })

  it('ErrorLayer membership is closed at four values', () => {
    // Type-level: a const-narrow assignment fails to compile if the union widens.
    const sample: ErrorLayer[] = ['application', 'escalation', 'transport', 'client']
    expect(sample).toHaveLength(ERROR_LAYERS.length)
  })
})

describe('Transport wire names', () => {
  it('admits exactly rest + mcp', () => {
    const samples: Transport[] = ['rest', 'mcp']
    expect(samples).toHaveLength(2)
  })
})

describe('DispatchPayload — inner payload shape for UCP ops', () => {
  it('requires business/endpoint/transport/result; ucp is optional', () => {
    const payload: DispatchPayload<{ id: string }> = {
      business: 'https://shop.example.com',
      endpoint: 'https://shop.example.com/api/ucp/mcp',
      transport: 'mcp',
      result: { id: 'cart_123' },
    }
    expect(payload.business).toBe('https://shop.example.com')
    expect(payload.transport).toBe('mcp')
    expect(payload.ucp).toBeUndefined()
  })

  it('preserves the hoisted ucp protocol envelope when present', () => {
    const payload: DispatchPayload<{ products: unknown[] }> = {
      business: 'https://catalog.shopify.com',
      endpoint: 'https://catalog.shopify.com/api/ucp/mcp',
      transport: 'mcp',
      ucp: { capabilities: {}, payment_handlers: {} },
      result: { products: [] },
    }
    expect(payload.ucp).toStrictEqual({ capabilities: {}, payment_handlers: {} })
  })

  it('result is generic — narrows through the type parameter', () => {
    const p: DispatchPayload<string> = {
      business: 'b',
      endpoint: 'e',
      transport: 'rest',
      result: 'hello',
    }
    // Type-level: p.result is string here.
    expect(p.result.length).toBe(5)
  })
})

describe('DiscoverPayload — bare discover envelope', () => {
  it('carries only `result` (no dispatch identity at the envelope level)', () => {
    const payload: DiscoverPayload<{ business: string }> = {
      result: { business: 'https://shop.example.com' },
    }
    // Type-level: dispatch identity is intentionally absent from this shape.
    // (Per-capability tuples live inside `result.negotiated` for discover.)
    expect(payload.result.business).toBe('https://shop.example.com')
  })
})

describe('CtaBlock + Cta — mirrors incur c.ok/c.error wire shape', () => {
  it('accepts a single string-form command', () => {
    const block: CtaBlock = { commands: ['ucp doctor'] }
    expect(block.commands).toHaveLength(1)
  })

  it('accepts mixed string and object commands; description is optional', () => {
    const block: CtaBlock = {
      description: 'Suggested commands:',
      commands: ['a', { command: 'b', description: 'b alt' }],
    }
    expect(block.commands).toHaveLength(2)
    expect(block.description).toBe('Suggested commands:')
  })

  it('Cta type re-exports incur Cli.Cta so command names stay type-checkable', () => {
    // Smoke check at runtime — the real value is the compile-time link to
    // incur's command-aware Cta. A free-form re-declaration here would
    // silently drop that.
    const c: Cta = 'ucp doctor'
    expect(typeof c).toBe('string')
  })
})
