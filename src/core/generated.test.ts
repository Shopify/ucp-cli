// Smoke tests for the codegenned profile schemas. Lives outside
// generated/ so regen never clobbers it.
//
// Scope: each test guards a specific behavior that the codegen pipeline
// must preserve. Plain zod behavior (regex, enum, required) is not
// re-tested here. The mapping from behavior → codegen transform is
// documented in scripts/codegen-schemas.ts.

import { describe, expect, it } from 'vitest'
import { businessProfileSchema } from './generated/business_profile.zod.js'
import { platformProfileSchema } from './generated/platform_profile.zod.js'

describe('platformProfileSchema', () => {
  it('accepts an MCP service entry without an endpoint (consumer-only agent)', () => {
    const noEndpoint = {
      ucp: {
        version: '2026-04-08',
        services: {
          'dev.ucp.shopping': [{ version: '2026-04-08', transport: 'mcp' }],
        },
        payment_handlers: {},
      },
      signing_keys: [],
    }
    const result = platformProfileSchema.safeParse(noEndpoint)
    expect(result.success, JSON.stringify(result.error?.issues, null, 2)).toBe(true)
  })

  it('preserves unknown extension fields at every object boundary', () => {
    const profile = {
      ucp: {
        version: '2026-04-08',
        services: {},
        payment_handlers: {},
        x_experimental: { trace_id: 'abc' },
      },
      signing_keys: [],
      vendor_specific: { foo: 'bar', count: 42 },
    }
    const result = platformProfileSchema.safeParse(profile)
    expect(result.success, JSON.stringify(result.error?.issues, null, 2)).toBe(true)
    const data = result.data as { ucp: Record<string, unknown> } & Record<string, unknown>
    expect(data.vendor_specific).toStrictEqual({ foo: 'bar', count: 42 })
    expect(data.ucp.x_experimental).toStrictEqual({ trace_id: 'abc' })
  })
})

describe('businessProfileSchema', () => {
  it('accepts a business profile with a service binding and supported_versions', () => {
    const business = {
      ucp: {
        version: '2026-04-08',
        supported_versions: {
          '2026-01-23': 'https://example.invalid/.well-known/ucp?v=2026-01-23',
        },
        services: {
          'dev.ucp.shopping': [
            { version: '2026-04-08', transport: 'mcp', endpoint: 'https://example.invalid/mcp' },
          ],
        },
        payment_handlers: {},
      },
    }
    const result = businessProfileSchema.safeParse(business)
    expect(result.success, JSON.stringify(result.error?.issues, null, 2)).toBe(true)
  })

  it('rejects supported_versions when shape is an array instead of a record', () => {
    const bad = {
      ucp: {
        version: '2026-04-08',
        supported_versions: ['2026-01-23'],
        services: {},
        payment_handlers: {},
      },
    }
    expect(businessProfileSchema.safeParse(bad).success).toBe(false)
  })
})
