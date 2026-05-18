// Purchase journey integration test.
//
// Drives the compiled CLI through the full UCP shopping flow against a local
// mock business and measures:
//   1. Each step produces clean, unwrapped output (not raw MCP envelopes).
//   2. Every op success response carries a `cta` pointing at the next step.
//   3. complete_checkout triggers a requires_buyer_review escalation.
//   4. The escalation hook fires and receives the correct JSON payload.
//
// Treat this as an agent-fidelity check: does an agent following SKILL.md
// and CLI output alone have everything it needs to complete the flow
// without external help? The assertions model what a competent agent
// would check at each step.
//
// Runs against the packaged bin entry — `pnpm test:integration` builds first.

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  MOCK_CART_ID,
  MOCK_CHECKOUT_ID,
  MOCK_ESCALATION_URL,
  MOCK_VARIANT_ID,
  startMockUcpShopping,
} from '../fixtures/mock-ucp-shopping.js'
import { nodeHookCommand } from '../fixtures/shell-command.js'

const execFileAsync = promisify(execFile)
const CLI = fileURLToPath(new URL('../../dist/bin.js', import.meta.url))

interface Journey {
  businessUrl: string
  ucpHome: string
  hookCapturePath: string
  run(
    args: string[],
    extraEnv?: Record<string, string>,
  ): Promise<{ json: unknown; code: number; raw: string; stderr: string }>
  close(): Promise<void>
}

async function setupJourney(): Promise<Journey> {
  const mock = await startMockUcpShopping()
  const ucpHome = await mkdtemp(join(tmpdir(), 'ucp-eval-'))
  const hookCapturePath = join(ucpHome, 'escalation-payload.json')

  // Minimal agent profile so the CLI can resolve a profileUrl.
  const profileDir = join(ucpHome, 'profiles', 'eval')
  await (await import('node:fs/promises')).mkdir(profileDir, { recursive: true })
  await writeFile(
    join(profileDir, 'profile.json'),
    JSON.stringify({
      ucp: {
        version: '2026-04-08',
        status: 'success',
        services: {},
        payment_handlers: {},
      },
      signing_keys: [],
    }),
    'utf-8',
  )
  await writeFile(
    join(profileDir, 'meta.json'),
    JSON.stringify({
      created_at: new Date().toISOString(),
      profile_url: 'https://eval-agent.example.com/.well-known/ucp',
    }),
    'utf-8',
  )
  // Activate the profile via active.yaml.
  await writeFile(join(ucpHome, 'active.yaml'), `profile: eval\nbusiness: ${mock.url}\n`, 'utf-8')

  const baseEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) baseEnv[k] = v
  }
  baseEnv.UCP_HOME = ucpHome
  // Allow the mock server's http://127.0.0.1 URL through the https-only guard.
  // TEST infix is intentional: this is not a production/deployment knob.
  baseEnv.UCP_TEST_ALLOW_INSECURE_LOCALHOST = 'true'
  // Hook writes payload to file so assertions can read it. Use a tiny Node
  // program instead of shell redirection: CI runs this integration suite on
  // Windows too, where `cat > 'path'` is not portable.
  const hookCaptureScript = join(ucpHome, 'capture-escalation.cjs')
  await writeFile(
    hookCaptureScript,
    "process.stdin.pipe(require('node:fs').createWriteStream(process.argv[2]))\n",
    'utf-8',
  )
  // This is a shell command because UCP_ON_ESCALATION intentionally accepts
  // the same user-facing command string as --on-escalation. Do not use
  // JSON.stringify for path quoting here: it produces JavaScript string
  // escapes, not shell quoting, and Windows + Node 24 can crash before the CLI
  // reports the hook result. The shared helper is intentionally test-only:
  // this integration test is about end-to-end hook firing, not about fuzzing
  // cmd.exe quoting.
  baseEnv.UCP_ON_ESCALATION = nodeHookCommand(hookCaptureScript, hookCapturePath)

  const run = async (
    args: string[],
    extraEnv: Record<string, string> = {},
  ): Promise<{ json: unknown; code: number; raw: string; stderr: string }> => {
    try {
      const { stdout, stderr } = await execFileAsync('node', [CLI, ...args], {
        env: { ...baseEnv, ...extraEnv },
      })
      return { json: JSON.parse(stdout), code: 0, raw: stdout, stderr }
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number }
      const raw = e.stdout ?? ''
      const stderr = e.stderr ?? ''
      let json: unknown = null
      try {
        json = JSON.parse(raw)
      } catch {
        /* non-JSON output on failure */
      }
      return { json, code: e.code ?? -1, raw, stderr }
    }
  }

  return {
    businessUrl: mock.url,
    ucpHome,
    hookCapturePath,
    run,
    async close() {
      await mock.close()
      await rm(ucpHome, { recursive: true, force: true })
    },
  }
}

describe('eval: purchase journey', () => {
  let j: Journey

  beforeAll(async () => {
    j = await setupJourney()
  })

  afterAll(async () => {
    await j.close()
  })

  // ─── Step 1: search ───────────────────────────────────────────────────────

  it('step 1 — search_catalog: unwrapped products + cta covering both cart (explore) and checkout (buy now)', async () => {
    const { json, code } = await j.run(['catalog', 'search', '--set', '/query=map'])
    expect(code).toBe(0)

    const envelope = json as Record<string, unknown>

    // Envelope check: dispatch identity at the root (business/endpoint/transport),
    // server payload under `result`, cta flattened in by incur. No redundant
    // `status: 'ok'` — incur's outer `ok: true` is suppressed in JSON-default
    // output; presence of `result` is the success signal.
    expect(typeof envelope.business).toBe('string')
    expect(envelope).not.toHaveProperty('content')
    const inner = envelope.result as Record<string, unknown>
    expect(Array.isArray(inner.products)).toBe(true)
    const products = inner.products as Array<{ title: string; variants: Array<{ id: string }> }>
    expect(products[0]?.title).toContain('Trail Map')
    expect(products[0]?.variants[0]?.id).toBe(MOCK_VARIANT_ID)

    // CTA at root level (merged by incur). Cart create is primary (up-funnel exploration).
    const cta = envelope.cta as { commands: Array<{ command: string }> } | undefined
    expect(cta?.commands?.[0]?.command.includes('cart create')).toBe(true)
    // Checkout create also present as buy-now path
    expect(cta?.commands?.some((c) => c.command.includes('checkout create'))).toBe(true)
  })

  // ─── Step 2: cart create ──────────────────────────────────────────────────

  it('step 2 — create_cart: unwrapped cart + cta pointing at checkout create', async () => {
    const { json, code } = await j.run([
      'cart',
      'create',
      '--set',
      `/line_items=[{"item":{"id":"${MOCK_VARIANT_ID}"},"quantity":1}]`,
    ])
    expect(code).toBe(0)

    const envelope = json as Record<string, unknown>
    expect(typeof envelope.business).toBe('string')

    const cart = (envelope.result as Record<string, unknown>) ?? {}
    expect(typeof cart.id).toBe('string')
    expect(Array.isArray(cart.line_items)).toBe(true)
    expect((cart.line_items as unknown[]).length).toBeGreaterThan(0)

    // CTA at root level. Next step is checkout create.
    const cta = envelope.cta as { commands: Array<{ command: string }> } | undefined
    expect(cta?.commands?.some((c) => c.command.includes('checkout create'))).toBe(true)
  })

  // ─── Step 3: checkout create ──────────────────────────────────────────────

  it('step 3a — create_checkout --dry-run: cart_id is a checkout body field', async () => {
    const { json, code } = await j.run([
      'checkout',
      'create',
      '--input',
      `{"cart_id":"${MOCK_CART_ID}","line_items":[]}`,
      '--dry-run',
    ])
    expect(code).toBe(0)

    const result = (json as Record<string, unknown>).result as {
      arguments: { checkout?: { cart_id?: string; line_items?: unknown[] }; meta?: unknown }
    }
    expect(result.arguments.checkout?.cart_id).toBe(MOCK_CART_ID)
    expect(result.arguments.checkout?.line_items).toEqual([])
    expect(result.arguments).not.toHaveProperty('cart_id')
    expect(result.arguments.meta).toBeDefined()
  })

  it('step 3 — create_checkout: cart_id handoff yields checkout with delivery_options + cta pointing at update', async () => {
    const { json, code } = await j.run([
      'checkout',
      'create',
      '--input',
      `{"cart_id":"${MOCK_CART_ID}","line_items":[]}`,
    ])
    expect(code).toBe(0)

    const envelope = json as Record<string, unknown>
    expect(typeof envelope.business).toBe('string')

    const checkout = (envelope.result as Record<string, unknown>) ?? {}
    expect(typeof checkout.id).toBe('string')

    // Fulfillment options must be present so agent can select one in the next step.
    const fulfillment = checkout.fulfillment as
      | { methods?: Array<{ groups?: Array<{ options?: unknown[] }> }> }
      | undefined
    const options = fulfillment?.methods?.[0]?.groups?.[0]?.options
    expect(Array.isArray(options)).toBe(true)
    expect(options?.length).toBeGreaterThan(0)

    // CTA at root level. Next step is checkout update (to add delivery + payment).
    const cta = envelope.cta as { commands: Array<{ command: string }> } | undefined
    expect(cta?.commands?.some((c) => c.command.includes('checkout update'))).toBe(true)
  })

  // ─── Step 4: checkout update ──────────────────────────────────────────────

  it('step 4 — update_checkout: status=ready_for_complete + cta pointing at complete', async () => {
    // Regression: CTA "checkout complete" must appear because result.status is
    // 'ready_for_complete' per spec (checkout.json status enum). Mock fixture
    // intentionally does NOT include any legacy `ready_to_complete` boolean —
    // the gate is the spec status field, not a CLI-fabricated flag.
    // --input provides the full replacement payload: request-shaped line_items
    // plus fulfillment destination/selection in the canonical fulfillment shape.
    const { json, code } = await j.run([
      'checkout',
      'update',
      MOCK_CHECKOUT_ID,
      '--input',
      `{"line_items":[{"id":"gid://mock/CheckoutLine/li_1","item":{"id":"${MOCK_VARIANT_ID}"},"quantity":1}],"fulfillment":{"methods":[{"type":"shipping","line_item_ids":["gid://mock/CheckoutLine/li_1"],"destinations":[{"first_name":"Test","last_name":"Agent","street_address":"123 Main St","address_locality":"Portland","address_region":"OR","postal_code":"97201","address_country":"US"}],"groups":[{"id":"gid://mock/FulfillmentGroup/fg_1","selected_option_id":"standard-free"}]}]}}`,
    ])
    expect(code, JSON.stringify(json)).toBe(0)

    const envelope = json as Record<string, unknown>
    expect(typeof envelope.business).toBe('string')

    const checkout = (envelope.result as Record<string, unknown>) ?? {}
    expect(checkout.status).toBe('ready_for_complete')
    // Negative: legacy field must NOT be present — proves the gate is status.
    expect(checkout.ready_to_complete).toBeUndefined()

    // CTA at root level. Agent is told to complete.
    const cta = envelope.cta as
      | {
          description?: string
          commands: Array<{ command: string }>
        }
      | undefined
    expect(cta?.commands?.some((c) => c.command.includes('checkout complete'))).toBe(true)
    // Negative: must NOT fall through to the not-ready cascade.
    expect(cta?.description ?? '').not.toMatch(/not ready/i)
  })

  // ─── Step 5: complete + escalation ────────────────────────────────────────

  it('step 5 — complete_checkout: escalation envelope + hook fires with payload', async () => {
    const { json, code, stderr } = await j.run(['checkout', 'complete', MOCK_CHECKOUT_ID])

    // CLI exits 0 — requires_escalation is a normal UCP checkout response.
    expect(code).toBe(0)

    const envelope = json as Record<string, unknown>
    expect(typeof envelope.business).toBe('string')
    const checkout = (envelope.result as Record<string, unknown>) ?? {}
    expect(checkout.status).toBe('requires_escalation')
    expect(checkout.continue_url).toBe(MOCK_ESCALATION_URL)

    // Default CLI output is quiet on stderr for protocol-state changes:
    // requires_escalation is represented by the structured checkout result,
    // CTA, and hook payload. Human breadcrumbs are opt-in via --verbose.
    expect(stderr).not.toMatch(/\[ucp\] escalation \[complete_checkout\]/i)

    // Hook fired: the capture file should contain the JSON payload.
    const captured = JSON.parse(await readFile(j.hookCapturePath, 'utf-8')) as Record<
      string,
      unknown
    >
    // Payload built from flat checkout response: status is top-level field.
    expect(captured.status).toBe('requires_escalation')
    expect(captured.url).toBe(MOCK_ESCALATION_URL)
    expect(captured.operation).toBe('complete_checkout')

    // CTA must be messages-aware: mock returns requires_buyer_review (checkout complete,
    // buyer authorizes). Description must distinguish this from requires_buyer_input
    // (checkout incomplete). Agents must not conflate the two — wrong action = bad UX.
    const cta = envelope.cta as
      | { description: string; commands: Array<{ command: string; description: string }> }
      | undefined
    expect(cta?.description).toMatch(/authorization|authoriz/i)
    // Must NOT imply the checkout is incomplete (that would be requires_buyer_input semantics)
    expect(cta?.description).not.toMatch(/incomplete/i)
  })
})

// ─── --input-schema introspect gate ─────────────────────────────────────────────

describe('eval: introspect → craft → submit pattern', () => {
  let j: Journey

  beforeAll(async () => {
    j = await setupJourney()
  })

  afterAll(async () => {
    await j.close()
  })

  it('--input-schema on any op returns inputSchema without dispatching', async () => {
    const { json, code } = await j.run(['checkout', 'create', '--input-schema'])
    expect(code).toBe(0)

    const envelope = json as Record<string, unknown>
    expect(typeof envelope.business).toBe('string')
    const data = envelope.result as Record<string, unknown>
    expect(data).toHaveProperty('tool')
    const tool = data.tool as Record<string, unknown>
    expect(tool).toHaveProperty('inputSchema')
    const schema = tool.inputSchema as Record<string, unknown>
    // Agent sees the CLI-facing body schema, not the UCP wire envelope.
    const checkoutProps = schema.properties as Record<string, unknown>
    expect(checkoutProps).toHaveProperty('line_items')
    expect(checkoutProps).not.toHaveProperty('checkout')
  })

  it('SCHEMA_VALIDATION_FAILED cta points at --input-schema for self-correction', async () => {
    // Submit intentionally wrong input — missing required line_items in the
    // CLI-facing checkout body. The dispatcher wraps this body before final
    // business-schema validation, so the recovery path is still --input-schema.
    const { json, code } = await j.run([
      'checkout',
      'create',
      '--set',
      '/buyer/email=buyer@example.com',
    ])
    expect(code).toBe(1)

    const envelope = json as Record<string, unknown>
    expect(envelope.code).toBe('SCHEMA_VALIDATION_FAILED')
    const cta = envelope.cta as { commands: Array<{ command: string }> } | undefined
    // The recovery CTA must point at --input-schema so agent can self-correct.
    expect(cta?.commands?.some((c) => (c.command as string).includes('--input-schema'))).toBe(true)
  })
})
