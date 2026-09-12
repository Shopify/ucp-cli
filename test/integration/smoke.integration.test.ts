// Compiled-binary smoke test against the real incur dispatcher. Confirms
// the bundle builds, the bin is launchable, build defines were inlined, and
// incur's serve() behavior matches what PROTOCOL expects (exit codes,
// --version, --llms, help on no args).
//
// Runs against the packaged bin entry (must `pnpm build` first; pnpm
// test:integration does so for you).

import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { RELEASES } from '../../src/core/releases.js'
import { startMockBusiness } from '../fixtures/mock-business.js'
import {
  MOCK_CART_ID,
  MOCK_LEGACY_PROFILE_PATH,
  startMockUcpShopping,
} from '../fixtures/mock-ucp-shopping.js'
import { freshUcpEnv } from '../fixtures/subprocess-env.js'

const execFileAsync = promisify(execFile)
const CLI_PATH = fileURLToPath(new URL('../../dist/bin.js', import.meta.url))

async function run(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync('node', [CLI_PATH, ...args])
    return { stdout, stderr, code: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number }
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? -1 }
  }
}

describe('smoke: compiled binary', () => {
  // `--version` answers two questions now. The build semver was never the
  // interesting one: the protocol version is chosen by the ACTIVE PROFILE, so
  // the only version fact a build can state is which releases it ships
  // schemas for. That window is derived from src/core/releases.ts, which is
  // why this asserts a shape rather than a literal.
  it('--version prints the build semver AND the protocol window, exits 0', async () => {
    const { stdout, code } = await run('--version')
    expect(stdout.trim()).toMatch(
      /^ucp \d+\.\d+\.\d+.* \(UCP \d{4}-\d{2}-\d{2}(, \d{4}-\d{2}-\d{2})*\)$/,
    )
    expect(code).toBe(0)
  })

  // Package managers (npm, pnpm, brew) install POSIX bins as symlinks pointing
  // into node_modules/.../dist/bin.js, so the CLI must run when reached via a
  // symlink (not just via the realpath). Earlier versions had a
  // `process.argv[1] === fileURLToPath(import.meta.url)` guard in src/cli.ts
  // that silently no-op'd for symlinks; src/bin.ts now unconditionally calls
  // runUcpCli(), so this failure class is architecturally impossible — this
  // test catches any future re-introduction cheaply (no pack/install needed).
  //
  // Skipped on Windows because (a) fs.symlink requires admin / Developer Mode
  // by default, and (b) Windows package managers install bins as .cmd shims
  // rather than symlinks, so a symlink probe wouldn't model real Windows
  // install behavior anyway. The Windows installed-bin path is covered by the
  // `real pnpm add -g` CI job, which uses the actual platform mechanism.
  it.skipIf(platform() === 'win32')(
    'serves when invoked through an installed-bin symlink',
    async () => {
      const binDir = await mkdtemp(join(tmpdir(), 'ucp-bin-symlink-'))
      const binPath = join(binDir, 'ucp')
      await symlink(CLI_PATH, binPath)

      const { stdout, stderr } = await execFileAsync('node', [binPath, '--version'])
      expect(stderr).toBe('')
      expect(stdout.trim()).toMatch(/^ucp \d+\.\d+\.\d+/)
    },
  )

  it('bare invocation prints help with the cli name + description, exits 0', async () => {
    const { stdout, code } = await run()
    expect(stdout).toContain('ucp@')
    expect(stdout).toContain('Reference CLI + MCP server for the Universal Commerce Protocol')
    expect(code).toBe(0)
  })

  it('--llms prints a manifest header for the cli, exits 0', async () => {
    const { stdout, code } = await run('--llms')
    expect(stdout).toContain('# ucp')
    expect(code).toBe(0)
  })

  it('unknown subcommand emits an error envelope and exits 1', async () => {
    const { stdout, code } = await run('not-a-real-command')
    expect(stdout).toContain('COMMAND_NOT_FOUND')
    expect(code).toBe(1)
  })

  // Hazard this gate exists for: top-level await in the bin entry suspends
  // module evaluation, and any module-scope CTA constant not yet initialized
  // silently drops out of the wire envelope. Unit tests import the module
  // first and cannot see it — only the compiled binary can, so this runs it.
  // A fresh install has a managed Profile, so the first missing session leg is
  // now the Business target.
  it('emits BUSINESS_NOT_RESOLVED with structured cta when no Business is selected', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ucp-no-session-'))
    const env = freshUcpEnv(home)
    const { stdout, code } = await new Promise<{ stdout: string; code: number }>((resolve) => {
      execFile('node', [CLI_PATH, 'cart', 'create'], { env }, (err, out) => {
        const e = err as { code?: number } | null
        resolve({ stdout: out, code: e?.code ?? 0 })
      })
    })
    expect(code).toBe(1)
    const parsed = JSON.parse(stdout) as { code: string; cta?: { commands?: unknown[] } }
    expect(parsed.code).toBe('BUSINESS_NOT_RESOLVED')
    expect(parsed.cta?.commands?.length ?? 0).toBeGreaterThan(0)
  })

  // --input-schema is the agent's introspection lever; it short-circuits before
  // dispatch but still flows through the same session resolver. Exercising
  // it via the compiled binary confirms the flag survives the build and lands
  // on the same missing-Business path as a normal operation.
  it('--input-schema also reports BUSINESS_NOT_RESOLVED on a fresh install', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ucp-describe-no-session-'))
    const env = freshUcpEnv(home)
    const { stdout, code } = await new Promise<{ stdout: string; code: number }>((resolve) => {
      execFile('node', [CLI_PATH, 'cart', 'create', '--input-schema'], { env }, (err, out) => {
        const e = err as { code?: number } | null
        resolve({ stdout: out, code: e?.code ?? 0 })
      })
    })
    expect(code).toBe(1)
    const parsed = JSON.parse(stdout) as { code: string; cta?: { commands?: unknown[] } }
    expect(parsed.code).toBe('BUSINESS_NOT_RESOLVED')
    expect(parsed.cta?.commands?.length ?? 0).toBeGreaterThan(0)
  })

  it('doctor --skip-network exits 0 on a fresh managed install', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ucp-doctor-ok-'))
    const env = freshUcpEnv(home)
    const { stdout, code } = await new Promise<{ stdout: string; code: number }>((resolve) => {
      execFile('node', [CLI_PATH, 'doctor', '--skip-network'], { env }, (err, out) => {
        const e = err as { code?: number } | null
        resolve({ stdout: out, code: e?.code ?? 0 })
      })
    })
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout) as { ok: boolean; checks: { id: string; status: string }[] }
    expect(parsed.ok).toBe(true)
    expect(parsed.checks.find((c) => c.id === 'active-profile')?.status).toBe('ok')
  })

  // A named selection is explicit and must never silently fall back to
  // managed. This also pins the compiled doctor's nonzero exit mechanism.
  it('doctor exits 1 for a ghost explicit active Profile, preserving checks', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ucp-doctor-ghost-'))
    const env = freshUcpEnv(home)
    await writeFile(join(home, 'active.yaml'), 'profile: ghost\n', 'utf-8')
    const { stdout, code } = await new Promise<{ stdout: string; code: number }>((resolve) => {
      execFile('node', [CLI_PATH, 'doctor', '--skip-network'], { env }, (err, out) => {
        const e = err as { code?: number } | null
        resolve({ stdout: out, code: e?.code ?? 0 })
      })
    })
    expect(code).toBe(1)
    const parsed = JSON.parse(stdout) as {
      ok: boolean
      checks: { id: string; status: string; detail: string }[]
    }
    expect(parsed.ok).toBe(false)
    const activeProfile = parsed.checks.find((check) => check.id === 'active-profile')
    expect(activeProfile?.status).toBe('fail')
    expect(activeProfile?.detail).toContain('ghost')
  })

  it('--help advertises --input-schema on op commands', async () => {
    const { stdout, code } = await run('catalog', 'search', '--help')
    expect(code).toBe(0)
    expect(stdout).toContain('--input-schema')
    // Description text is what makes the flag self-documenting; flag
    // presence alone is necessary but not sufficient.
    expect(stdout).toMatch(/input schema|payload schema/)
  })

  // Escalation hook is wired into every op command's --on-escalation flag.
  // Exercising the compiled binary's help confirms the flag survived the
  // build and the description is self-documenting (so an agent reading
  // `--help` knows the contract: shell command, JSON on stdin). Full
  // behavior is covered by src/core/escalation.test.ts and the
  // createUcpCli — escalation hook unit-test block.
  it('--help advertises --on-escalation on op commands', async () => {
    const { stdout, code } = await run('checkout', 'complete', '--help')
    expect(code).toBe(0)
    expect(stdout).toContain('--on-escalation')
    expect(stdout).toMatch(/escalation envelope|JSON on stdin/i)
  })
})

// `ucp --mcp` boots an MCP stdio server (incur built-in). MCP hosts can
// multiplex unrelated agent conversations through one process, so these tests
// pin both its deliberately narrow commerce surface and its isolation from
// per-user active.yaml routing state.
//
// Caveat: incur's Mcp.callTool path (Mcp.js callTool branch on !result.ok)
// strips UcpError → text-only `{content:[{type:'text', text:msg}], isError:true}`.
// That means the structured CTA/code/retryable envelope we surface on the
// CLI does NOT reach an MCP agent today. Tests assert on message substrings
// only. Tracked as a follow-up; see README "Caveats" for user-facing copy.
describe('smoke: --mcp stdio', () => {
  interface McpHandle {
    send(msg: Record<string, unknown>): void
    waitForResponseId(id: number, timeoutMs?: number): Promise<Record<string, unknown>>
    close(): Promise<void>
  }

  function launch(env: Record<string, string>): McpHandle {
    const proc = spawn('node', [CLI_PATH, '--mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    })
    // Surface child stderr only when explicitly debugging — otherwise a clean
    // run stays quiet, but `MCP_TEST_DEBUG=1 vitest` exposes crash output.
    if (process.env.MCP_TEST_DEBUG !== undefined) {
      proc.stderr.on('data', (chunk: Buffer) => {
        process.stderr.write(`[mcp-child] ${chunk}`)
      })
    }
    let buf = ''
    const responses: Record<string, unknown>[] = []
    const waiters = new Map<number, (msg: Record<string, unknown>) => void>()
    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      for (;;) {
        const idx = buf.indexOf('\n')
        if (idx === -1) break
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line) as Record<string, unknown>
          responses.push(msg)
          const id = msg.id
          if (typeof id === 'number' && waiters.has(id)) {
            const resolve = waiters.get(id)
            waiters.delete(id)
            resolve?.(msg)
          }
        } catch {
          // ignore non-JSON noise; MCP server only emits JSON-RPC framed lines.
        }
      }
    })
    return {
      send: (msg) => {
        proc.stdin.write(`${JSON.stringify(msg)}\n`)
      },
      waitForResponseId: (id, timeoutMs = 5000) =>
        new Promise((resolve, reject) => {
          const existing = responses.find((r) => r.id === id)
          if (existing !== undefined) return resolve(existing)
          const timer = setTimeout(() => {
            waiters.delete(id)
            reject(new Error(`timed out waiting for MCP response id=${id}`))
          }, timeoutMs)
          waiters.set(id, (msg) => {
            clearTimeout(timer)
            resolve(msg)
          })
        }),
      close: () =>
        new Promise<void>((resolve) => {
          proc.once('exit', () => resolve())
          proc.kill()
        }),
    }
  }

  async function initialize(handle: McpHandle): Promise<void> {
    handle.send({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'integration-test', version: '0.0.0' },
      },
    })
    await handle.waitForResponseId(0)
    handle.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  }

  function envFor(home: string): Record<string, string> {
    return freshUcpEnv(home)
  }

  // incur defaults MCP tool discovery to 'progressive', which publishes four
  // search/inspect/execute meta-tools in place of one tool per command. The
  // per-command names below are this CLI's agent contract, so cli.ts pins
  // discovery: 'direct'. A failure listing ~4 meta-tools means that pin
  // stopped taking effect and the contract silently changed.
  it('exposes one tool per command under tools/list (direct discovery)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ucp-mcp-tools-'))
    const env = envFor(home)

    const mcp = launch(env)
    try {
      await initialize(mcp)
      mcp.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      const response = (await mcp.waitForResponseId(1)) as {
        result: { tools: { name: string }[] }
      }
      const names = response.result.tools.map((t) => t.name).sort()
      expect(names).toEqual([
        'cart_cancel',
        'cart_create',
        'cart_get',
        'cart_update',
        'catalog_get_product',
        'catalog_lookup',
        'catalog_search',
        'checkout_cancel',
        'checkout_complete',
        'checkout_create',
        'checkout_get',
        'checkout_update',
        'discover',
        'order_get',
      ])
    } finally {
      await mcp.close()
    }
  })

  // active.yaml is process-global while an MCP server may serve many unrelated
  // conversations. Omitted routing must fail closed instead of inheriting
  // either active leg. The missing profile name also makes a leak distinguishable
  // from the managed default.
  it('ignores all active.yaml session state during tools/call', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ucp-mcp-session-'))
    const env = envFor(home)
    await writeFile(
      `${home}/active.yaml`,
      'profile: ghost\nbusiness: https://shop.example.invalid\n',
      'utf-8',
    )

    const mcp = launch(env)
    try {
      await initialize(mcp)
      mcp.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'cart_create',
          arguments: { input: '{"line_items":[]}' },
        },
      })
      const response = (await mcp.waitForResponseId(1)) as {
        result: { content: { text: string }[]; isError: boolean }
      }
      expect(response.result.isError).toBe(true)
      const text = response.result.content[0]?.text ?? ''
      expect(text).toMatch(/no target business resolved/)
      expect(text).toMatch(/Pass business in this tool call/)
      expect(text).toMatch(/UCP_BUSINESS/)
      expect(text).not.toMatch(/no local profile|ghost|ucp use|active\.yaml/)
      expect(text).not.toMatch(/shop\.example\.invalid|fetch failed/)
    } finally {
      await mcp.close()
    }
  })

  it('ignores active DIY routing and uses managed 08 for an explicit Business', async () => {
    const mock = await startMockUcpShopping()
    const home = await mkdtemp(join(tmpdir(), 'ucp-managed-mcp-'))
    const profileName = 'ambient-diy'
    const profileDir = join(home, 'profiles', profileName)
    try {
      await mkdir(profileDir, { recursive: true })
      await writeFile(
        join(profileDir, 'profile.json'),
        RELEASES['2026-04-08'].agentProfileJson,
        'utf-8',
      )
      await writeFile(
        join(profileDir, 'meta.json'),
        `${JSON.stringify(
          {
            format_version: 2,
            kind: 'diy',
            profile_url: 'https://agent.example.test/ambient-04-profile.json',
          },
          null,
          2,
        )}\n`,
        'utf-8',
      )
      await writeFile(
        join(home, 'active.yaml'),
        `profile: ${profileName}\nbusiness: https://wrong-business.example.invalid\n`,
        'utf-8',
      )

      const mcp = launch(envFor(home))
      try {
        await initialize(mcp)
        mcp.send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'cart_create',
            // No Profile argument: MCP must ignore active.yaml and default managed.
            arguments: { business: mock.url, input: '{"line_items":[]}' },
          },
        })
        const response = (await mcp.waitForResponseId(1)) as {
          result: { content: Array<{ text: string }>; isError?: boolean }
        }
        expect(response.result.isError).not.toBe(true)
        expect(response.result.content.map((item) => item.text).join('\n')).toContain(MOCK_CART_ID)

        const managedUrl = RELEASES['2026-08-25'].defaultAgentProfileUrl
        expect(mock.rpcRequests.map((request) => request.method)).toEqual([
          'tools/list',
          'tools/call',
        ])
        expect(mock.rpcRequests.map((request) => request.agentProfileUrl)).toEqual([
          managedUrl,
          managedUrl,
        ])
        expect(
          mock.requests.filter(
            (request) => request.method === 'GET' && request.path.startsWith('/.well-known/ucp'),
          ),
        ).toHaveLength(1)
        expect(mock.requests.some((request) => request.path === MOCK_LEGACY_PROFILE_PATH)).toBe(
          false,
        )
      } finally {
        await mcp.close()
      }
    } finally {
      await mock.close()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('defaults to managed and reports the missing Business on a fresh home', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ucp-mcp-nosession-'))
    const mcp = launch(envFor(home))
    try {
      await initialize(mcp)
      mcp.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'cart_create',
          arguments: { input: '{"line_items":[]}' },
        },
      })
      const response = (await mcp.waitForResponseId(1)) as {
        result: { content: { text: string }[]; isError: boolean }
      }
      expect(response.result.isError).toBe(true)
      // MCP path strips the structured envelope; message text is all we get.
      expect(response.result.content[0]?.text).toMatch(/no target business resolved/)
    } finally {
      await mcp.close()
    }
  })
})

describe('smoke: mock business fixture', () => {
  it('boots on an ephemeral port and serves configured routes', async () => {
    const mock = await startMockBusiness()
    try {
      mock.setRoute('GET', '/.well-known/ucp', (_req, res) => {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ schema_version: '2026-08-25', services: {} }))
      })
      const response = await fetch(`${mock.url}/.well-known/ucp`)
      expect(response.status).toBe(200)
      const body = (await response.json()) as { schema_version: string }
      expect(body.schema_version).toBe('2026-08-25')
    } finally {
      await mock.close()
    }
  })

  it('returns a structured 404 for unconfigured routes', async () => {
    const mock = await startMockBusiness()
    try {
      const response = await fetch(`${mock.url}/nope`)
      expect(response.status).toBe(404)
      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code).toBe('route_not_configured')
    } finally {
      await mock.close()
    }
  })
})
