// Escalation hook: resolution order + JSON-on-stdin contract + MCP no-op.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { nodeHookCommand } from '../../test/fixtures/shell-command.js'

import {
  buildEscalationPayload,
  type EscalationPayload,
  isEscalationEnvelope,
  resolveEscalationHook,
  runEscalationHook,
} from './escalation.js'
import { setVerboseWriter } from './verbose.js'

// Helper: capture stderr writes off a fake stream so tests can assert on
// passthrough output without touching process.stderr.
class StderrSink {
  chunks: Buffer[] = []
  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    return true
  }
  text(): string {
    return Buffer.concat(this.chunks).toString('utf-8')
  }
}

const SAMPLE_PAYLOAD: EscalationPayload = {
  status: 'requires_escalation',
  url: 'https://shop.example.com/3ds/abc',
  reason: '3DS challenge required',
  business: 'https://shop.example.com',
  operation: 'complete_checkout',
}

async function writeHookScript(dir: string, name: string, source: string): Promise<string> {
  const script = join(dir, name)
  await writeFile(script, source, 'utf-8')
  return script
}

describe('isEscalationEnvelope', () => {
  it('matches flat checkout response with requires_escalation status', () => {
    expect(
      isEscalationEnvelope({
        id: 'chk_1',
        status: 'requires_escalation',
        continue_url: 'https://shop.example.com/checkout',
      }),
    ).toBe(true)
  })

  it.each([
    null,
    undefined,
    'string',
    42,
    {},
    { checkout: { status: 'requires_escalation' } }, // old wrapped shape — no longer matches
    { status: 'incomplete' },
    // Review is a message severity (`requires_buyer_review`), not a checkout status.
    { status: 'requires_review' },
    { status: 'completed' },
    { status: 'ready_for_complete' },
    { status: 5 },
  ])('rejects non-escalation: %j', (value) => {
    expect(isEscalationEnvelope(value)).toBe(false)
  })
})

describe('buildEscalationPayload', () => {
  it('extracts continue_url and message content from flat checkout response', () => {
    const built = buildEscalationPayload(
      {
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
      },
      { business: 'https://shop.example.com', operation: 'complete_checkout' },
    )
    expect(built).toMatchObject({
      status: 'requires_escalation',
      url: 'https://shop.example.com/3ds/abc',
      reason: '3DS challenge required',
      business: 'https://shop.example.com',
      operation: 'complete_checkout',
    })
  })

  it('extracts buyer-input escalation reasons from requires_escalation responses', () => {
    const built = buildEscalationPayload(
      {
        status: 'requires_escalation',
        continue_url: 'https://shop.example.com/customize/abc',
        messages: [
          {
            type: 'error',
            code: 'customization_required',
            severity: 'requires_buyer_input',
            content: 'Choose personalization in merchant UI',
          },
        ],
      },
      { business: 'https://shop.example.com', operation: 'update_checkout' },
    )
    expect(built).toMatchObject({
      status: 'requires_escalation',
      url: 'https://shop.example.com/customize/abc',
      reason: 'Choose personalization in merchant UI',
      business: 'https://shop.example.com',
      operation: 'update_checkout',
    })
  })

  it('uses dispatcher context for business/operation and handles missing messages', () => {
    const built = buildEscalationPayload(
      { status: 'requires_escalation' },
      { business: 'https://shop.example.com', operation: 'complete_checkout' },
    )
    expect(built).toMatchObject({
      status: 'requires_escalation',
      business: 'https://shop.example.com',
      operation: 'complete_checkout',
    })
    expect(built.url).toBeUndefined()
    expect(built.reason).toBeUndefined()
  })
})

describe('resolveEscalationHook', () => {
  let homeDir: string

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ucp-cli-escalation-test-'))
  })

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  it('returns undefined when no source is configured', async () => {
    expect(await resolveEscalationHook({ env: {}, homeDir })).toBeUndefined()
  })

  it('argFlag wins over env and config', async () => {
    await writeFile(join(homeDir, 'config.yaml'), 'escalation:\n  command: echo config\n', 'utf-8')

    const hook = await resolveEscalationHook({
      argFlag: 'echo flag',
      env: { UCP_ON_ESCALATION: 'echo env' },
      homeDir,
    })
    expect(hook).toEqual({ source: 'flag', command: 'echo flag' })
  })

  it('env wins over config', async () => {
    await writeFile(join(homeDir, 'config.yaml'), 'escalation:\n  command: echo config\n', 'utf-8')

    const hook = await resolveEscalationHook({
      env: { UCP_ON_ESCALATION: 'echo env' },
      homeDir,
    })
    expect(hook).toEqual({ source: 'env', command: 'echo env' })
  })

  it('config.yaml is the lowest-priority source', async () => {
    await writeFile(join(homeDir, 'config.yaml'), 'escalation:\n  command: echo config\n', 'utf-8')

    const hook = await resolveEscalationHook({ env: {}, homeDir })
    expect(hook).toEqual({ source: 'config', command: 'echo config' })
  })

  it.each([
    ['empty argFlag', { argFlag: '', env: { UCP_ON_ESCALATION: 'echo env' } }],
    ['empty env', { env: { UCP_ON_ESCALATION: '' } }],
  ])('treats %s as not-set so unsetting falls through', async (_, opts) => {
    // No config.yaml ⇒ should resolve to undefined when both upper sources are
    // explicitly empty.
    const hook = await resolveEscalationHook({ ...opts, homeDir })
    if ('env' in opts && opts.env.UCP_ON_ESCALATION === '') {
      expect(hook).toBeUndefined()
    } else {
      // empty argFlag falls through to env
      expect(hook).toEqual({ source: 'env', command: 'echo env' })
    }
  })

  it('ignores config.yaml when the file is not parseable', async () => {
    await writeFile(join(homeDir, 'config.yaml'), 'not: : : valid', 'utf-8')
    expect(await resolveEscalationHook({ env: {}, homeDir })).toBeUndefined()
  })

  it('ignores config.yaml when escalation.command is missing or wrong type', async () => {
    await writeFile(join(homeDir, 'config.yaml'), 'escalation:\n  kind: stdout\n', 'utf-8')
    expect(await resolveEscalationHook({ env: {}, homeDir })).toBeUndefined()

    await writeFile(join(homeDir, 'config.yaml'), 'escalation:\n  command: 5\n', 'utf-8')
    expect(await resolveEscalationHook({ env: {}, homeDir })).toBeUndefined()
  })
})

describe('runEscalationHook', () => {
  it('returns invoked=false with reason=mcp-mode when skip=true', async () => {
    const result = await runEscalationHook({
      hook: { source: 'env', command: 'echo should-not-run' },
      payload: SAMPLE_PAYLOAD,
      skip: true,
    })
    expect(result).toEqual({ invoked: false, reason: 'mcp-mode' })
  })

  it('returns invoked=false with reason=no-hook when no hook resolved', async () => {
    const result = await runEscalationHook({ hook: undefined, payload: SAMPLE_PAYLOAD })
    expect(result).toEqual({ invoked: false, reason: 'no-hook' })
  })

  it('passes JSON payload on stdin to the shell command', async () => {
    // Verify stdin contract by writing payload to a tmpfile from inside the
    // hook. A tiny Node command is intentionally cross-platform; shell syntax
    // is what we're transporting through, not what this test should depend on.
    const tmpDir = await mkdtemp(join(tmpdir(), 'ucp-cli-escalation-stdin-'))
    const captureFile = join(tmpDir, 'captured.json')
    const captureScript = await writeHookScript(
      tmpDir,
      'capture.cjs',
      "process.stdin.pipe(require('node:fs').createWriteStream(process.argv[2]))\n",
    )
    try {
      const stderr = new StderrSink()
      const result = await runEscalationHook({
        hook: {
          source: 'env',
          command: nodeHookCommand(captureScript, captureFile),
        },
        payload: SAMPLE_PAYLOAD,
        stderr,
      })
      expect(result.invoked).toBe(true)
      if (result.invoked) {
        expect(result.exitCode).toBe(0)
        expect(result.timedOut).toBe(false)
      }
      const { readFile } = await import('node:fs/promises')
      const captured = await readFile(captureFile, 'utf-8')
      // Trailing newline is intentional (we end stdin with `\n`).
      expect(JSON.parse(captured.trim())).toEqual(SAMPLE_PAYLOAD)
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('captures hook stderr without passing arbitrary hook chatter through by default', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'ucp-cli-escalation-stderr-'))
    try {
      const script = await writeHookScript(
        tmpDir,
        'stderr.cjs',
        "process.stderr.write('BOOM\\n')\n",
      )
      const stderr = new StderrSink()
      const result = await runEscalationHook({
        hook: {
          source: 'env',
          command: nodeHookCommand(script),
        },
        payload: SAMPLE_PAYLOAD,
        stderr,
      })
      expect(result.invoked).toBe(true)
      if (result.invoked) expect(result.stderr).toContain('BOOM')
      expect(stderr.text()).toBe('')
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('passes hook stderr through to the supplied writer in verbose mode', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'ucp-cli-escalation-stderr-verbose-'))
    setVerboseWriter(() => {})
    try {
      const script = await writeHookScript(
        tmpDir,
        'stderr.cjs',
        "process.stderr.write('BOOM\\n')\n",
      )
      const stderr = new StderrSink()
      const result = await runEscalationHook({
        hook: {
          source: 'env',
          command: nodeHookCommand(script),
        },
        payload: SAMPLE_PAYLOAD,
        stderr,
      })
      expect(result.invoked).toBe(true)
      if (result.invoked) expect(result.stderr).toContain('BOOM')
      expect(stderr.text()).toContain('BOOM')
    } finally {
      setVerboseWriter(null)
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('logs non-zero exit but reports invoked=true', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'ucp-cli-escalation-exit-'))
    try {
      const script = await writeHookScript(tmpDir, 'exit.cjs', 'process.exit(7)\n')
      const stderr = new StderrSink()
      const result = await runEscalationHook({
        hook: { source: 'env', command: nodeHookCommand(script) },
        payload: SAMPLE_PAYLOAD,
        stderr,
      })
      expect(result.invoked).toBe(true)
      if (result.invoked) {
        expect(result.exitCode).toBe(7)
      }
      expect(stderr.text()).toContain('exited with code 7')
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('logs spawn-failure when the shell binary is missing', async () => {
    // With the file-source convention removed, every hook routes through the
    // shell. The remaining spawn-failure path is the shell binary itself being
    // absent — inject it explicitly so we exercise the child.on('error') branch
    // without relying on a platform path that happens to not exist.
    const stderr = new StderrSink()
    const result = await runEscalationHook({
      hook: { source: 'env', command: 'echo unused' },
      payload: SAMPLE_PAYLOAD,
      stderr,
      shell: '/nonexistent/path/to/shell-binary-that-does-not-exist',
    })
    expect(result.invoked).toBe(true)
    if (result.invoked) {
      expect(result.exitCode).toBeNull()
    }
    expect(stderr.text()).toContain('failed to start')
  })

  it('kills the hook on timeout and reports timedOut=true', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'ucp-cli-escalation-timeout-'))
    try {
      const script = await writeHookScript(
        tmpDir,
        'timeout.cjs',
        'setInterval(function(){}, 1000)\n',
      )
      const stderr = new StderrSink()
      const result = await runEscalationHook({
        hook: { source: 'env', command: nodeHookCommand(script) },
        payload: SAMPLE_PAYLOAD,
        stderr,
        timeoutMs: 100,
      })
      expect(result.invoked).toBe(true)
      if (result.invoked) {
        expect(result.timedOut).toBe(true)
      }
      expect(stderr.text()).toContain('timed out after 100ms')
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('discards hook stdout (does not leak into parent stdout)', async () => {
    // We can't easily intercept process.stdout here, but we can prove the
    // call does not surface stdout in the result envelope. Combined with the
    // implementation discarding the data event, this guards against MCP
    // stream corruption.
    const tmpDir = await mkdtemp(join(tmpdir(), 'ucp-cli-escalation-stdout-'))
    try {
      const script = await writeHookScript(tmpDir, 'stdout.cjs', "console.log('SHOULD-NOT-LEAK')\n")
      const result = await runEscalationHook({
        hook: { source: 'env', command: nodeHookCommand(script) },
        payload: SAMPLE_PAYLOAD,
      })
      expect(result.invoked).toBe(true)
      // No `stdout` field on the result envelope by design — captured = discarded.
      expect(result).not.toHaveProperty('stdout')
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })
})
