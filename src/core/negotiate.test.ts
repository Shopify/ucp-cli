// negotiate.ts unit tests.
//
// Fixtures parse through the generated business profile schema first, so the
// negotiation logic is tested against the same profile shape discovery passes
// at runtime.

import { describe, expect, it } from 'vitest'

import { negotiateService } from './discover.js'
import { businessProfileSchema } from './generated/business_profile.zod.js'
import { AGENT_PROTOCOL_RANGE, type AgentRange } from './profile.js'

const RANGE: AgentRange = { min: '2026-01-23', max: '2026-04-08' }

interface ServiceArgs {
  version: string
  transport: 'rest' | 'mcp' | 'a2a' | 'embedded'
  endpoint?: string
}

function mkEntry(args: ServiceArgs): Record<string, unknown> {
  const { version, transport, endpoint = 'https://example.invalid/svc' } = args
  return { version, transport, endpoint }
}

function mkProfile(entries: ServiceArgs[]): ReturnType<typeof businessProfileSchema.parse> {
  return businessProfileSchema.parse({
    ucp: {
      version: '2026-04-08',
      services: { 'dev.ucp.shopping': entries.map(mkEntry) },
      payment_handlers: {},
    },
  })
}

describe('negotiateService', () => {
  it('picks the highest mutually-supported version when transport matches', () => {
    const profile = mkProfile([
      { version: '2026-01-23', transport: 'mcp' },
      { version: '2026-04-08', transport: 'mcp' },
    ])
    const result = negotiateService({
      profile,
      capability: 'dev.ucp.shopping',
      agentRange: RANGE,
    })
    expect(result.version).toBe('2026-04-08')
    expect(result.transport).toBe('mcp')
  })

  it('respects the agent range upper bound (drops entries above max)', () => {
    const profile = mkProfile([
      { version: '2026-04-08', transport: 'mcp' },
      { version: '2026-09-01', transport: 'mcp' }, // newer than agent supports
    ])
    const result = negotiateService({
      profile,
      capability: 'dev.ucp.shopping',
      agentRange: RANGE,
    })
    expect(result.version).toBe('2026-04-08')
  })

  it('uses transport preference order to break ties at the same version', () => {
    const profile = mkProfile([
      { version: '2026-04-08', transport: 'rest' },
      { version: '2026-04-08', transport: 'mcp' },
    ])
    const mcpFirst = negotiateService({
      profile,
      capability: 'dev.ucp.shopping',
      agentRange: RANGE,
      acceptableTransports: ['mcp', 'rest'],
    })
    expect(mcpFirst.transport).toBe('mcp')

    const restFirst = negotiateService({
      profile,
      capability: 'dev.ucp.shopping',
      agentRange: RANGE,
      acceptableTransports: ['rest', 'mcp'],
    })
    expect(restFirst.transport).toBe('rest')
  })

  it('throws CAPABILITY_NOT_OFFERED when the capability is absent', () => {
    const profile = mkProfile([{ version: '2026-04-08', transport: 'mcp' }])
    expect(() =>
      negotiateService({
        profile,
        capability: 'dev.ucp.checkout',
        agentRange: RANGE,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'CAPABILITY_NOT_OFFERED',
        layer: 'transport',
      }) as unknown as Error,
    )
  })

  it('throws PROTOCOL_VERSION_INCOMPATIBLE when no entry falls inside the range', () => {
    const profile = mkProfile([
      { version: '2025-12-01', transport: 'mcp' },
      { version: '2026-09-01', transport: 'mcp' },
    ])
    expect(() =>
      negotiateService({
        profile,
        capability: 'dev.ucp.shopping',
        agentRange: RANGE,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'PROTOCOL_VERSION_INCOMPATIBLE',
        layer: 'transport',
      }) as unknown as Error,
    )
  })

  it('throws NO_COMPATIBLE_TRANSPORT when the version overlaps but transport does not', () => {
    const profile = mkProfile([{ version: '2026-04-08', transport: 'rest' }])
    expect(() =>
      negotiateService({
        profile,
        capability: 'dev.ucp.shopping',
        agentRange: RANGE,
        acceptableTransports: ['mcp'],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'NO_COMPATIBLE_TRANSPORT',
        layer: 'transport',
      }) as unknown as Error,
    )
  })

  it('treats a2a/embedded entries as ineligible under the v0.1 [mcp] policy', () => {
    const profile = mkProfile([
      { version: '2026-04-08', transport: 'a2a' },
      { version: '2026-04-08', transport: 'embedded' },
    ])
    expect(() =>
      negotiateService({ profile, capability: 'dev.ucp.shopping', agentRange: RANGE }),
    ).toThrowError(expect.objectContaining({ code: 'NO_COMPATIBLE_TRANSPORT' }) as unknown as Error)
  })

  it('accepts entries at the exact min and max boundaries (inclusive range)', () => {
    const atMin = negotiateService({
      profile: mkProfile([{ version: '2026-01-23', transport: 'mcp' }]),
      capability: 'dev.ucp.shopping',
      agentRange: RANGE,
    })
    expect(atMin.version).toBe('2026-01-23')

    const atMax = negotiateService({
      profile: mkProfile([{ version: '2026-04-08', transport: 'mcp' }]),
      capability: 'dev.ucp.shopping',
      agentRange: RANGE,
    })
    expect(atMax.version).toBe('2026-04-08')
  })
})

describe('AGENT_PROTOCOL_RANGE', () => {
  it('exposes the build-time range from package.json#ucp', () => {
    expect(AGENT_PROTOCOL_RANGE.min).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(AGENT_PROTOCOL_RANGE.max).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(AGENT_PROTOCOL_RANGE.min <= AGENT_PROTOCOL_RANGE.max).toBe(true)
  })
})
