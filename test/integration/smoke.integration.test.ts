// Compiled-binary smoke test against the real incur dispatcher. Confirms
// the bundle builds, the bin is launchable, build defines were inlined, and
// incur's serve() behavior matches what PROTOCOL expects (exit codes,
// --version, --llms, help on no args).
//
// Runs against the packaged bin entry (must `pnpm build` first; pnpm
// test:integration does so for you).

import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { startMockBusiness } from '../fixtures/mock-business.js'

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
  it('--version prints the build define semver and exits 0', async () => {
    const { stdout, code } = await run('--version')
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
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
      expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
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

  // Regression: top-level await in the bin entry used to suspend module
  // evaluation before BUSINESS_NOT_RESOLVED_CTA initialized, so the cta
  // silently disappeared from the wire envelope when the binary was invoked
  // directly (unit tests imported the module first, masking the bug). This
  // test runs the actual compiled binary so any future re-introduction of the
  // ordering hazard fails CI rather than getting caught in production.
  //
  // Profile init is now required before any dispatch. This regression gate
  // exercises the compiled binary's structured CTA path for that first-run
  // failure.
  it('emits PROFILE_NOT_FOUND with structured cta when no profile is initialized', async () => {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && k !== 'UCP_BUSINESS') env[k] = v
    }
    env.UCP_HOME = await mkdtemp(join(tmpdir(), 'ucp-no-session-'))
    const { stdout, code } = await new Promise<{ stdout: string; code: number }>((resolve) => {
      execFile('node', [CLI_PATH, 'cart', 'create'], { env }, (err, out) => {
        const e = err as { code?: number } | null
        resolve({ stdout: out, code: e?.code ?? 0 })
      })
    })
    expect(code).toBe(1)
    const parsed = JSON.parse(stdout) as { code: string; cta?: { commands?: unknown[] } }
    expect(parsed.code).toBe('PROFILE_NOT_FOUND')
    expect(parsed.cta?.commands?.length ?? 0).toBeGreaterThan(0)
  })

  // --input-schema is the agent's introspection lever; it short-circuits before
  // dispatch but still flows through the same session resolver. Exercising
  // it via the compiled binary confirms the flag survives the build and
  // lands on the same BUSINESS_NOT_RESOLVED path as a normal op when no
  // business is bound — i.e. agents trying to introspect first won't get
  // a different error shape than agents trying to dispatch.
  //
  // `--input-schema` still goes through session resolution, so it requires a local
  // profile before it can discover a business schema.
  it('--input-schema still requires an initialized profile', async () => {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && k !== 'UCP_BUSINESS') env[k] = v
    }
    env.UCP_HOME = await mkdtemp(join(tmpdir(), 'ucp-describe-no-session-'))
    const { stdout, code } = await new Promise<{ stdout: string; code: number }>((resolve) => {
      execFile('node', [CLI_PATH, 'cart', 'create', '--input-schema'], { env }, (err, out) => {
        const e = err as { code?: number } | null
        resolve({ stdout: out, code: e?.code ?? 0 })
      })
    })
    expect(code).toBe(1)
    const parsed = JSON.parse(stdout) as { code: string; cta?: { commands?: unknown[] } }
    expect(parsed.code).toBe('PROFILE_NOT_FOUND')
    expect(parsed.cta?.commands?.length ?? 0).toBeGreaterThan(0)
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

// `ucp --mcp` boots an MCP stdio server (incur built-in). These tests pin
// down whether the same session-resolution chain (option → UCP_BUSINESS →
// active.yaml) that drives the CLI also drives MCP tool dispatch — agents
// running ucp under Claude Desktop / Cursor / etc. must inherit a bound
// session, otherwise every tool call would have to ship `business` inline.
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
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && k !== 'UCP_BUSINESS') env[k] = v
    }
    env.UCP_HOME = home
    return env
  }

  // The single user-facing promise of `--mcp`: an agent that has already run
  // `ucp use <url>` doesn't have to re-supply `business` on every tool call.
  // If session resolution silently broke under MCP, agents would
  // see BUSINESS_NOT_RESOLVED on every call until they noticed the env gap.
  it('resolves business from active.yaml when tools/call omits business', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ucp-mcp-session-'))
    await mkdir(home, { recursive: true })
    const env = envFor(home)
    await execFileAsync('node', [CLI_PATH, 'profile', 'init', '--name', 'agent'], { env })
    // Bind a session pointing at an unreachable host. We're proving that
    // resolution succeeded (call gets past the BUSINESS_NOT_RESOLVED gate)
    // — not that the downstream HTTP call works.
    await writeFile(
      `${home}/active.yaml`,
      'profile: agent\nbusiness: https://shop.example.invalid\n',
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
          name: 'catalog_search',
          arguments: { input: '{"query":"boots"}' },
        },
      })
      const response = (await mcp.waitForResponseId(1)) as {
        result: { content: { text: string }[]; isError: boolean }
      }
      expect(response.result.isError).toBe(true)
      const text = response.result.content[0]?.text ?? ''
      // Two anti-assertions: must NOT be the no-session error, must show
      // we got past resolution to the network layer.
      expect(text).not.toMatch(/no target business resolved/)
      expect(text).toMatch(/shop\.example\.invalid|fetch failed/)
    } finally {
      await mcp.close()
    }
  })

  it('surfaces PROFILE_NOT_FOUND message when no profile is initialized', async () => {
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
      // Tracked separately — see README caveats.
      expect(response.result.content[0]?.text).toMatch(/no local profile selected/)
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
        res.end(JSON.stringify({ schema_version: '2026-04-08', services: {} }))
      })
      const response = await fetch(`${mock.url}/.well-known/ucp`)
      expect(response.status).toBe(200)
      const body = (await response.json()) as { schema_version: string }
      expect(body.schema_version).toBe('2026-04-08')
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
