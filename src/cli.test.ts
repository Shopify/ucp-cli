// CLI command wiring tests.
//
// These tests run the real incur dispatcher with injected core dependencies.
// Network behavior stays in core tests; this file pins command grammar,
// dependency wiring, and JSON-default output.
//
// Resolution chain tests (last describe block) cover the `--business` flag
// vs `UCP_BUSINESS` env vs `~/.ucp/active.yaml` precedence and the
// BUSINESS_NOT_RESOLVED error+CTA produced when none resolve. The session
// resolver itself is stubbed; we're verifying the wiring, not the resolver.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import type { ResolvedSession, ResolveSessionOptions } from './cli/session.js'
import { createUcpCli, isSkillsAddInvocation } from './cli.js'
import { setVerboseWriter } from './core/verbose.js'
import { serveCli } from './test-utils.js'

const PROFILE_URL = 'https://agent.example.com/.well-known/ucp'

// Resolver stub used in passing-path tests below: echoes whatever business
// the caller passed via `opts.business` (i.e. the resolved chain landed at
// the flag) and returns a fixed initialized local profile. Resolution-chain tests
// (separate describe block) use a different stub that simulates env /
// active.yaml legs.
const passthroughSession = async (opts: ResolveSessionOptions = {}): Promise<ResolvedSession> => ({
  profile: { name: 'agent', profileUrl: PROFILE_URL },
  ...(opts.business !== undefined ? { business: opts.business } : {}),
})

describe('createUcpCli', () => {
  it('defaults command output to JSON', async () => {
    const calls: unknown[] = []
    const cli = createUcpCli({
      discover: async (...args) => {
        calls.push(args)
        return {
          business: args[0],
          profile: {
            ucp: { version: '2026-04-08', status: 'success', services: {}, payment_handlers: {} },
          },
          negotiated: {},
        }
      },
      resolveSession: passthroughSession,
    })

    const { output, exitCode } = await serveCli(cli, ['discover', 'https://shop.example.com'])
    expect(exitCode).toBe(0)
    // serveCli captures incur's default JSON writer output, which is the
    // inner payload that we hand to `c.ok`. The full `{ok, data, meta}` shape
    // is only assembled by incur in non-default formats. Discover's payload
    // is the bare `{ result: discoverResult }` shape — no dispatch identity
    // since discover negotiates many capabilities at once.
    expect(JSON.parse(output)).toMatchObject({
      result: { business: 'https://shop.example.com', negotiated: {} },
    })
    expect(calls).toEqual([['https://shop.example.com', { force: false, profileUrl: PROFILE_URL }]])
  })

  it('wires catalog search args and options to the search helper', async () => {
    const calls: unknown[] = []
    const cli = createUcpCli({
      resolveSession: passthroughSession,
      searchCatalog: async (...args) => {
        calls.push(args)
        return { products: [{ title: 'Snow boots' }] }
      },
    })

    const { output, exitCode } = await serveCli(cli, [
      'catalog',
      'search',
      '--business',
      'https://shop.example.com',
      '--set',
      '/query=boots',
      '--set',
      '/pagination/limit=2',
      '--refresh',
    ])

    expect(exitCode).toBe(0)
    // Dispatch ops stamp business/endpoint/transport at the envelope level —
    // value-comparable dispatch identity (vs naming a "source" flag).
    // Server response was `{products}`, so hoistUcp parks it under `result`.
    expect(JSON.parse(output)).toMatchObject({
      business: 'https://shop.example.com',
      result: { products: [{ title: 'Snow boots' }] },
    })
    // `_onDiscover` is an internal-only side-channel (see operation.ts);
    // assert the user-facing options shape via toMatchObject so the test
    // doesn't grow a dependency on the internal callback's presence.
    expect(calls).toMatchObject([
      [
        'https://shop.example.com',
        { catalog: { query: 'boots', pagination: { limit: 2 } } },
        { force: true, profileUrl: PROFILE_URL },
      ],
    ])
  })

  it('still honors explicit non-JSON formats through incur', async () => {
    const cli = createUcpCli({
      resolveSession: passthroughSession,
      searchCatalog: async () => ({ products: [] }),
    })

    const { output, exitCode } = await serveCli(cli, [
      'catalog',
      'search',
      '--business',
      'https://shop.example.com',
      '--set',
      '/query=boots',
      '--format',
      'toon',
    ])

    expect(exitCode).toBe(0)
    expect(output).toContain('products')
    expect(() => JSON.parse(output)).toThrow()
  })

  it('accepts --input as the JSON payload source', async () => {
    const calls: unknown[] = []
    const cli = createUcpCli({
      resolveSession: passthroughSession,
      searchCatalog: async (...args) => {
        calls.push(args)
        return { products: [] }
      },
    })

    const { exitCode } = await serveCli(cli, [
      'catalog',
      'search',
      '--business',
      'https://shop.example.com',
      '--input',
      '{"query":"boots"}',
    ])

    expect(exitCode).toBe(0)
    expect(calls).toMatchObject([
      [
        'https://shop.example.com',
        { catalog: { query: 'boots' } },
        { force: false, profileUrl: PROFILE_URL },
      ],
    ])
  })

  it('checkout create treats cart_id as a checkout body field', async () => {
    const calls: unknown[] = []
    const cli = createUcpCli({
      resolveSession: passthroughSession,
      createCheckout: async (...args) => {
        calls.push(args)
        return { id: 'chk_1' }
      },
    })

    const { exitCode } = await serveCli(cli, [
      'checkout',
      'create',
      '--business',
      'https://shop.example.com',
      '--input',
      '{"cart_id":"cart_1","line_items":[]}',
    ])

    expect(exitCode).toBe(0)
    expect(calls).toMatchObject([
      [
        'https://shop.example.com',
        { checkout: { cart_id: 'cart_1', line_items: [] } },
        { force: false, profileUrl: PROFILE_URL },
      ],
    ])
  })

  it('checkout create preserves cart_id with supplied checkout fields and lets schema/server decide conflicts', async () => {
    const calls: unknown[] = []
    const cli = createUcpCli({
      resolveSession: passthroughSession,
      createCheckout: async (...args) => {
        calls.push(args)
        return { id: 'chk_1' }
      },
    })

    const { exitCode } = await serveCli(cli, [
      'checkout',
      'create',
      '--business',
      'https://shop.example.com',
      '--input',
      '{"cart_id":"cart_1","line_items":[{"item":{"id":"variant_1"},"quantity":1}],"buyer":{"email":"b@example.com"}}',
    ])

    expect(exitCode).toBe(0)
    expect(calls).toMatchObject([
      [
        'https://shop.example.com',
        {
          checkout: {
            cart_id: 'cart_1',
            line_items: [{ item: { id: 'variant_1' }, quantity: 1 }],
            buyer: { email: 'b@example.com' },
          },
        },
        { force: false, profileUrl: PROFILE_URL },
      ],
    ])
  })
})

describe('createUcpCli — business resolution', () => {
  // Simulate active.yaml-bound and unbound sessions by returning what the
  // resolver itself would return: with/without `business` based on whether
  // a value was provided via the option (or by the stub itself for the
  // env/active.yaml leg).
  const stubSession =
    (sessionBusiness?: string) =>
    async (opts: ResolveSessionOptions = {}): Promise<ResolvedSession> => {
      const profile = { name: 'agent', profileUrl: PROFILE_URL }
      const business = opts.business ?? sessionBusiness
      return business !== undefined ? { profile, business } : { profile }
    }

  it('uses --business flag when provided (op command)', async () => {
    const calls: unknown[] = []
    const cli = createUcpCli({
      resolveSession: stubSession('https://session.example.com'),
      searchCatalog: async (...args) => {
        calls.push(args)
        return { products: [] }
      },
    })
    const { exitCode } = await serveCli(cli, [
      'catalog',
      'search',
      '--business',
      'https://flag.example.com',
    ])
    expect(exitCode).toBe(0)
    expect(calls[0]).toMatchObject([
      'https://flag.example.com',
      { catalog: {} },
      { force: false, profileUrl: PROFILE_URL },
    ])
  })

  it('falls back to session business when --business is omitted', async () => {
    const calls: unknown[] = []
    const cli = createUcpCli({
      resolveSession: stubSession('https://session.example.com'),
      searchCatalog: async (...args) => {
        calls.push(args)
        return { products: [] }
      },
    })
    const { exitCode } = await serveCli(cli, ['catalog', 'search'])
    expect(exitCode).toBe(0)
    expect(calls[0]).toMatchObject([
      'https://session.example.com',
      { catalog: {} },
      { force: false, profileUrl: PROFILE_URL },
    ])
  })

  it('rejects user-provided meta before dispatch because meta is protocol-owned', async () => {
    const cli = createUcpCli({
      resolveSession: stubSession('https://session.example.com'),
      searchCatalog: async () => {
        throw new Error('helper should not be called when input owns meta')
      },
    })

    const { output, exitCode } = await serveCli(cli, [
      'catalog',
      'search',
      '--input',
      '{"meta":{"idempotency-key":"user-owned"}}',
    ])

    expect(exitCode).toBe(1)
    const parsed = JSON.parse(output)
    expect(parsed.code).toBe('INVALID_INPUT')
    expect(parsed.message).toMatch(/cannot set meta/)
  })

  it('emits BUSINESS_NOT_RESOLVED with a CTA when nothing resolves (op command)', async () => {
    const cli = createUcpCli({
      resolveSession: stubSession(undefined),
      searchCatalog: async () => {
        throw new Error('helper should not be called when resolution fails')
      },
    })
    const { output, exitCode } = await serveCli(cli, ['catalog', 'search'])
    expect(exitCode).toBe(1)
    const parsed = JSON.parse(output)
    expect(parsed.code).toBe('BUSINESS_NOT_RESOLVED')
    // CTA is the recovery hint agents grep for. Both `ucp use` and
    // `--business` paths must be advertised so agents can pick the form
    // that matches their flow.
    expect(parsed.cta?.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: expect.stringContaining('ucp use') }),
        expect.objectContaining({ command: expect.stringContaining('--business') }),
      ]),
    )
  })

  it('discover: positional <business> overrides session', async () => {
    const calls: unknown[] = []
    const cli = createUcpCli({
      resolveSession: stubSession('https://session.example.com'),
      discover: async (...args) => {
        calls.push(args)
        return { business: args[0], profile: {}, negotiated: {} } as never
      },
    })
    const { exitCode } = await serveCli(cli, ['discover', 'https://positional.example.com'])
    expect(exitCode).toBe(0)
    expect(calls[0]).toMatchObject([
      'https://positional.example.com',
      { force: false, profileUrl: PROFILE_URL },
    ])
  })

  it('discover: falls back to session business when positional is omitted', async () => {
    const calls: unknown[] = []
    const cli = createUcpCli({
      resolveSession: stubSession('https://session.example.com'),
      discover: async (...args) => {
        calls.push(args)
        return { business: args[0], profile: {}, negotiated: {} } as never
      },
    })
    const { exitCode } = await serveCli(cli, ['discover'])
    expect(exitCode).toBe(0)
    expect(calls[0]).toMatchObject([
      'https://session.example.com',
      { force: false, profileUrl: PROFILE_URL },
    ])
  })

  it('discover: emits BUSINESS_NOT_RESOLVED with CTA when nothing resolves', async () => {
    const cli = createUcpCli({
      resolveSession: stubSession(undefined),
      discover: async () => {
        throw new Error('discover should not be called when resolution fails')
      },
    })
    const { output, exitCode } = await serveCli(cli, ['discover'])
    expect(exitCode).toBe(1)
    const parsed = JSON.parse(output)
    expect(parsed.code).toBe('BUSINESS_NOT_RESOLVED')
    expect(parsed.cta?.commands?.length).toBeGreaterThan(0)
  })
})

describe('createUcpCli — catalog fallback (meta.defaults.catalog)', () => {
  // Business origin URL — discovery hits <CATALOG_URL>/.well-known/ucp on
  // the normal `discover()` path; there is no longer a bypass.
  const CATALOG_URL = 'https://catalog.example.invalid'
  // Resolver stub that produces a user profile carrying `defaults.catalog`.
  // Mirrors what `resolveSession` builds for a real user profile after
  // `ucp profile init --catalog <url>` lands. Business stays unresolved so
  // the fallback rung is the only path through.
  const stubSessionWithCatalogDefault = async (
    _opts: ResolveSessionOptions = {},
  ): Promise<ResolvedSession> => ({
    profile: {
      name: 'with-catalog',
      profileUrl: PROFILE_URL,
      meta: {
        created_at: '2026-05-10T00:00:00Z',
        defaults: { catalog: CATALOG_URL },
      },
    },
  })

  it('catalog search with no business routes through defaults.catalog', async () => {
    const helperCalls: unknown[] = []
    const cli = createUcpCli({
      resolveSession: stubSessionWithCatalogDefault,
      searchCatalog: async (...args) => {
        helperCalls.push(args)
        return { products: [{ title: 'Snow boots' }] }
      },
    })
    const { output, exitCode } = await serveCli(cli, ['catalog', 'search'])
    expect(exitCode).toBe(0)
    // Catalog fallback path — dispatch identity stamped at envelope, server's
    // products payload nested under `result`. The envelope's `business` echoes
    // the canonical business origin — same whether the agent passed a bare
    // host, full origin, or relied on the catalog default.
    expect(JSON.parse(output)).toMatchObject({
      business: CATALOG_URL,
      result: { products: [{ title: 'Snow boots' }] },
    })
    // Helper receives the catalog business URL — discover() then fetches
    // `<url>/.well-known/ucp` on the normal path (no bypass).
    expect(helperCalls[0]).toMatchObject([
      CATALOG_URL,
      { catalog: {} },
      { force: false, profileUrl: PROFILE_URL },
    ])
  })

  it('cart create with no business still errors even when defaults.catalog is set', async () => {
    // Load-bearing gate: state-mutating ops MUST NOT silently misroute to
    // the catalog default just because one exists. When a "global cart"
    // arrives, we add a separate `defaults.cart` rung, not a generalization
    // of this one.
    const cli = createUcpCli({
      resolveSession: stubSessionWithCatalogDefault,
      createCart: async () => {
        throw new Error('cart helper must not fire when business is unresolved')
      },
    })
    const { output, exitCode } = await serveCli(cli, ['cart', 'create'])
    expect(exitCode).toBe(1)
    const parsed = JSON.parse(output)
    expect(parsed.code).toBe('BUSINESS_NOT_RESOLVED')
  })

  it('catalog --input-schema with no business routes through defaults.catalog', async () => {
    const discoverCalls: unknown[] = []
    const cli = createUcpCli({
      resolveSession: stubSessionWithCatalogDefault,
      discover: async (...args) => {
        discoverCalls.push(args)
        return {
          business: args[0] ?? '',
          profile: {
            ucp: {
              version: '2026-04-08',
              status: 'success' as const,
              services: {},
              payment_handlers: {},
            },
          },
          negotiated: {
            'dev.ucp.shopping': {
              capability: 'dev.ucp.shopping',
              version: '2026-04-08',
              transport: 'mcp' as const,
              endpoint: args[0] ?? '',
              tools: {
                search_catalog: {
                  name: 'search_catalog',
                  description: 'Find products',
                  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
                },
              },
            },
          },
        } as never
      },
    })
    const { exitCode } = await serveCli(cli, ['catalog', 'search', '--input-schema'])
    expect(exitCode).toBe(0)
    expect(discoverCalls[0]).toMatchObject([
      CATALOG_URL,
      expect.objectContaining({ profileUrl: PROFILE_URL }),
    ])
    const firstCall = discoverCalls[0] as unknown[]
    expect(firstCall[1] as Record<string, unknown>).not.toHaveProperty('directEndpoint')
  })

  it('bare `ucp discover` with no business routes through defaults.catalog', async () => {
    // Read-only introspection: bare `discover` has no op family, so the gate
    // is "command is read-only" rather than "bodyKey === 'catalog'". Agents
    // that introspect with no business in scope see the catalog tools
    // instead of a recovery dead-end. No capabilities filter — surface every
    // capability the catalog advertises.
    const discoverCalls: unknown[] = []
    const cli = createUcpCli({
      resolveSession: stubSessionWithCatalogDefault,
      discover: async (...args) => {
        discoverCalls.push(args)
        return { business: args[0] ?? '', profile: {}, negotiated: {} } as never
      },
    })
    const { exitCode } = await serveCli(cli, ['discover'])
    expect(exitCode).toBe(0)
    expect(discoverCalls[0]).toMatchObject([
      CATALOG_URL,
      expect.objectContaining({ profileUrl: PROFILE_URL }),
    ])
    const firstCall = discoverCalls[0] as unknown[]
    const opts = firstCall[1] as Record<string, unknown>
    expect(opts).not.toHaveProperty('directEndpoint')
    expect(opts).not.toHaveProperty('capabilities')
  })

  it('catalog search with no business AND no defaults.catalog still errors', async () => {
    // No meta → optional-chain returns undefined and the fallback never
    // fires. This is the init-CTA path (BUSINESS_NOT_RESOLVED with
    // machine-actionable recovery hint).
    const cli = createUcpCli({
      resolveSession: async () => ({ profile: { name: 'agent', profileUrl: PROFILE_URL } }),
      searchCatalog: async () => {
        throw new Error('helper should not fire without a resolved business')
      },
    })
    const { output, exitCode } = await serveCli(cli, ['catalog', 'search'])
    expect(exitCode).toBe(1)
    expect(JSON.parse(output).code).toBe('BUSINESS_NOT_RESOLVED')
  })

  it('--business flag still overrides the catalog default when both are present', async () => {
    // Precedence is unchanged: flag wins. The fallback is a *last* rung, not
    // a replacement for the explicit business signal.
    const helperCalls: unknown[] = []
    const cli = createUcpCli({
      // Reproduce the env-override behavior: when `--business` is passed,
      // the resolver returns the flag value as `session.business`.
      resolveSession: async (opts: ResolveSessionOptions = {}) => {
        const base: ResolvedSession = {
          profile: {
            name: 'with-catalog',
            profileUrl: PROFILE_URL,
            meta: {
              created_at: '2026-05-10T00:00:00Z',
              defaults: { catalog: CATALOG_URL },
            },
          },
        }
        return opts.business !== undefined ? { ...base, business: opts.business } : base
      },
      searchCatalog: async (...args) => {
        helperCalls.push(args)
        return { products: [] }
      },
    })
    const { exitCode } = await serveCli(cli, [
      'catalog',
      'search',
      '--business',
      'https://flag.example.com',
    ])
    expect(exitCode).toBe(0)
    // Flag wins; helper receives the flag URL, not the catalog default.
    expect(helperCalls[0]).toMatchObject([
      'https://flag.example.com',
      { catalog: {} },
      { force: false, profileUrl: PROFILE_URL },
    ])
  })

  // CTA shape on BUSINESS_NOT_RESOLVED. The wiring tests above prove the
  // fallback fires when `defaults.catalog` is set; these prove the recovery
  // hint is machine-actionable when it isn't. The init CTA is gated on
  // catalog-eligible contexts only (catalog ops + bare `discover` — both
  // would have routed through the fallback rung). Non-catalog ops keep the
  // unmodified CTA so we don't suggest a fix that wouldn't apply.
  const stubSessionNoMeta = async (
    _opts: ResolveSessionOptions = {},
  ): Promise<ResolvedSession> => ({
    profile: { name: 'agent', profileUrl: PROFILE_URL },
  })

  // BUSINESS_NOT_RESOLVED CTA is uniform across op families: bind a business
  // via `ucp use` or `--business`. No `--catalog` init rung — catalog ops on
  // initialized profiles can resolve via `meta.defaults.catalog`, so this
  // error only fires for non-catalog ops or user profiles that opted out.

  it('catalog op on a user profile WITHOUT defaults.catalog: error CTA has no profile-init rung', async () => {
    const cli = createUcpCli({
      resolveSession: stubSessionNoMeta,
      searchCatalog: async () => {
        throw new Error('helper must not fire without a resolved business')
      },
    })
    const { output, exitCode } = await serveCli(cli, ['catalog', 'search'])
    expect(exitCode).toBe(1)
    const parsed = JSON.parse(output)
    expect(parsed.code).toBe('BUSINESS_NOT_RESOLVED')
    const commands = (parsed.cta?.commands ?? []) as Array<{ command: string }>
    expect(commands.some((cmd) => cmd.command.includes('ucp profile init'))).toBe(false)
    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: expect.stringContaining('ucp use') }),
        expect.objectContaining({ command: expect.stringContaining('--business') }),
      ]),
    )
  })

  it('bare `discover` on a user profile WITHOUT defaults.catalog: error CTA has no profile-init rung', async () => {
    const cli = createUcpCli({
      resolveSession: stubSessionNoMeta,
      discover: async () => {
        throw new Error('discover must not fire without a resolved business')
      },
    })
    const { output, exitCode } = await serveCli(cli, ['discover'])
    expect(exitCode).toBe(1)
    const parsed = JSON.parse(output)
    expect(parsed.code).toBe('BUSINESS_NOT_RESOLVED')
    const commands = (parsed.cta?.commands ?? []) as Array<{ command: string }>
    expect(commands.some((cmd) => cmd.command.includes('ucp profile init'))).toBe(false)
  })

  it('non-catalog op (cart) on a profile without bound business: same baseline CTA', async () => {
    const cli = createUcpCli({
      resolveSession: stubSessionNoMeta,
      createCart: async () => {
        throw new Error('helper must not fire without a resolved business')
      },
    })
    const { output, exitCode } = await serveCli(cli, ['cart', 'create'])
    expect(exitCode).toBe(1)
    const parsed = JSON.parse(output)
    expect(parsed.code).toBe('BUSINESS_NOT_RESOLVED')
    const commands = (parsed.cta?.commands ?? []) as Array<{ command: string }>
    expect(commands.some((cmd) => cmd.command.includes('ucp profile init'))).toBe(false)
    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: expect.stringContaining('ucp use') }),
        expect.objectContaining({ command: expect.stringContaining('--business') }),
      ]),
    )
  })
})

// End-to-end test that the `_onDiscover` side-channel flows from helper to
// buildCta, and that the allowlist filter (`allowlistedExtensions` in
// cli.ts) correctly intersects business-advertised capabilities with
// `DEFAULT_AGENT_CAPABILITY_IDS` (the bundled agent profile's capabilities).
// The test feeds a synthetic DiscoveredBusiness through the helper stub and
// asserts the emitted CTA description carries the extension hint copy.
describe('createUcpCli — extension-hint pipeline (negotiated → allowlist → CTA)', () => {
  const PROFILE_URL_LOCAL = 'https://agent.example.com/.well-known/ucp'

  // Synthetic DiscoveredBusiness with the catalog-global extension advertised
  // in capabilities (the TRUSTED, schema-parsed view of what the business
  // published at /.well-known/ucp).
  function discoveredWithExtension(extensions: string[]) {
    const capabilities: Record<string, unknown[]> = {}
    for (const ext of extensions) capabilities[ext] = [{ version: '2026-04-08' }]
    return {
      business: 'https://shop.example.com',
      profile: {
        ucp: {
          version: '2026-04-08',
          status: 'success' as const,
          services: {},
          payment_handlers: {},
          capabilities,
        },
      },
      negotiated: {},
    } as never // shape is structurally correct; type union from generated zod is heavy
  }

  it('catalog search: allowlisted extension flows from _onDiscover → CTA hint', async () => {
    const cli = createUcpCli({
      resolveSession: async () => ({
        profile: { name: 'agent', profileUrl: PROFILE_URL_LOCAL },
        business: 'https://shop.example.com',
        businessSource: 'flag',
      }),
      searchCatalog: async (_business, _input, options) => {
        // Helper fires the side-channel as `callOperation` would.
        options._onDiscover?.(discoveredWithExtension(['dev.shopify.catalog.global']))
        return { products: [{ id: 'p1' }] }
      },
    })
    const { output, exitCode } = await serveCli(cli, ['catalog', 'search'])
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(output)
    expect(parsed.cta?.description).toMatch(/Extensions:/)
    expect(parsed.cta?.description).toMatch(/global catalog active/)
  })

  it('non-allowlisted capability does NOT leak into the CTA description', async () => {
    // Even though the business advertises an unknown capability, the
    // build-time allowlist drops it BEFORE it reaches the CTA layer.
    const cli = createUcpCli({
      resolveSession: async () => ({
        profile: { name: 'agent', profileUrl: PROFILE_URL_LOCAL },
        business: 'https://shop.example.com',
        businessSource: 'flag',
      }),
      searchCatalog: async (_business, _input, options) => {
        options._onDiscover?.(
          discoveredWithExtension(['evil.example.com.tracker', 'random.unknown.extension']),
        )
        return { products: [{ id: 'p1' }] }
      },
    })
    const { output, exitCode } = await serveCli(cli, ['catalog', 'search'])
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(output)
    expect(parsed.cta?.description).not.toMatch(/Extensions:/)
    expect(parsed.cta?.description).not.toMatch(/evil\.example\.com/)
  })

  it('mixed advertised: only allowlisted entries reach the CTA', async () => {
    const cli = createUcpCli({
      resolveSession: async () => ({
        profile: { name: 'agent', profileUrl: PROFILE_URL_LOCAL },
        business: 'https://shop.example.com',
        businessSource: 'flag',
      }),
      searchCatalog: async (_business, _input, options) => {
        options._onDiscover?.(
          discoveredWithExtension(['dev.shopify.catalog.global', 'evil.example.com.tracker']),
        )
        return { products: [{ id: 'p1' }] }
      },
    })
    const { output, exitCode } = await serveCli(cli, ['catalog', 'search'])
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(output)
    expect(parsed.cta?.description).toMatch(/global catalog active/)
    expect(parsed.cta?.description).not.toMatch(/evil\.example\.com/)
  })
})

// `--input-schema` is the agent's introspection lever: it short-circuits
// before tools/call and returns the operation input schema. Tests verify the
// short-circuit triggers (helper not invoked), discover is asked only for
// the relevant capability, the response surfaces the inputSchema for the
// right tool, and failure paths reuse the same wire codes as dispatch.
describe('createUcpCli — --input-schema', () => {
  // Discover stub builder. Returns one negotiated capability with the
  // tools the test cares about. Other tests can pass `tools: {}` to
  // simulate a business that doesn't expose the requested tool.
  const stubDiscover =
    (tools: Record<string, { name: string; description?: string; inputSchema: unknown }>) =>
    async (..._args: Parameters<typeof import('./core/discover.js').discover>) =>
      ({
        business: _args[0] ?? '',
        profile: {
          ucp: {
            version: '2026-04-08',
            status: 'success' as const,
            services: {},
            payment_handlers: {},
          },
        },
        negotiated: {
          'dev.ucp.shopping': {
            capability: 'dev.ucp.shopping',
            version: '2026-04-08',
            transport: 'mcp' as const,
            endpoint: 'https://shop.example.com/mcp',
            tools,
          },
        },
      }) as never

  it('returns the operation input schema and skips dispatch on --input-schema', async () => {
    const wireInputSchema = {
      type: 'object',
      properties: { catalog: { type: 'object', properties: { query: { type: 'string' } } } },
      required: ['catalog'],
    }
    const cliInputSchema = { type: 'object', properties: { query: { type: 'string' } } }
    const helperCalls: unknown[] = []
    const cli = createUcpCli({
      resolveSession: passthroughSession,
      discover: stubDiscover({
        search_catalog: {
          name: 'search_catalog',
          description: 'Search a catalog',
          inputSchema: wireInputSchema,
        },
      }),
      searchCatalog: async (...args) => {
        helperCalls.push(args)
        return { products: [] }
      },
    })

    const { output, exitCode } = await serveCli(cli, [
      'catalog',
      'search',
      '--business',
      'https://shop.example.com',
      '--input-schema',
    ])

    expect(exitCode).toBe(0)
    // Helper must not run — describe short-circuits before tools/call so
    // agents never see a side-effecting RPC just for introspection.
    expect(helperCalls).toEqual([])
    const parsed = JSON.parse(output)
    // --input-schema stamps full dispatch identity (business/endpoint/transport) at
    // the envelope level; `result` carries the negotiated capability + tool view.
    expect(parsed).toMatchObject({
      business: 'https://shop.example.com',
      transport: 'mcp',
      endpoint: 'https://shop.example.com/mcp',
      result: {
        capability: 'dev.ucp.shopping',
        version: '2026-04-08',
        tool: {
          name: 'search_catalog',
          description: 'Search a catalog',
          inputSchema: cliInputSchema,
        },
      },
    })
  })

  it('projects create_checkout --input-schema to checkout body fields only', async () => {
    const cli = createUcpCli({
      resolveSession: passthroughSession,
      discover: stubDiscover({
        create_checkout: {
          name: 'create_checkout',
          inputSchema: {
            type: 'object',
            required: ['checkout'],
            properties: {
              checkout: {
                type: 'object',
                required: ['line_items'],
                properties: {
                  cart_id: { type: 'string', description: 'Existing cart to convert' },
                  line_items: { type: 'array' },
                  buyer: { type: 'object' },
                },
              },
              meta: { type: 'object' },
            },
          },
        },
      }),
      createCheckout: async () => {
        throw new Error('helper should not be called when --input-schema is set')
      },
    })

    const { output, exitCode } = await serveCli(cli, [
      'checkout',
      'create',
      '--business',
      'https://shop.example.com',
      '--input-schema',
    ])

    expect(exitCode).toBe(0)
    const parsed = JSON.parse(output)
    expect(parsed.result.tool.inputSchema).toMatchObject({
      type: 'object',
      required: ['line_items'],
      properties: {
        cart_id: { type: 'string', description: 'Existing cart to convert' },
        line_items: { type: 'array' },
        buyer: { type: 'object' },
      },
    })
    expect(parsed.result.tool.inputSchema.properties.checkout).toBeUndefined()
    expect(parsed.result.tool.inputSchema.properties.meta).toBeUndefined()
  })

  it('forwards --refresh to discover so agents can bypass stale tools/list', async () => {
    const discoverArgs: unknown[] = []
    const cli = createUcpCli({
      resolveSession: passthroughSession,
      discover: async (...args) => {
        discoverArgs.push(args)
        return (await stubDiscover({
          search_catalog: { name: 'search_catalog', inputSchema: { type: 'object' } },
        })(...args)) as never
      },
      searchCatalog: async () => ({}),
    })

    const { exitCode } = await serveCli(cli, [
      'catalog',
      'search',
      '--business',
      'https://shop.example.com',
      '--input-schema',
      '--refresh',
    ])

    expect(exitCode).toBe(0)
    expect(discoverArgs[0]).toMatchObject([
      'https://shop.example.com',
      { capabilities: ['dev.ucp.shopping'], force: true, profileUrl: PROFILE_URL },
    ])
  })

  it('emits OPERATION_NOT_OFFERED when the business does not expose the tool', async () => {
    const cli = createUcpCli({
      resolveSession: passthroughSession,
      // Business advertises shopping but only the lookup tool — search is missing.
      discover: stubDiscover({
        lookup_catalog: { name: 'lookup_catalog', inputSchema: { type: 'object' } },
      }),
      searchCatalog: async () => {
        throw new Error('helper should not be called when --input-schema is set')
      },
    })

    const { output, exitCode } = await serveCli(cli, [
      'catalog',
      'search',
      '--business',
      'https://shop.example.com',
      '--input-schema',
    ])

    expect(exitCode).toBe(1)
    const parsed = JSON.parse(output)
    expect(parsed.code).toBe('OPERATION_NOT_OFFERED')
    // Wire envelope today carries code+message only; #75 will surface
    // `context.offered`. The message itself names the missing tool, which
    // is enough to verify the right code path fired.
    expect(parsed.message).toMatch(/search_catalog/)
  })

  it('emits BUSINESS_NOT_RESOLVED with CTA when no business resolves', async () => {
    const cli = createUcpCli({
      // Stub session resolves nothing — no flag, no env, no active.yaml.
      resolveSession: async () => ({ profile: { name: 'agent', profileUrl: PROFILE_URL } }),
      discover: async () => {
        throw new Error('discover should not be called when business is unresolved')
      },
    })

    const { output, exitCode } = await serveCli(cli, ['catalog', 'search', '--input-schema'])
    expect(exitCode).toBe(1)
    const parsed = JSON.parse(output)
    expect(parsed.code).toBe('BUSINESS_NOT_RESOLVED')
    expect(parsed.cta?.commands?.length).toBeGreaterThan(0)
  })

  it('SCHEMA_VALIDATION_FAILED surfaces a wire cta pointing at --input-schema', async () => {
    // Helper throws as if the dispatcher caught a schema mismatch. The
    // top-level middleware should re-emit via c.error so the cta lands on
    // the wire envelope (incur strips cta from thrown errors). The cta
    // command must be copy-pasteable verbatim — i.e. include the exact
    // command path the user just ran (`ucp catalog search`), not a generic
    // `<command>` placeholder.
    const cli = createUcpCli({
      resolveSession: passthroughSession,
      searchCatalog: async () => {
        throw new (await import('./lib/errors.js')).UcpError({
          layer: 'client',
          code: 'SCHEMA_VALIDATION_FAILED',
          message:
            'operation input failed schema validation for "search_catalog": <root>: must have required property catalog',
          context: { schema: { type: 'object' } },
        })
      },
    })

    const { output, exitCode } = await serveCli(cli, [
      'catalog',
      'search',
      '--business',
      'https://shop.example.com',
    ])
    expect(exitCode).toBe(1)
    const parsed = JSON.parse(output)
    expect(parsed.code).toBe('SCHEMA_VALIDATION_FAILED')
    expect(parsed.cta?.commands?.[0]?.command).toBe('ucp catalog search --input-schema')
  })

  it('non-SCHEMA UcpError passes through middleware unchanged', async () => {
    // Sanity: the middleware narrowly targets SCHEMA_VALIDATION_FAILED. A
    // different UcpError code (here MCP_INVALID_RESPONSE, picked because
    // it has no recovery path the CLI knows about) should reach incur's
    // outer catch and produce the stock {code, message, retryable} shape.
    const cli = createUcpCli({
      resolveSession: passthroughSession,
      searchCatalog: async () => {
        throw new (await import('./lib/errors.js')).UcpError({
          layer: 'transport',
          code: 'MCP_INVALID_RESPONSE',
          message: 'business returned an invalid response',
        })
      },
    })

    const { output, exitCode } = await serveCli(cli, [
      'catalog',
      'search',
      '--business',
      'https://shop.example.com',
    ])
    expect(exitCode).toBe(1)
    const parsed = JSON.parse(output)
    expect(parsed.code).toBe('MCP_INVALID_RESPONSE')
    // No cta surfaced — middleware did NOT re-route this code.
    expect(parsed.cta).toBeUndefined()
  })

  it('describes per-op (each helper carries its own toolName via withMeta)', async () => {
    // Sanity-check the metadata wiring: a non-search op (cart create) should
    // ask discover for the same capability but resolve a different tool.
    const cli = createUcpCli({
      resolveSession: passthroughSession,
      discover: stubDiscover({
        create_cart: {
          name: 'create_cart',
          inputSchema: { type: 'object', required: ['cart'] },
        },
      }),
      createCart: async () => ({}),
    })

    const { output, exitCode } = await serveCli(cli, [
      'cart',
      'create',
      '--business',
      'https://shop.example.com',
      '--input-schema',
    ])
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(output)
    // describe payload nests the tool inside `result` (after the
    // business/endpoint/transport hoist); see the describe shape test above.
    expect(parsed.result.tool.name).toBe('create_cart')
  })
})

// Escalation hook: when a server returns a checkout with status requires_escalation,
// the run handler must (a) build a payload from the checkout + dispatcher context,
// (b) ask resolveEscalationHook to find a configured hook, (c) invoke it via
// runEscalationHook, then (d) return the success envelope with the full checkout
// nested under `result`. MCP mode short-circuits the hook (skip=true) but still
// returns the success envelope with the checkout.
describe('createUcpCli — escalation hook', () => {
  // Per UCP spec: checkout response is flat — status, continue_url, messages
  // are top-level fields alongside id, line_items, etc. No checkout wrapper.
  const ESCALATION_RESULT = {
    id: 'gid://mock/Checkout/chk_123',
    status: 'requires_escalation',
    continue_url: 'https://shop.example.com/3ds/abc',
    messages: [
      {
        type: 'error',
        code: 'threed_secure',
        severity: 'requires_buyer_review',
        content: '3DS challenge required',
      },
    ],
  }

  it('fires the hook with payload and returns the requires_escalation result', async () => {
    const resolveCalls: unknown[] = []
    const runCalls: Array<{ skip?: boolean; payload: unknown; hook: unknown }> = []
    const cli = createUcpCli({
      resolveSession: passthroughSession,
      completeCheckout: async () => ESCALATION_RESULT,
      resolveEscalationHook: async (opts) => {
        resolveCalls.push(opts)
        return { source: 'env', command: 'echo run', isFile: false }
      },
      runEscalationHook: async (opts) => {
        runCalls.push({
          ...(opts.skip !== undefined && { skip: opts.skip }),
          payload: opts.payload,
          hook: opts.hook,
        })
        return {
          invoked: true,
          source: 'env',
          exitCode: 0,
          durationMs: 1,
          stderr: '',
          timedOut: false,
        }
      },
    })

    const { output, exitCode } = await serveCli(cli, [
      'checkout',
      'complete',
      'chk_123',
      '--business',
      'https://shop.example.com',
    ])

    // Escalation is a normal UCP response — exit 0, full checkout nested at
    // `result`. The wire `status: 'requires_escalation'` is the
    // checkout-state-machine value (load-bearing); there's no longer a
    // redundant envelope-level `status: 'ok'` to shadow it.
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(output)
    expect(parsed.business).toBe('https://shop.example.com')
    expect(parsed.result.status).toBe('requires_escalation')
    expect(parsed.result.continue_url).toBe('https://shop.example.com/3ds/abc')

    expect(runCalls).toHaveLength(1)
    const firstCall = runCalls[0]
    if (firstCall === undefined) throw new Error('expected a runCall')
    expect(firstCall.skip).toBeUndefined()
    expect(firstCall.hook).toEqual({ source: 'env', command: 'echo run', isFile: false })
    // Payload built from checkout object: status, continue_url → url, message content → reason.
    expect(firstCall.payload).toMatchObject({
      status: 'requires_escalation',
      url: 'https://shop.example.com/3ds/abc',
      reason: '3DS challenge required',
      business: 'https://shop.example.com',
      operation: 'complete_checkout',
    })

    expect(resolveCalls).toHaveLength(1)
  })

  it('passes --on-escalation flag through to the resolver', async () => {
    const resolveCalls: Array<{ argFlag?: string }> = []
    const cli = createUcpCli({
      resolveSession: passthroughSession,
      completeCheckout: async () => ESCALATION_RESULT,
      resolveEscalationHook: async (opts = {}) => {
        resolveCalls.push({ ...(opts.argFlag !== undefined && { argFlag: opts.argFlag }) })
        return undefined
      },
      runEscalationHook: async () => ({ invoked: false, reason: 'no-hook' as const }),
    })

    await serveCli(cli, [
      'checkout',
      'complete',
      'chk_123',
      '--business',
      'https://shop.example.com',
      '--on-escalation',
      'echo flag-wins',
    ])
    expect(resolveCalls[0]?.argFlag).toBe('echo flag-wins')
  })

  it('skips hook resolution and execution in --mcp mode', async () => {
    let resolveCalled = false
    const runCalls: Array<{ skip?: boolean }> = []
    const verboseLines: string[] = []
    setVerboseWriter((msg) => {
      verboseLines.push(msg)
    })
    try {
      const cli = createUcpCli({
        inMcpMode: true,
        resolveSession: passthroughSession,
        completeCheckout: async () => ESCALATION_RESULT,
        resolveEscalationHook: async () => {
          resolveCalled = true
          return undefined
        },
        runEscalationHook: async (opts) => {
          runCalls.push({ ...(opts.skip !== undefined && { skip: opts.skip }) })
          return { invoked: false, reason: 'mcp-mode' as const }
        },
      })

      const { exitCode, output } = await serveCli(cli, [
        'checkout',
        'complete',
        'chk_123',
        '--business',
        'https://shop.example.com',
        '--on-escalation',
        'echo should-not-resolve',
      ])

      // Hook is a no-op in MCP mode, but the checkout still reaches the agent.
      expect(exitCode).toBe(0)
      expect(JSON.parse(output).result.status).toBe('requires_escalation')
      expect(resolveCalled).toBe(false)
      expect(runCalls).toEqual([{ skip: true }])
      expect(verboseLines.some((line) => line.includes('escalation'))).toBe(false)
    } finally {
      setVerboseWriter(null)
    }
  })

  it('surfaces requires_escalation even when no hook is configured', async () => {
    const cli = createUcpCli({
      resolveSession: passthroughSession,
      completeCheckout: async () => ESCALATION_RESULT,
      resolveEscalationHook: async () => undefined,
      runEscalationHook: async () => ({ invoked: false, reason: 'no-hook' as const }),
    })

    const { exitCode, output } = await serveCli(cli, [
      'checkout',
      'complete',
      'chk_123',
      '--business',
      'https://shop.example.com',
    ])
    expect(exitCode).toBe(0)
    expect(JSON.parse(output).result.status).toBe('requires_escalation')
  })

  it('emits escalation breadcrumbs only through verbose tracing', async () => {
    const verboseLines: string[] = []
    setVerboseWriter((msg) => {
      verboseLines.push(msg)
    })
    try {
      const cli = createUcpCli({
        resolveSession: passthroughSession,
        completeCheckout: async () => ESCALATION_RESULT,
        resolveEscalationHook: async () => undefined,
        runEscalationHook: async () => ({ invoked: false, reason: 'no-hook' as const }),
      })

      const { exitCode, output } = await serveCli(cli, [
        'checkout',
        'complete',
        'chk_123',
        '--business',
        'https://shop.example.com',
      ])
      expect(exitCode).toBe(0)
      expect(JSON.parse(output).result.status).toBe('requires_escalation')
      expect(verboseLines).toContain(
        '[ucp] escalation [complete_checkout]: 3DS challenge required → https://shop.example.com/3ds/abc\n',
      )
    } finally {
      setVerboseWriter(null)
    }
  })

  it('non-escalation results pass through unchanged', async () => {
    // Sanity: success envelopes aren't intercepted. A normal cart-update
    // result should round-trip without an escalation hook path.
    let hookInvoked = false
    const cli = createUcpCli({
      resolveSession: passthroughSession,
      updateCart: async () => ({ cart: { id: 'cart_1', line_items: [] } }),
      runEscalationHook: async () => {
        hookInvoked = true
        return { invoked: false, reason: 'no-hook' as const }
      },
    })
    const { exitCode, output } = await serveCli(cli, [
      'cart',
      'update',
      'cart_1',
      '--business',
      'https://shop.example.com',
    ])
    expect(exitCode).toBe(0)
    expect(JSON.parse(output)).toMatchObject({
      business: 'https://shop.example.com',
      result: { cart: { id: 'cart_1', line_items: [] } },
    })
    expect(hookInvoked).toBe(false)
  })

  it('does not treat non-checkout status=requires_escalation as a hook trigger', async () => {
    let hookInvoked = false
    const cli = createUcpCli({
      resolveSession: passthroughSession,
      updateCart: async () => ({ id: 'cart_1', status: 'requires_escalation', line_items: [] }),
      runEscalationHook: async () => {
        hookInvoked = true
        return { invoked: false, reason: 'no-hook' as const }
      },
    })
    const { exitCode, output } = await serveCli(cli, [
      'cart',
      'update',
      'cart_1',
      '--business',
      'https://shop.example.com',
    ])
    expect(exitCode).toBe(0)
    expect(JSON.parse(output).result.status).toBe('requires_escalation')
    expect(hookInvoked).toBe(false)
  })
})

// --view: JMESPath projection over the WHOLE response envelope. Pinned here
// are the dispatcher-level contracts: projection runs after CTA build, the
// view's output REPLACES the envelope (dispatch identity is gone unless the
// view re-emits it), fails fast on parse errors (no helper call), and is a
// no-op on dry-run / error envelopes. Pure resolver+applier semantics are
// covered in src/cli/view.test.ts.
describe('createUcpCli — --view projection', () => {
  const fixtureResult = {
    products: [
      { id: 'p1', title: 'Boots', price: 100 },
      { id: 'p2', title: 'Hat', price: 30 },
    ],
  }

  it('inline projection replaces the whole envelope — dispatch identity drops unless re-emitted', async () => {
    let calls = 0
    const cli = createUcpCli({
      resolveSession: passthroughSession,
      searchCatalog: async () => {
        calls++
        return fixtureResult
      },
    })

    const { output, exitCode } = await serveCli(cli, [
      'catalog',
      'search',
      '--business',
      'https://shop.example.com',
      '--set',
      '/query=boots',
      '--view',
      'result.products[*].{title: title}',
    ])
    expect(exitCode).toBe(0)
    expect(calls).toBe(1)
    // Output IS the projection. No envelope wrapper, no dispatch identity —
    // the view replaced the entire response. The CTA still rides through on
    // its separate channel (incur merges `cta` into the rendered payload),
    // proving the documented "CTAs survive any envelope reshape" contract.
    const body = JSON.parse(output)
    expect(body).toMatchObject({ 0: { title: 'Boots' }, 1: { title: 'Hat' } })
    expect(body.business).toBeUndefined()
    expect(body.endpoint).toBeUndefined()
    expect(body.transport).toBeUndefined()
    expect(body.cta).toBeDefined()
  })

  it('view can re-emit a slim envelope (keep ucp + projected result, drop dispatch identity)', async () => {
    // This is the canonical pattern the package-local views use. The view sees the
    // whole envelope (with ucp hoisted by the dispatcher per hoistUcp) and
    // emits a new one that keeps ucp.version/status as protocol confirmation
    // while dropping business/endpoint/transport noise — the human-facing
    // "reduce noise" goal.
    const cli = createUcpCli({
      resolveSession: passthroughSession,
      // Wire payload carries `ucp` per the UCP spec; hoistUcp lifts it to a
      // sibling of `result` before applyView runs.
      searchCatalog: async () => ({
        ucp: { version: '2026-04-08', status: 'ok' },
        ...fixtureResult,
      }),
    })

    const { output, exitCode } = await serveCli(cli, [
      'catalog',
      'search',
      '--business',
      'https://shop.example.com',
      '--set',
      '/query=boots',
      '--view',
      '{ucp: {version: ucp.version, status: ucp.status}, result: result.products[*].title}',
    ])
    expect(exitCode).toBe(0)
    const body = JSON.parse(output)
    // toMatchObject — CTA also rides through on the separate channel and gets
    // merged into the rendered payload by incur (proving the contract that
    // CTAs survive any envelope reshape).
    expect(body).toMatchObject({
      ucp: { version: '2026-04-08', status: 'ok' },
      result: ['Boots', 'Hat'],
    })
    // Dispatch identity intentionally absent — the view didn't re-emit it.
    expect(body.business).toBeUndefined()
    expect(body.endpoint).toBeUndefined()
    expect(body.transport).toBeUndefined()
  })

  it('@file loads the expression from disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ucp-cli-view-'))
    const path = join(dir, 'titles.jmespath')
    writeFileSync(path, '\n  {count: length(result.products), titles: result.products[*].title}\n')

    const cli = createUcpCli({
      resolveSession: passthroughSession,
      searchCatalog: async () => fixtureResult,
    })

    const { output, exitCode } = await serveCli(cli, [
      'catalog',
      'search',
      '--business',
      'https://shop.example.com',
      '--set',
      '/query=boots',
      '--view',
      `@${path}`,
    ])
    expect(exitCode).toBe(0)
    const body = JSON.parse(output)
    // toMatchObject — incur merges the search_catalog CTA into the rendered
    // payload (separate channel from the view projection).
    expect(body).toMatchObject({ count: 2, titles: ['Boots', 'Hat'] })
  })

  it('package-local :alias resolves under the current operation capability', async () => {
    const cli = createUcpCli({
      resolveSession: passthroughSession,
      searchCatalog: async () => ({
        ucp: { version: '2026-04-08', status: 'ok' },
        products: [
          {
            title: 'Birdbath',
            price_range: { min: { amount: 4500, currency: 'USD' } },
            variants: [
              {
                id: 'v1',
                checkout_url: 'https://bird-bath-store.example.com/checkouts/abc',
                seller: {
                  domain: 'bird-bath-store.myshopify.com',
                  url: 'https://bird-bath-store.example.com',
                },
              },
            ],
          },
        ],
      }),
    })

    const { output, exitCode } = await serveCli(cli, [
      'catalog',
      'search',
      '--business',
      'https://shop.example.com',
      '--view',
      ':compact',
    ])
    expect(exitCode).toBe(0)
    const body = JSON.parse(output)
    expect(body).toMatchObject({
      ucp: { version: '2026-04-08', status: 'ok' },
      result: [
        {
          title: 'Birdbath',
          variant: 'v1',
        },
      ],
    })
    expect(body.result[0]).not.toHaveProperty('seller_domain')
    expect(body.result[0]).not.toHaveProperty('seller_url')
  })

  it('package-local :alias uses the cart capability for cart commands', async () => {
    const cli = createUcpCli({
      resolveSession: passthroughSession,
      createCart: async () => ({
        ucp: { version: '2026-04-08', status: 'ok' },
        id: 'cart_1',
        currency: 'USD',
        line_items: [{ item: { id: 'v1' }, quantity: 1 }],
        totals: [
          { type: 'subtotal', amount: 5000 },
          { type: 'fulfillment', amount: 795 },
          { type: 'total', amount: 5795 },
        ],
      }),
    })

    const { output, exitCode } = await serveCli(cli, [
      'cart',
      'create',
      '--business',
      'https://shop.example.com',
      '--view',
      ':summary',
    ])
    expect(exitCode).toBe(0)
    expect(JSON.parse(output)).toMatchObject({
      ucp: { version: '2026-04-08', status: 'ok' },
      result: {
        id: 'cart_1',
        items: 1,
        fulfillment: 795,
        total: 5795,
      },
    })
  })

  it('parse error fails before any helper call (INVALID_INPUT, no network)', async () => {
    let calls = 0
    const cli = createUcpCli({
      resolveSession: passthroughSession,
      searchCatalog: async () => {
        calls++
        return fixtureResult
      },
    })

    const { output, exitCode } = await serveCli(cli, [
      'catalog',
      'search',
      '--business',
      'https://shop.example.com',
      '--set',
      '/query=boots',
      '--view',
      'result.products[',
    ])
    expect(exitCode).not.toBe(0)
    expect(calls).toBe(0)
    expect(output).toMatch(/INVALID_INPUT/)
    expect(output).toMatch(/JMESPath parse error/)
  })

  it('unknown package-local aliases fail before dispatch and stay capability-scoped', async () => {
    let calls = 0
    const cli = createUcpCli({
      resolveSession: passthroughSession,
      searchCatalog: async () => {
        calls++
        return fixtureResult
      },
    })

    const { output, exitCode } = await serveCli(cli, [
      'catalog',
      'search',
      '--business',
      'https://shop.example.com',
      '--view',
      ':cart.summary',
    ])
    expect(exitCode).not.toBe(0)
    expect(calls).toBe(0)
    expect(output).toMatch(/catalog\.cart\.summary\.jmespath/)
    expect(output).toMatch(/Available for catalog: compact, summary/)
  })

  it('rejects --view - (stdin reserved for --input) before dispatch', async () => {
    let calls = 0
    const cli = createUcpCli({
      resolveSession: passthroughSession,
      searchCatalog: async () => {
        calls++
        return fixtureResult
      },
    })

    const { output, exitCode } = await serveCli(cli, [
      'catalog',
      'search',
      '--business',
      'https://shop.example.com',
      '--set',
      '/query=boots',
      '--view',
      '-',
    ])
    expect(exitCode).not.toBe(0)
    expect(calls).toBe(0)
    expect(output).toMatch(/stdin is reserved for --input/)
  })

  it('discover supports inline --view (read-only introspection path)', async () => {
    const cli = createUcpCli({
      discover: async (..._args) =>
        ({
          business: _args[0],
          profile: {
            ucp: { version: '2026-04-08', status: 'success', services: {}, payment_handlers: {} },
          },
          negotiated: {
            'dev.ucp.shopping': {
              capability: 'dev.ucp.shopping',
              version: '2026-04-08',
              transport: 'mcp',
              endpoint: 'https://shop.example.com/mcp',
              tools: {
                search_catalog: { name: 'search_catalog', inputSchema: { type: 'object' } },
                create_cart: { name: 'create_cart', inputSchema: { type: 'object' } },
              },
            },
          },
        }) as never,
      resolveSession: passthroughSession,
    })

    const { output, exitCode } = await serveCli(cli, [
      'discover',
      'https://shop.example.com',
      '--view',
      'keys(result.negotiated)',
    ])
    expect(exitCode).toBe(0)
    expect(JSON.parse(output)).toEqual(['dev.ucp.shopping'])
  })

  it('discover rejects package-local view aliases because it has no operation capability', async () => {
    let calls = 0
    const cli = createUcpCli({
      discover: async () => {
        calls++
        return { business: 'https://shop.example.com', profile: {}, negotiated: {} } as never
      },
      resolveSession: passthroughSession,
    })

    const { output, exitCode } = await serveCli(cli, [
      'discover',
      'https://shop.example.com',
      '--view',
      ':compact',
    ])
    expect(exitCode).not.toBe(0)
    expect(calls).toBe(0)
    expect(output).toMatch(/discover does not support package-local/)
  })

  it('composes with --format md (the kick-the-tires path)', async () => {
    const cli = createUcpCli({
      resolveSession: passthroughSession,
      searchCatalog: async () => fixtureResult,
    })

    const { output, exitCode } = await serveCli(cli, [
      'catalog',
      'search',
      '--business',
      'https://shop.example.com',
      '--set',
      '/query=boots',
      '--view',
      'result.products[*].{title: title, price: price}',
      '--format',
      'md',
    ])
    expect(exitCode).toBe(0)
    // incur's md renderer emits a columnar table for an array of flat objects.
    // We pin the structural signal (title + price headers + boots row) rather
    // than exact whitespace so a renderer tweak doesn't break this test.
    expect(output).toMatch(/title/)
    expect(output).toMatch(/price/)
    expect(output).toMatch(/Boots/)
  })

  it('--dry-run skips projection (preview is meta, not a response)', async () => {
    const cli = createUcpCli({
      resolveSession: passthroughSession,
      searchCatalog: async (_business, input) => ({
        dry_run: true,
        note: 'Skipped network I/O.',
        arguments: input,
      }),
    })

    const { output, exitCode } = await serveCli(cli, [
      'catalog',
      'search',
      '--business',
      'https://shop.example.com',
      '--set',
      '/query=boots',
      '--view',
      'result.products[*].title',
      '--dry-run',
    ])
    expect(exitCode).toBe(0)
    const body = JSON.parse(output)
    // Dry-run preview is emitted untouched — projecting `result.products`
    // here would mask the actual preview shape (`arguments`, `note`).
    expect(body.result).toMatchObject({ dry_run: true, note: expect.any(String) })
  })

  it('--input-schema skips projection (schema is meta, not a response)', async () => {
    // --input-schema short-circuits before viewState resolution, so the
    // projection never runs. We pin the exit-success contract + the absence
    // of an unexpected `result` shape (the schema-output structure is
    // already covered by the --input-schema describe block above).
    const cli = createUcpCli({
      resolveSession: passthroughSession,
      searchCatalog: async () => {
        throw new Error('helper must not be called on --input-schema')
      },
      discover: async (..._args) =>
        ({
          business: _args[0] ?? '',
          profile: {
            ucp: { version: '2026-04-08', status: 'success', services: {}, payment_handlers: {} },
          },
          negotiated: {
            'dev.ucp.shopping': {
              capability: 'dev.ucp.shopping',
              version: '2026-04-08',
              transport: 'mcp',
              endpoint: 'https://shop.example.com/mcp',
              tools: {
                search_catalog: { name: 'search_catalog', inputSchema: { type: 'object' } },
              },
            },
          },
        }) as never,
    })

    const { output, exitCode } = await serveCli(cli, [
      'catalog',
      'search',
      '--business',
      'https://shop.example.com',
      '--input-schema',
      '--view',
      'result.products[*].title',
    ])
    expect(exitCode).toBe(0)
    const body = JSON.parse(output)
    // Schema output, NOT a projection of `products` — the projection was
    // skipped, the inputSchema survived in `result.tool.inputSchema`.
    expect(body.result?.tool?.inputSchema).toMatchObject({ type: 'object' })
  })

  it('error envelopes pass through unprojected (BUSINESS_NOT_RESOLVED stays visible)', async () => {
    const cli = createUcpCli({
      // No active business; opRun errors before helper invocation. The
      // error envelope has no `result` field, so applyView's passthrough
      // rule fires — the user's BUSINESS_NOT_RESOLVED message survives.
      resolveSession: async () => ({ profile: { name: 'agent', profileUrl: PROFILE_URL } }),
      searchCatalog: async () => fixtureResult,
    })

    const { output, exitCode } = await serveCli(cli, [
      'catalog',
      'search',
      '--set',
      '/query=boots',
      '--view',
      'result.products[*].title',
    ])
    expect(exitCode).not.toBe(0)
    expect(output).toMatch(/BUSINESS_NOT_RESOLVED/)
  })
})

// Guards the bin-entry dispatch decision against incur's `skill` alias.
// Regression: `ucp skill add` (singular) bypassed the interceptor and let
// incur's built-in handler ship the un-pruned per-command sub-skills.
describe('isSkillsAddInvocation — incur alias awareness', () => {
  it('matches the plural form (`skills add`)', () => {
    expect(isSkillsAddInvocation(['skills', 'add'])).toBe(true)
    expect(isSkillsAddInvocation(['skills', 'add', '--no-global'])).toBe(true)
  })

  it('matches the singular alias (`skill add`) — the regression case', () => {
    expect(isSkillsAddInvocation(['skill', 'add'])).toBe(true)
    expect(isSkillsAddInvocation(['skill', 'add', '--depth', '2'])).toBe(true)
  })

  it('does not intercept help — falls through to incur for formatting', () => {
    expect(isSkillsAddInvocation(['skills', 'add', '--help'])).toBe(false)
    expect(isSkillsAddInvocation(['skill', 'add', '-h'])).toBe(false)
  })

  it('does not intercept other subcommands (list, bare skills, etc.)', () => {
    expect(isSkillsAddInvocation(['skills'])).toBe(false)
    expect(isSkillsAddInvocation(['skills', 'list'])).toBe(false)
    expect(isSkillsAddInvocation(['skill', 'ls'])).toBe(false)
    expect(isSkillsAddInvocation([])).toBe(false)
    expect(isSkillsAddInvocation(['cart', 'create'])).toBe(false)
  })
})
