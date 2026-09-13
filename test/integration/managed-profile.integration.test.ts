// Compiled managed/DIY Profile journeys.
//
// These tests cross the process boundary deliberately: they exercise dist/bin.js,
// the on-disk profile migration and caches, and a real local HTTP/JSON-RPC mock.
// Runs after `pnpm test:integration` builds the package.

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

import { RELEASES, SUPPORTED_VERSIONS } from '../../src/core/releases.js'
import { jsonResponse, startMockBusiness } from '../fixtures/mock-business.js'
import {
  MOCK_LEGACY_PROFILE_PATH,
  type MockUcpShopping,
  startMockUcpShopping,
} from '../fixtures/mock-ucp-shopping.js'
import { freshUcpEnv } from '../fixtures/subprocess-env.js'

const execFileAsync = promisify(execFile)
const CLI = fileURLToPath(new URL('../../dist/bin.js', import.meta.url))
const VERSION_04 = '2026-04-08' as const
const VERSION_08 = '2026-08-25' as const
const MANAGED_08_URL = RELEASES[VERSION_08].defaultAgentProfileUrl

interface CliRun {
  code: number
  stdout: string
  stderr: string
  json: unknown
}

async function runCli(
  home: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<CliRun> {
  let stdout = ''
  let stderr = ''
  let code = 0
  try {
    const result = await execFileAsync('node', [CLI, ...args], {
      env: freshUcpEnv(home, extraEnv),
    })
    stdout = result.stdout
    stderr = result.stderr
  } catch (err) {
    const failure = err as { stdout?: string; stderr?: string; code?: number }
    stdout = failure.stdout ?? ''
    stderr = failure.stderr ?? ''
    code = failure.code ?? -1
  }

  let json: unknown = null
  try {
    json = JSON.parse(stdout)
  } catch {
    // Keep raw output in the result so assertion diagnostics explain a failure.
  }
  return { code, stdout, stderr, json }
}

function diagnostic(run: CliRun): string {
  return `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`
}

interface DiscoveryResult {
  protocol: {
    version: string
    source: string
    agentProfileUrl: string
    businessProfileUrl: string
  }
}

function discovery(run: CliRun): DiscoveryResult {
  return (run.json as { result: DiscoveryResult }).result
}

function businessProfileGets(mock: MockUcpShopping): number {
  return mock.requests.filter(
    (request) => request.method === 'GET' && request.path.startsWith('/.well-known/ucp'),
  ).length
}

function toolsListRequests(mock: MockUcpShopping) {
  return mock.rpcRequests.filter((request) => request.method === 'tools/list')
}

async function removeHomeAndClose(home: string, mock: MockUcpShopping): Promise<void> {
  await mock.close()
  await rm(home, { recursive: true, force: true })
}

const HISTORICAL_GENERATED_PROFILES = [
  {
    label: 'ucp-cli 0.4.2–0.7.0 Profile',
    path: fileURLToPath(
      new URL('../fixtures/legacy-profiles/profile-0.4.2-to-0.7.0.json', import.meta.url),
    ),
  },
  {
    label: 'ucp-cli 0.8.0 Profile',
    path: fileURLToPath(new URL('../fixtures/legacy-profiles/profile-0.8.0.json', import.meta.url)),
  },
] as const

describe('managed Profile: compiled integration journeys', () => {
  it('uses the newest managed rendering from an empty home, then hits persistent caches across processes', async () => {
    const mock = await startMockUcpShopping()
    const home = await mkdtemp(join(tmpdir(), 'ucp-managed-empty-'))
    try {
      const first = await runCli(home, ['discover', '--business', mock.url])
      expect(first.code, diagnostic(first)).toBe(0)
      expect(discovery(first).protocol).toMatchObject({
        version: VERSION_08,
        source: 'well-known',
        agentProfileUrl: MANAGED_08_URL,
      })
      expect(businessProfileGets(mock)).toBe(1)
      expect(toolsListRequests(mock)).toHaveLength(1)
      expect(toolsListRequests(mock)[0]?.agentProfileUrl).toBe(MANAGED_08_URL)

      // A second dist/bin.js process shares only UCP_HOME. No in-memory memo
      // can satisfy this: both Business discovery and tools/list must come
      // directly from their on-disk cache entries.
      const second = await runCli(home, ['discover', '--business', mock.url])
      expect(second.code, diagnostic(second)).toBe(0)
      expect(discovery(second).protocol).toMatchObject({
        version: VERSION_08,
        source: 'well-known',
        agentProfileUrl: MANAGED_08_URL,
      })
      expect(businessProfileGets(mock)).toBe(1)
      expect(toolsListRequests(mock)).toHaveLength(1)
    } finally {
      await removeHomeAndClose(home, mock)
    }
  })

  it('isolates same-origin supported_versions leaves by full URL across compiled calls', async () => {
    const leafHost = await startMockBusiness()
    const leafPathA = `/profiles/business-a/${VERSION_04}.json`
    const leafPathB = `/profiles/business-b/${VERSION_04}.json`
    const leafUrlA = `${leafHost.url}${leafPathA}`
    const leafUrlB = `${leafHost.url}${leafPathB}`
    const [businessA, businessB] = await Promise.all([
      startMockUcpShopping({ legacyProfileUrl: leafUrlA }),
      startMockUcpShopping({ legacyProfileUrl: leafUrlB }),
    ])
    const home = await mkdtemp(join(tmpdir(), 'ucp-shared-leaf-cache-'))

    const leafProfile = (endpoint: string) => ({
      ucp: {
        version: VERSION_04,
        status: 'success',
        services: {
          'dev.ucp.shopping': [
            {
              version: VERSION_04,
              spec: 'https://ucp.dev/specification/overview/',
              schema: 'https://ucp.dev/services/shopping/openrpc.json',
              transport: 'mcp',
              endpoint,
            },
          ],
        },
        payment_handlers: {},
      },
      keys: [],
    })
    leafHost.setRoute('GET', leafPathA, (_req, res) => {
      jsonResponse(res, 200, leafProfile(businessA.mcpEndpoint))
    })
    leafHost.setRoute('GET', leafPathB, (_req, res) => {
      jsonResponse(res, 200, leafProfile(businessB.mcpEndpoint))
    })

    try {
      expect(businessA.url).not.toBe(businessB.url)
      const initialized = await runCli(home, [
        'profile',
        'init',
        '--name',
        'legacy',
        '--version',
        VERSION_04,
        '--activate',
      ])
      expect(initialized.code, diagnostic(initialized)).toBe(0)

      const first = await runCli(home, [
        'catalog',
        'search',
        '--business',
        businessA.url,
        '--set',
        '/query=business-a',
      ])
      expect(first.code, diagnostic(first)).toBe(0)
      expect(businessA.rpcRequests.map((request) => request.method)).toEqual([
        'tools/list',
        'tools/call',
      ])
      const requestsToA = businessA.rpcRequests.length

      const second = await runCli(home, [
        'catalog',
        'search',
        '--business',
        businessB.url,
        '--set',
        '/query=business-b',
      ])
      expect(second.code, diagnostic(second)).toBe(0)

      expect(leafHost.requests.map((request) => request.path)).toEqual([leafPathA, leafPathB])
      expect(businessA.rpcRequests).toHaveLength(requestsToA)
      expect(businessB.rpcRequests.map((request) => request.method)).toEqual([
        'tools/list',
        'tools/call',
      ])
    } finally {
      await Promise.all([businessA.close(), businessB.close(), leafHost.close()])
      await rm(home, { recursive: true, force: true })
    }
  })

  it('loads an active edited ucp-cli 0.4.2–0.7.0 Profile as DIY with zero recovery action', async () => {
    const mock = await startMockUcpShopping()
    const home = await mkdtemp(join(tmpdir(), 'ucp-edited-042-070-'))
    const name = 'edited-042-070'
    const dir = join(home, 'profiles', name)
    const profilePath = join(dir, 'profile.json')
    const metaPath = join(dir, 'meta.json')
    const headersPath = join(dir, 'headers.json')
    const activePath = join(home, 'active.yaml')
    const storedProfileUrl = 'https://agent.example.test/edited-042-070.json'
    try {
      const body = JSON.parse(await readFile(HISTORICAL_GENERATED_PROFILES[0].path, 'utf-8')) as {
        ucp: { capabilities: Record<string, unknown> }
      }
      body.ucp.capabilities['com.acme.loyalty'] = [
        {
          version: VERSION_04,
          spec: 'https://example.com/ucp/loyalty/spec',
          schema: 'https://example.com/ucp/loyalty/schema.json',
        },
      ]
      const profileBytes = `${JSON.stringify(body, null, 2)}\n`
      const originalMeta = {
        created_at: '2026-01-01T00:00:00.000Z',
        profile_url: storedProfileUrl,
        protocol_versions: { min: '2026-01-23', max: VERSION_04 },
      }
      const headersBytes = `${JSON.stringify({
        default: { 'Integration-Marker': 'from-profile' },
      })}\n`
      const activeBytes = `profile: ${name}\nbusiness: ${mock.url}\n`
      await mkdir(dir, { recursive: true })
      await writeFile(profilePath, profileBytes, 'utf-8')
      await writeFile(metaPath, `${JSON.stringify(originalMeta)}\n`, 'utf-8')
      await writeFile(headersPath, headersBytes, 'utf-8')
      await writeFile(activePath, activeBytes, 'utf-8')

      const discovered = await runCli(home, ['discover', '--verbose'])
      expect(discovered.code, diagnostic(discovered)).toBe(0)
      expect(discovery(discovered).protocol).toEqual({
        version: VERSION_04,
        source: 'supported_versions',
        agentProfileUrl: storedProfileUrl,
        businessProfileUrl: `${mock.url}${MOCK_LEGACY_PROFILE_PATH}`,
      })
      expect(discovered.stderr).toContain('source bytes remain unchanged')
      expect(discovered.stderr).toContain('Integration-Marker: from-profile')
      // The mock records the advertised URL on tools/list; it does not dereference it.
      expect(toolsListRequests(mock)).toEqual([
        expect.objectContaining({ agentProfileUrl: storedProfileUrl }),
      ])

      const shown = await runCli(home, ['profile', 'show'])
      expect(shown.code, diagnostic(shown)).toBe(0)
      expect(shown.json).toMatchObject({
        name,
        kind: 'diy',
        active: true,
        renderings: [{ version: VERSION_04, profile_url: storedProfileUrl }],
        body: {
          ucp: { capabilities: { 'com.acme.loyalty': body.ucp.capabilities['com.acme.loyalty'] } },
        },
        meta: { ...originalMeta, format_version: 2, kind: 'diy' },
      })
      expect(await readFile(activePath, 'utf-8')).toBe(activeBytes)
      expect(await readFile(profilePath, 'utf-8')).toBe(profileBytes)
      expect(await readFile(headersPath, 'utf-8')).toBe(headersBytes)
    } finally {
      await removeHomeAndClose(home, mock)
    }
  })

  it.each(HISTORICAL_GENERATED_PROFILES)(
    '$label is marked managed once, gains every installed rendering, and preserves user bytes',
    async ({ path }) => {
      const mock = await startMockUcpShopping()
      const home = await mkdtemp(join(tmpdir(), 'ucp-managed-upgrade-'))
      const name = 'historical'
      const dir = join(home, 'profiles', name)
      const profileBytes = await readFile(path)
      const headersBytes = Buffer.from(
        '{\n\t"default": {"X-Integration": "legacy"},\n\t"businesses": {}\n}',
      )
      const originalMeta = {
        created_at: '2026-01-01T00:00:00.000Z',
        historical_note: 'preserve this field',
      }
      try {
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, 'profile.json'), profileBytes)
        await writeFile(join(dir, 'meta.json'), `${JSON.stringify(originalMeta, null, 2)}\n`)
        await writeFile(join(dir, 'headers.json'), headersBytes)
        await writeFile(
          join(home, 'active.yaml'),
          `profile: ${name}\nbusiness: ${mock.url}\n`,
          'utf-8',
        )

        const discovered = await runCli(home, ['discover'])
        expect(discovered.code, diagnostic(discovered)).toBe(0)
        expect(discovery(discovered).protocol).toMatchObject({
          version: VERSION_08,
          source: 'well-known',
          agentProfileUrl: MANAGED_08_URL,
        })
        expect(toolsListRequests(mock)[0]?.agentProfileUrl).toBe(MANAGED_08_URL)

        const markedMetaBytes = await readFile(join(dir, 'meta.json'))
        expect(JSON.parse(markedMetaBytes.toString())).toMatchObject({
          ...originalMeta,
          format_version: 2,
          kind: 'managed',
        })
        expect(await readFile(join(dir, 'profile.json'))).toEqual(profileBytes)
        expect(await readFile(join(dir, 'headers.json'))).toEqual(headersBytes)

        // A second compiled read consumes the marker instead of classifying or
        // rewriting again, and exposes the complete managed rendering set.
        const shown = await runCli(home, ['profile', 'show', name])
        expect(shown.code, diagnostic(shown)).toBe(0)
        expect(shown.json).toMatchObject({
          name,
          kind: 'managed',
          renderings: SUPPORTED_VERSIONS.map((version) => ({
            version,
            profile_url: RELEASES[version].defaultAgentProfileUrl,
          })),
        })
        expect(await readFile(join(dir, 'meta.json'))).toEqual(markedMetaBytes)
        expect(await readFile(join(dir, 'profile.json'))).toEqual(profileBytes)
        expect(await readFile(join(dir, 'headers.json'))).toEqual(headersBytes)
      } finally {
        await removeHomeAndClose(home, mock)
      }
    },
  )

  it('keeps an explicit 04-08 DIY Profile pinned to its custom URL and leaves its files untouched', async () => {
    const mock = await startMockUcpShopping()
    const home = await mkdtemp(join(tmpdir(), 'ucp-diy-pinned-'))
    const customUrl = 'https://agent.example.test/custom-04-profile.json'
    const activePath = join(home, 'active.yaml')
    try {
      // `profile init` is intentionally the one integration journey that keeps
      // setup ceremony: it proves current init writes marked DIY Profiles and
      // changes the active selection only when --activate is present.
      const businessOnly = `business: ${mock.url}\n`
      await writeFile(activePath, businessOnly, 'utf-8')
      const dormant = await runCli(home, [
        'profile',
        'init',
        '--name',
        'dormant',
        '--version',
        VERSION_04,
      ])
      expect(dormant.code, diagnostic(dormant)).toBe(0)
      expect(dormant.json).toMatchObject({ created: true, activated: false })
      expect(await readFile(activePath, 'utf-8')).toBe(businessOnly)

      const initialized = await runCli(home, [
        'profile',
        'init',
        '--name',
        'custom',
        '--version',
        VERSION_04,
        '--profile-url',
        customUrl,
        '--activate',
      ])
      expect(initialized.code, diagnostic(initialized)).toBe(0)
      expect(initialized.json).toMatchObject({
        name: 'custom',
        created: true,
        activated: true,
        version: VERSION_04,
        profile_url: customUrl,
      })

      const dir = join(home, 'profiles', 'custom')
      expect(JSON.parse(await readFile(join(dir, 'meta.json'), 'utf-8'))).toMatchObject({
        format_version: 2,
        kind: 'diy',
        profile_url: customUrl,
      })
      expect(await readFile(activePath, 'utf-8')).toContain('profile: custom')

      const before = {
        profile: await readFile(join(dir, 'profile.json')),
        meta: await readFile(join(dir, 'meta.json')),
        active: await readFile(activePath),
      }

      const discovered = await runCli(home, ['discover'])
      expect(discovered.code, diagnostic(discovered)).toBe(0)
      expect(discovery(discovered).protocol).toEqual({
        version: VERSION_04,
        source: 'supported_versions',
        agentProfileUrl: customUrl,
        businessProfileUrl: `${mock.url}${MOCK_LEGACY_PROFILE_PATH}`,
      })
      expect(
        mock.requests.some(
          (request) => request.method === 'GET' && request.path === MOCK_LEGACY_PROFILE_PATH,
        ),
      ).toBe(true)
      expect(toolsListRequests(mock)[0]?.agentProfileUrl).toBe(customUrl)

      expect(await readFile(join(dir, 'profile.json'))).toEqual(before.profile)
      expect(await readFile(join(dir, 'meta.json'))).toEqual(before.meta)
      expect(await readFile(activePath)).toEqual(before.active)
    } finally {
      await removeHomeAndClose(home, mock)
    }
  })
})
