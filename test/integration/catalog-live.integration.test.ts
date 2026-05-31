// Live integration test against the real Shopify global-catalog endpoint.
//
// Gated behind UCP_LIVE_TESTS=1 because:
//   - It hits a public endpoint we don't control. Flake there shouldn't block
//     default CI runs.
//   - Live runs are an explicit signal ("verify this works against prod"), not
//     a default cost paid on every `pnpm test`.
//
// Run with: UCP_LIVE_TESTS=1 pnpm test:integration catalog-live
//
// What this checks end-to-end:
//   1. Fresh UCP_HOME, run `profile init`, NO --business: bare `ucp catalog
//      search` should resolve through the local profile's runtime
//      DEFAULT_CATALOG_URL fallback and reach the live endpoint.
//   2. The response (a) is a valid UCP envelope (dispatch identity + result
//      payload present) and (b) carries a CTA. Specific variant shapes
//      (seller, checkout_url)
//      are NOT asserted here — the catalog may legitimately return zero
//      results for a query, and forcing inventory expectations would make this
//      a brittle gate on Shopify's merchandising state.
//
// catalog.shopify.com fetches the advertised `meta.ucp-agent.profile` during
// dispatch. Until managed upload lands, local profiles without `profile_url`
// advertise DEFAULT_PROFILE_URL as a known-reachable stopgap.

import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const CLI_PATH = fileURLToPath(new URL('../../dist/bin.js', import.meta.url))

const LIVE = process.env.UCP_LIVE_TESTS === '1' || process.env.UCP_LIVE_TESTS === 'true'

async function run(env: Record<string, string>, args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync('node', [CLI_PATH, ...args], {
      env: { ...process.env, ...env },
    })
    return { stdout, stderr, code: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number }
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? -1 }
  }
}

describe.skipIf(!LIVE)('live: Shopify global catalog (UCP_LIVE_TESTS=1)', () => {
  it('initialized local profile routes catalog search through DEFAULT_CATALOG_URL', async () => {
    // Pristine UCP_HOME, then explicit profile init. No `ucp use`; catalog ops
    // fall through to the runtime DEFAULT_CATALOG_URL synthesized for the local
    // profile.
    const home = await mkdtemp(join(tmpdir(), 'ucp-cli-live-'))
    const env = { UCP_HOME: home }

    const init = await run(env, ['profile', 'init', '--name', 'agent'])
    expect(init.code).toBe(0)

    const search = await run(env, ['catalog', 'search', '--set', '/query=trail map'])
    // Working means: catalog-fallback rung dispatched to the live endpoint
    // and returned a structured UCP envelope with dispatch identity
    // (`business`) and the catalog payload (`result`). The previous
    // MCP_INVALID_RESPONSE tolerance is gone: schema-dialect mismatches and
    // Ruby-flavor regex defects are now handled client-side by
    // validateOperationInput's soft-fail path, so a failure here is a real
    // regression.
    const body = JSON.parse(search.stdout) as Record<string, unknown>
    expect(body).toBeTypeOf('object')
    if (typeof body.business !== 'string') {
      expect.fail(`unexpected live response: ${search.stdout}\nstderr: ${search.stderr}`)
    }
    expect(body.result).toBeDefined()
    expect(body).toHaveProperty('cta')
  }, 30_000)
})
