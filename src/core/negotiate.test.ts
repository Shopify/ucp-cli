// negotiateService unit tests — the profile-driven exact-version intersection.
//
// The platform side is a real `AgentProfile` (built through `loadAgentProfile`,
// so a fixture cannot declare something the loader would reject); the business
// side parses through that release's generated business schema, so the logic
// is tested against the same shapes discovery passes at runtime.
//
// Scenario names (S3, S7, S8, S9) refer to the negotiation design doc's
// consumer-experience section.

import { afterEach, describe, expect, it } from 'vitest'

import { agentProfileFixture } from '../test-utils.js'
import { loadAgentProfile } from './agent.js'
import { negotiateService } from './discover.js'
import { businessProfileSchema as businessSchema20260408 } from './generated/2026-04-08/business_profile.zod.js'
import { businessProfileSchema as businessSchema20260825 } from './generated/2026-08-25/business_profile.zod.js'
import { type BusinessProfile, RELEASES, type Version } from './releases.js'
import { setVerboseWriter, setWarnWriter } from './verbose.js'

const ENDPOINT = 'https://shop.example.invalid/ucp/mcp'

interface EntryArgs {
  version: string
  transport: 'rest' | 'mcp' | 'a2a' | 'embedded'
  endpoint?: string
}

function entry(args: EntryArgs): Record<string, unknown> {
  const { version, transport, endpoint = ENDPOINT } = args
  return { version, transport, endpoint }
}

/** A business rendering at `version` advertising `services`. */
function business(version: Version, services: Record<string, EntryArgs[]>): BusinessProfile {
  const schema = version === '2026-04-08' ? businessSchema20260408 : businessSchema20260825
  const rendered: Record<string, Record<string, unknown>[]> = {}
  for (const [key, entries] of Object.entries(services)) rendered[key] = entries.map(entry)
  return schema.parse({
    ucp: { version, services: rendered, payment_handlers: {} },
  })
}

/** Capture `vlog` output for the duration of one test. */
function captureVlog(): string[] {
  const lines: string[] = []
  setVerboseWriter((msg) => {
    lines.push(msg)
  })
  return lines
}

afterEach(() => {
  setVerboseWriter(null)
  setWarnWriter(null)
})

describe('negotiateService — the happy path is exact equality', () => {
  it('S3: negotiates dev.ucp.shopping at the profile version and vlogs the stale entry', () => {
    // Shopify storefront rendering today: mcp at the current release plus a
    // leftover `embedded@2026-04-08`. The stale entry is a platform defect
    // filed elsewhere — it must not read as a negotiation failure.
    const lines = captureVlog()
    const agent = agentProfileFixture({ version: '2026-08-25' })
    const profile = business('2026-08-25', {
      'dev.ucp.shopping': [
        { version: '2026-08-25', transport: 'mcp' },
        { version: '2026-04-08', transport: 'embedded' },
      ],
    })

    const result = negotiateService({ profile, capability: 'dev.ucp.shopping', agent })

    expect(result).toMatchObject({
      capability: 'dev.ucp.shopping',
      version: '2026-08-25',
      transport: 'mcp',
    })
    expect(result.entry.endpoint).toBe(ENDPOINT)
    expect(lines.join('')).toContain(
      "ignoring dev.ucp.shopping entries at [2026-04-08]; profile 'agent' uses UCP 2026-08-25",
    )
  })

  it("S3': the same code negotiates at 2026-04-08 when the 04-08 profile is presented", () => {
    // Same binary, other version, by switching profiles. Nothing here is
    // release-specific: the profile picked the version.
    const agent = agentProfileFixture({ version: '2026-04-08' })
    const profile = business('2026-04-08', {
      'dev.ucp.shopping': [
        { version: '2026-04-08', transport: 'mcp' },
        { version: '2026-04-08', transport: 'embedded' },
      ],
    })

    const result = negotiateService({ profile, capability: 'dev.ucp.shopping', agent })
    expect(result.version).toBe('2026-04-08')
    expect(result.transport).toBe('mcp')
  })

  it('does not treat date order as compatibility: a newer business entry never wins', () => {
    // The deleted range model would have picked 2026-08-25 here.
    const agent = agentProfileFixture({ version: '2026-04-08' })
    const profile = business('2026-04-08', {
      'dev.ucp.shopping': [
        { version: '2026-04-08', transport: 'mcp' },
        { version: '2026-08-25', transport: 'mcp' },
      ],
    })

    expect(negotiateService({ profile, capability: 'dev.ucp.shopping', agent }).version).toBe(
      '2026-04-08',
    )
  })

  it('picks the endpoint of the entry that actually matched', () => {
    const agent = agentProfileFixture({ version: '2026-08-25' })
    const profile = business('2026-08-25', {
      'dev.ucp.shopping': [
        { version: '2026-04-08', transport: 'mcp', endpoint: 'https://old.example.invalid/mcp' },
        { version: '2026-08-25', transport: 'mcp', endpoint: 'https://new.example.invalid/mcp' },
      ],
    })

    expect(
      negotiateService({ profile, capability: 'dev.ucp.shopping', agent }).entry.endpoint,
    ).toBe('https://new.example.invalid/mcp')
  })
})

describe('negotiateService — third-party services (S7)', () => {
  const ACME = 'com.acme.svc'
  // SELF-HOSTED, and that is not incidental: a profile declaring a
  // third-party service is necessarily one the user wrote (the published
  // release defaults declare only `dev.ucp.shopping`). The URL decides whose
  // document a defect belongs to, which decides which remedy
  // SERVICE_VERSION_INCOMPATIBLE names — so a fixture pointing at a release
  // default while declaring `com.acme.*` would be asserting an impossible
  // state and would collect the published-profile wording.
  const SELF_HOSTED = 'https://agent.example.invalid/agent.json'

  function agentWithAcme(versions: string[], transport = 'mcp') {
    return agentProfileFixture({
      version: '2026-08-25',
      url: SELF_HOSTED,
      services: {
        'dev.ucp.shopping': [{ version: '2026-08-25', transport: 'mcp' }],
        [ACME]: versions.map((version) => ({ version, transport })),
      },
    })
  }

  it('negotiates an exact third-party version match through the same algorithm', () => {
    const agent = agentWithAcme(['2025-11-01'])
    const profile = business('2026-08-25', {
      [ACME]: [{ version: '2025-11-01', transport: 'mcp' }],
    })

    const result = negotiateService({ profile, capability: ACME, agent })
    expect(result).toMatchObject({ capability: ACME, version: '2025-11-01', transport: 'mcp' })
  })

  it('SERVICE_VERSION_INCOMPATIBLE when the two version lines do not meet', () => {
    const agent = agentWithAcme(['2025-11-01'])
    const profile = business('2026-08-25', {
      [ACME]: [{ version: '2025-06-01', transport: 'mcp' }],
    })

    expect(() => negotiateService({ profile, capability: ACME, agent })).toThrowError(
      expect.objectContaining({
        code: 'SERVICE_VERSION_INCOMPATIBLE',
        layer: 'transport',
        message: `${ACME}: profile 'agent' declares [2025-11-01], business offers [2025-06-01]`,
      }) as unknown as Error,
    )
  })

  it('a third-party mismatch is NOT reported as a merchant defect', () => {
    // `PROFILE_VERSION_MISMATCH kind:'service-entries'` is dev.ucp.* only:
    // a com.acme.* entry at another version is a legitimate independent
    // version line, not a self-contradicting document.
    const agent = agentWithAcme(['2025-11-01'])
    const profile = business('2026-08-25', {
      [ACME]: [{ version: '2025-06-01', transport: 'mcp' }],
    })
    let code: string | undefined
    try {
      negotiateService({ profile, capability: ACME, agent })
    } catch (err) {
      code = (err as { code: string }).code
    }
    expect(code).not.toBe('PROFILE_VERSION_MISMATCH')
  })

  it('does not vlog a stale-entry note for off-version third-party entries', () => {
    const lines = captureVlog()
    const agent = agentWithAcme(['2025-11-01'])
    const profile = business('2026-08-25', {
      [ACME]: [
        { version: '2025-06-01', transport: 'mcp' },
        { version: '2025-11-01', transport: 'mcp' },
      ],
    })

    negotiateService({ profile, capability: ACME, agent })
    expect(lines.join('')).not.toContain('ignoring')
  })

  it('picks the highest mutual version when both sides declare several', () => {
    const agent = agentWithAcme(['2025-06-01', '2025-11-01'])
    const profile = business('2026-08-25', {
      [ACME]: [
        { version: '2025-06-01', transport: 'mcp', endpoint: 'https://a.example.invalid/mcp' },
        { version: '2025-11-01', transport: 'mcp', endpoint: 'https://b.example.invalid/mcp' },
      ],
    })

    const result = negotiateService({ profile, capability: ACME, agent })
    expect(result.version).toBe('2025-11-01')
    expect(result.entry.endpoint).toBe('https://b.example.invalid/mcp')
  })

  it('AGENT_PROFILE_SERVICE_UNDECLARED when the profile does not declare a service the business offers', () => {
    const agent = agentProfileFixture({ version: '2026-08-25' })
    const profile = business('2026-08-25', {
      [ACME]: [{ version: '2025-11-01', transport: 'mcp' }],
    })

    expect(() => negotiateService({ profile, capability: ACME, agent })).toThrowError(
      expect.objectContaining({
        code: 'AGENT_PROFILE_SERVICE_UNDECLARED',
        // Agent acts: it is our own document that is missing the declaration.
        layer: 'client',
      }) as unknown as Error,
    )
  })
})

// ─── Undeclared-vs-not-offered: the ordering IS the diagnosis ─────────────
//
//   agent declares | business offers | result
//   ---------------|-----------------|---------------------------------
//   no             | yes             | AGENT_PROFILE_SERVICE_UNDECLARED
//   yes            | no              | CAPABILITY_NOT_OFFERED
//   no             | no              | CAPABILITY_NOT_OFFERED
//   yes            | yes             | negotiate

describe('negotiateService — undeclared vs not-offered truth table', () => {
  const SVC = 'com.acme.svc'

  function agentDeclaring(declares: boolean) {
    return agentProfileFixture({
      version: '2026-08-25',
      services: {
        'dev.ucp.shopping': [{ version: '2026-08-25', transport: 'mcp' }],
        ...(declares ? { [SVC]: [{ version: '2025-11-01', transport: 'mcp' }] } : {}),
      },
    })
  }

  function businessOffering(offers: boolean) {
    return business('2026-08-25', {
      'dev.ucp.shopping': [{ version: '2026-08-25', transport: 'mcp' }],
      ...(offers ? { [SVC]: [{ version: '2025-11-01', transport: 'mcp' }] } : {}),
    })
  }

  it('no / yes → AGENT_PROFILE_SERVICE_UNDECLARED', () => {
    expect(() =>
      negotiateService({
        profile: businessOffering(true),
        capability: SVC,
        agent: agentDeclaring(false),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'AGENT_PROFILE_SERVICE_UNDECLARED',
        layer: 'client',
      }) as unknown as Error,
    )
  })

  it('yes / no → CAPABILITY_NOT_OFFERED', () => {
    expect(() =>
      negotiateService({
        profile: businessOffering(false),
        capability: SVC,
        agent: agentDeclaring(true),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'CAPABILITY_NOT_OFFERED',
        layer: 'transport',
      }) as unknown as Error,
    )
  })

  it('no / no → CAPABILITY_NOT_OFFERED: a typo is not a profile problem', () => {
    // `com.typo.svc` exists nowhere. The old ordering said "your profile does
    // not declare it" and sent the user to edit a document that cannot make
    // this call succeed.
    expect(() =>
      negotiateService({
        profile: businessOffering(false),
        capability: 'com.typo.svc',
        agent: agentDeclaring(false),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'CAPABILITY_NOT_OFFERED',
        layer: 'transport',
        context: { capability: 'com.typo.svc', offered: ['dev.ucp.shopping'] },
      }) as unknown as Error,
    )
  })

  it('yes / yes → negotiates', () => {
    expect(
      negotiateService({
        profile: businessOffering(true),
        capability: SVC,
        agent: agentDeclaring(true),
      }),
    ).toMatchObject({ capability: SVC, version: '2025-11-01', transport: 'mcp' })
  })

  it('the undeclared error names BOTH sides, in the message and in context', () => {
    // "Add it to your profile" vs "you typo'd the id" must be decidable
    // without a second round-trip — and `cli.ts` never serializes `context`,
    // so both sets have to survive in the message too.
    let caught: { message: string; context: Record<string, unknown> } | undefined
    try {
      negotiateService({
        profile: businessOffering(true),
        capability: SVC,
        agent: agentDeclaring(false),
      })
    } catch (err) {
      caught = err as { message: string; context: Record<string, unknown> }
    }
    expect(caught?.context).toMatchObject({
      capability: SVC,
      declared: ['dev.ucp.shopping'],
      offered: ['com.acme.svc', 'dev.ucp.shopping'],
    })
    expect(caught?.message).toContain('declared: [dev.ucp.shopping]')
    expect(caught?.message).toContain('business offers: [com.acme.svc, dev.ucp.shopping]')
  })

  it('a fine-grained capability id the business does not offer is CAPABILITY_NOT_OFFERED, with the diagnosis', () => {
    // `dev.ucp.shopping.checkout` is declared — as a CAPABILITY. It is not a
    // service, and the business advertises no such service either, so no
    // profile edit helps. The capability-vs-service mistake still gets named.
    const agent = agentProfileFixture({ version: '2026-08-25' })
    expect(() =>
      negotiateService({
        profile: businessOffering(false),
        capability: 'dev.ucp.shopping.checkout',
        agent,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'CAPABILITY_NOT_OFFERED',
        message: expect.stringContaining('as a capability, not a service') as unknown as string,
      }) as unknown as Error,
    )
  })
})

describe('negotiateService — failure classification', () => {
  it('CAPABILITY_NOT_OFFERED when the business advertises no such service', () => {
    const agent = agentProfileFixture({ version: '2026-08-25' })
    const profile = business('2026-08-25', {
      'dev.ucp.payments': [{ version: '2026-08-25', transport: 'mcp' }],
    })

    expect(() => negotiateService({ profile, capability: 'dev.ucp.shopping', agent })).toThrowError(
      expect.objectContaining({
        code: 'CAPABILITY_NOT_OFFERED',
        layer: 'transport',
        context: { capability: 'dev.ucp.shopping', offered: ['dev.ucp.payments'] },
      }) as unknown as Error,
    )
  })

  it('S9: right version, wrong transport → NO_COMPATIBLE_TRANSPORT naming all three sets', () => {
    const agent = agentProfileFixture({ version: '2026-08-25' })
    const profile = business('2026-08-25', {
      'dev.ucp.shopping': [{ version: '2026-08-25', transport: 'rest' }],
    })

    expect(() => negotiateService({ profile, capability: 'dev.ucp.shopping', agent })).toThrowError(
      expect.objectContaining({
        code: 'NO_COMPATIBLE_TRANSPORT',
        layer: 'transport',
        message:
          "at UCP 2026-08-25, dev.ucp.shopping is offered over [rest]; profile 'agent' declares [mcp]; ucp-cli supports [mcp]",
      }) as unknown as Error,
    )
  })

  it('a2a/embedded at the right version are ineligible, and say so', () => {
    const agent = agentProfileFixture({ version: '2026-08-25' })
    const profile = business('2026-08-25', {
      'dev.ucp.shopping': [
        { version: '2026-08-25', transport: 'a2a' },
        { version: '2026-08-25', transport: 'embedded' },
      ],
    })

    expect(() => negotiateService({ profile, capability: 'dev.ucp.shopping', agent })).toThrowError(
      expect.objectContaining({
        code: 'NO_COMPATIBLE_TRANSPORT',
        context: expect.objectContaining({ offeredTransports: ['a2a', 'embedded'] }) as unknown,
      }) as unknown as Error,
    )
  })

  it('a declared transport ucp-cli cannot execute is quoted but never matched', () => {
    // The profile declares rest; the engine speaks mcp. The message must show
    // the declaration honestly AND the engine constraint that killed it.
    setWarnWriter(() => {}) // loadAgentProfile warns about `rest`; keep it off stderr.
    const agent = agentProfileFixture({
      version: '2026-08-25',
      services: {
        'dev.ucp.shopping': [
          { version: '2026-08-25', transport: 'rest' },
          { version: '2026-08-25', transport: 'mcp' },
        ],
      },
    })
    const profile = business('2026-08-25', {
      'dev.ucp.shopping': [{ version: '2026-08-25', transport: 'rest' }],
    })

    expect(() => negotiateService({ profile, capability: 'dev.ucp.shopping', agent })).toThrowError(
      expect.objectContaining({
        code: 'NO_COMPATIBLE_TRANSPORT',
        message:
          "at UCP 2026-08-25, dev.ucp.shopping is offered over [rest]; profile 'agent' declares [mcp, rest]; ucp-cli supports [mcp]",
      }) as unknown as Error,
    )
  })

  it("S8: dev.ucp.* with no entry at the rendering's own version is a merchant defect", () => {
    const agent = agentProfileFixture({ version: '2026-08-25' })
    const profile = business('2026-08-25', {
      'dev.ucp.shopping': [{ version: '2026-04-08', transport: 'mcp' }],
    })

    expect(() => negotiateService({ profile, capability: 'dev.ucp.shopping', agent })).toThrowError(
      expect.objectContaining({
        code: 'PROFILE_VERSION_MISMATCH',
        layer: 'transport',
        context: expect.objectContaining({
          kind: 'service-entries',
          capability: 'dev.ucp.shopping',
          expected: '2026-08-25',
          offered: ['2026-04-08'],
        }) as unknown,
      }) as unknown as Error,
    )
  })

  it('prefers the transport diagnosis over the merchant-defect one when the version matched', () => {
    // Both an off-version entry and a wrong-transport entry at the right
    // version. The transport rung is more specific, so it wins.
    const agent = agentProfileFixture({ version: '2026-08-25' })
    const profile = business('2026-08-25', {
      'dev.ucp.shopping': [
        { version: '2026-04-08', transport: 'mcp' },
        { version: '2026-08-25', transport: 'rest' },
      ],
    })

    expect(() => negotiateService({ profile, capability: 'dev.ucp.shopping', agent })).toThrowError(
      expect.objectContaining({ code: 'NO_COMPATIBLE_TRANSPORT' }) as unknown as Error,
    )
  })

  it('a service id that collides with Object.prototype does not crash the lookup', () => {
    // Service ids are free-form in the generated schema (json-schema-to-zod
    // drops `propertyNames`), so a broken or hostile business can publish
    // `constructor`. A plain index lookup would inherit a truthy non-array and
    // blow up inside negotiation; both sides use Object.hasOwn.
    const agent = agentProfileFixture({ version: '2026-08-25' })
    const profile = businessSchema20260825.parse({
      ucp: {
        version: '2026-08-25',
        services: { constructor: [entry({ version: '2026-08-25', transport: 'mcp' })] },
        payment_handlers: {},
      },
    })

    // Neither side has a usable declaration for `constructor` in the agent
    // fixture, and the business DOES advertise it — so this is the
    // (no / yes) row: our profile is what is missing.
    expect(() => negotiateService({ profile, capability: 'constructor', agent })).toThrowError(
      expect.objectContaining({ code: 'AGENT_PROFILE_SERVICE_UNDECLARED' }) as unknown as Error,
    )
    // And the mirror case: declared by the profile, absent from the business.
    const declaring = agentProfileFixture({
      version: '2026-08-25',
      services: { constructor: [{ version: '2026-08-25', transport: 'mcp' }] },
    })
    const bare = business('2026-08-25', {
      'dev.ucp.shopping': [{ version: '2026-08-25', transport: 'mcp' }],
    })
    expect(() =>
      negotiateService({ profile: bare, capability: 'constructor', agent: declaring }),
    ).toThrowError(expect.objectContaining({ code: 'CAPABILITY_NOT_OFFERED' }) as unknown as Error)
  })

  it('an empty declaration blames neither side: SERVICE_VERSION_INCOMPATIBLE', () => {
    // A profile that declares the key with no entries has nothing to
    // intersect. Calling that a merchant defect would be a lie.
    //
    // Self-hosted URL: an empty `dev.ucp.shopping` declaration only exists in
    // a document someone edited, and "fix your profile" is the right remedy
    // precisely because they can. Under a release-default URL the same rung
    // reports the published-document defect instead — see the KNOWN SEAM test.
    const agent = agentProfileFixture({
      version: '2026-08-25',
      url: 'https://agent.example.invalid/agent.json',
      services: { 'dev.ucp.shopping': [] },
    })
    const profile = business('2026-08-25', {
      'dev.ucp.shopping': [{ version: '2026-08-25', transport: 'mcp' }],
    })

    expect(() => negotiateService({ profile, capability: 'dev.ucp.shopping', agent })).toThrowError(
      expect.objectContaining({
        code: 'SERVICE_VERSION_INCOMPATIBLE',
        message: "dev.ucp.shopping: profile 'agent' declares [], business offers [2026-08-25]",
      }) as unknown as Error,
    )
  })
})

// ─── Fallout of the AGENT_PROFILE_VERSION_MISMATCH severity split ──────────
//
// `loadAgentProfile` warns-and-proceeds instead of throwing when a PUBLISHED
// (release-default) profile carries a `dev.ucp.*` entry off its own version,
// because a fatal there hard-stops every installed CLI over a document nobody
// local can edit. The premise is that the condition degrades gracefully: an
// off-version entry simply fails to match.
//
// It mostly does — but not perfectly, and this test pins the seam rather than
// leaving it as folklore. When the off-version entry is the ONLY entry for
// that service, negotiation still fails, and it fails with a message whose
// implied remedy ("update the profile") the user cannot perform.
describe('negotiateService — a published profile that warned at load', () => {
  it('degrades to a normal negotiation error when another entry matches', () => {
    setWarnWriter(() => {})
    const body = JSON.parse(RELEASES['2026-08-25'].agentProfileJson) as {
      ucp: Record<string, unknown>
    }
    body.ucp.services = {
      'dev.ucp.shopping': [
        { version: '2026-08-25', transport: 'mcp' },
        { version: '2026-04-08', transport: 'mcp' },
      ],
    }
    const agent = loadAgentProfile({ body, url: RELEASES['2026-08-25'].defaultAgentProfileUrl })
    const profile = business('2026-08-25', {
      'dev.ucp.shopping': [{ version: '2026-08-25', transport: 'mcp' }],
    })
    // The warned-about entry is inert; the matching one wins.
    expect(negotiateService({ profile, capability: 'dev.ucp.shopping', agent }).version).toBe(
      '2026-08-25',
    )
  })

  it('names the PUBLISHER, not the user, when the off-version entry is the only one', () => {
    setWarnWriter(() => {})
    const body = JSON.parse(RELEASES['2026-08-25'].agentProfileJson) as {
      ucp: Record<string, unknown>
    }
    body.ucp.services = { 'dev.ucp.shopping': [{ version: '2026-04-08', transport: 'mcp' }] }
    const url = RELEASES['2026-08-25'].defaultAgentProfileUrl
    const agent = loadAgentProfile({ body, url })
    const profile = business('2026-08-25', {
      'dev.ucp.shopping': [{ version: '2026-08-25', transport: 'mcp' }],
    })

    // The BEHAVIOR is the seam described above: this negotiation fails rather
    // than degrading. Keeping it that way is deliberate — a pre-flight fatal
    // would break every business, including the ones where the defect is
    // irrelevant. The remedy must never say "update your profile" about a
    // document the reader cannot edit: under a release-default URL
    // `SERVICE_VERSION_INCOMPATIBLE` names the publisher's defect and points
    // at the one action that IS available — self-host a corrected copy.
    //
    // The gate is `isReleaseDefaultProfileUrl`, and it is safe to be that
    // coarse: with a healthy published profile this rung is unreachable for a
    // `dev.ucp.*` service (the merchant-defect rung above catches the
    // contradiction first), and published profiles declare no third-party
    // services. So a release-default URL here means the published document.
    let thrown: { code?: string; message?: string; context?: unknown } | undefined
    try {
      negotiateService({ profile, capability: 'dev.ucp.shopping', agent })
    } catch (err) {
      thrown = err as { code?: string; message?: string; context?: unknown }
    }
    expect(thrown?.code).toBe('SERVICE_VERSION_INCOMPATIBLE')
    expect(thrown?.message).toContain(`the published agent profile at ${url}`)
    expect(thrown?.message).toContain('not something you can edit')
    expect(thrown?.message).toContain('--profile-url')
    // The old copy sent the reader to edit a file they do not own.
    expect(thrown?.message).not.toMatch(/update (your|the) profile/i)
    expect(thrown?.context).toMatchObject({ agentProfilePublished: true })
  })

  it('leaves a SELF-HOSTED profile pointed at the user, with no publisher blame', () => {
    // The mirror of the case above, reached the only way it CAN be reached
    // for a self-hosted profile: a third-party service whose version lines do
    // not meet. (The off-version `dev.ucp.*` shape above is unreachable here —
    // `loadAgentProfile` makes that fatal for a self-hosted profile, precisely
    // because the user can fix it.) Here "declares […], business offers […]"
    // is the whole story: no publisher blame, and no self-hosting advice the
    // reader has already taken.
    const agent = agentProfileFixture({
      version: '2026-08-25',
      url: 'https://agent.example.invalid/agent.json',
      name: 'mine',
      services: {
        'dev.ucp.shopping': [{ version: '2026-08-25', transport: 'mcp' }],
        'com.acme.svc': [{ version: '2025-11-01', transport: 'mcp' }],
      },
    })
    const profile = business('2026-08-25', {
      'com.acme.svc': [{ version: '2025-06-01', transport: 'mcp' }],
    })

    let thrown: { code?: string; message?: string; context?: unknown } | undefined
    try {
      negotiateService({ profile, capability: 'com.acme.svc', agent })
    } catch (err) {
      thrown = err as { code?: string; message?: string; context?: unknown }
    }
    expect(thrown?.code).toBe('SERVICE_VERSION_INCOMPATIBLE')
    expect(thrown?.message).toBe(
      "com.acme.svc: profile 'mine' declares [2025-11-01], business offers [2025-06-01]",
    )
    expect(thrown?.message).not.toContain('published')
    expect(thrown?.context).toMatchObject({ agentProfilePublished: false })
  })
})
