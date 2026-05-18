// Escalation hook: external notifier for checkout buyer-handoff responses.
//
// When a checkout response returns `status: "requires_escalation"`, the CLI
// fires a single user-configured shell command with the escalation payload as
// JSON on stdin. The hook is *notification*, not gating — its exit code is
// logged but does not change the operation outcome (the op still exits 0 with
// the structured checkout response).
//
// Resolution order (first match wins):
//   1. CLI flag      --on-escalation '<cmd>'
//   2. Env var       UCP_ON_ESCALATION='<cmd>'
//   3. Config field  ~/.ucp/config.yaml: escalation.command
//
// All sources are shell command strings run through the platform shell
// (`/bin/sh -c` on POSIX, `cmd.exe /d /s /c` on Windows). One contract, one
// model, identical on every OS. Going single-command + JSON-on-stdin instead
// of typed hook kinds keeps the CLI's surface tiny and lets users compose
// browsers, Slack, notifications, etc. via shell pipes they already know.
//
// Earlier versions also supported a POSIX-only file convention
// (`~/.ucp/hooks/escalation`, executable). It was dropped because:
//   - it duplicated config-source (“put your command in a file” vs “point
//     config at a file”),
//   - its `X_OK` executability check has no Windows-meaningful semantics,
//   - it introduced platform asymmetry users had to learn around.
// Users who want “drop a script and run it” should reference the script from
// config: `escalation.command: '/path/to/escalation.sh'`.
//
// MCP server mode is a no-op: an MCP server must not surprise the host
// process by spawning subprocesses or opening browsers. The structured
// envelope reaches the agent regardless.

import { type SpawnOptions, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { parse as parseYaml } from 'yaml'

import { profileStoreHome } from './profile-store.js'
import { verboseEnabled } from './verbose.js'

/**
 * Payload sent to the hook on stdin. Compact checkout-handoff context; fields
 * are optional because servers populate them per UCP spec and operation.
 */
export interface EscalationPayload {
  status: string
  url?: string
  reason?: string
  business?: string
  operation?: string
  structured_action?: Record<string, unknown>
}

export type HookSource = 'flag' | 'env' | 'config'

export interface EscalationHook {
  source: HookSource
  /** Shell command line. Always run through the platform shell. */
  command: string
}

export interface ResolveHookOptions {
  /** Value of `--on-escalation` CLI flag, if present. */
  argFlag?: string | undefined
  /** Override env (test injection). Defaults to process.env. */
  env?: NodeJS.ProcessEnv | undefined
  /** Override `~/.ucp/` (test injection). Defaults to UCP_HOME or home. */
  homeDir?: string | undefined
}

/**
 * Walk the three sources in order; return the first match. Empty strings are
 * treated as not-set so `UCP_ON_ESCALATION=` falls through to lower-priority
 * sources — otherwise users can't unset an inherited value.
 */
export async function resolveEscalationHook(
  opts: ResolveHookOptions = {},
): Promise<EscalationHook | undefined> {
  if (opts.argFlag !== undefined && opts.argFlag.length > 0) {
    return { source: 'flag', command: opts.argFlag }
  }
  const env = opts.env ?? process.env
  const envCmd = env.UCP_ON_ESCALATION
  if (typeof envCmd === 'string' && envCmd.length > 0) {
    return { source: 'env', command: envCmd }
  }
  const home = profileStoreHome({ ...(opts.homeDir !== undefined && { homeDir: opts.homeDir }) })
  const configCmd = await readConfigCommand(home)
  if (configCmd !== undefined) {
    return { source: 'config', command: configCmd }
  }
  return undefined
}

async function readConfigCommand(home: string): Promise<string | undefined> {
  let raw: string
  try {
    raw = await readFile(join(home, 'config.yaml'), 'utf-8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const escalation = (parsed as Record<string, unknown>).escalation
  if (typeof escalation !== 'object' || escalation === null) return undefined
  const command = (escalation as Record<string, unknown>).command
  return typeof command === 'string' && command.length > 0 ? command : undefined
}

export type RunHookResult =
  | { invoked: false; reason: 'no-hook' | 'mcp-mode' }
  | {
      invoked: true
      source: HookSource
      exitCode: number | null
      durationMs: number
      stderr: string
      timedOut: boolean
    }

export interface RunHookOptions {
  hook: EscalationHook | undefined
  payload: EscalationPayload
  /** Skip even if a hook is resolved. Set true in MCP server mode. */
  skip?: boolean
  /** Hard timeout. Default 30_000 ms. */
  timeoutMs?: number
  /**
   * Destination for hook diagnostics. Lifecycle failures are always written
   * here; arbitrary hook stderr is captured and only mirrored when verbose
   * mode is enabled. The minimal `write` shape (instead of
   * {@link NodeJS.WritableStream}) keeps test doubles trivial.
   */
  stderr?: { write(chunk: string | Uint8Array): boolean | unknown }
  /** Shell binary for sources flag/env/config. Defaults to the platform shell. */
  shell?: string
}

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Spawn the hook with the JSON payload on stdin. Hook stdout is captured and
 * discarded — agents pipe inside their own command, not via us. Hook stderr is
 * captured for the result and mirrored only in verbose mode; lifecycle failures
 * (failed start, timeout, non-zero exit) are always written because the
 * configured notification side effect did not complete cleanly.
 *
 * Stdout discard is critical in MCP mode (which we skip entirely here, but
 * defense-in-depth: hook stdout could otherwise corrupt the JSON-RPC stream).
 */
export async function runEscalationHook(opts: RunHookOptions): Promise<RunHookResult> {
  if (opts.skip === true) return { invoked: false, reason: 'mcp-mode' }
  if (opts.hook === undefined) return { invoked: false, reason: 'no-hook' }

  const hook = opts.hook
  const stderr = opts.stderr ?? process.stderr
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const usesDefaultPlatformShell = opts.shell === undefined
  const shell = opts.shell ?? defaultShell()
  const shellArgs = usesDefaultPlatformShell ? defaultShellArgs(hook.command) : ['-c', hook.command]

  return new Promise<RunHookResult>((resolve) => {
    const start = Date.now()
    const stderrChunks: Buffer[] = []
    let timedOut = false

    const spawnOptions: SpawnOptions = {
      stdio: ['pipe', 'pipe', 'pipe'],
      // On POSIX, put the hook in its own process group so timeout cleanup can
      // kill shell grandchildren too (`sh -c "sleep 10"` often leaves `sleep`
      // holding stdio open after only the shell is killed). Windows has no
      // negative-PID process groups; timeout cleanup uses taskkill there.
      detached: process.platform !== 'win32',
      // For `cmd.exe /c <command>`, Node's default Windows argv quoting escapes
      // inner quotes before cmd parses them. That makes commands like
      // `node "C:\\Temp\\hook.cjs"` reach Node with literal quote characters in
      // argv[1]. Shell hooks always provide a complete command string, so pass
      // the cmd argv through verbatim and let cmd own command-string parsing.
      windowsVerbatimArguments: process.platform === 'win32' && usesDefaultPlatformShell,
    }
    const child = spawn(shell, shellArgs, spawnOptions)

    const timer = setTimeout(() => {
      timedOut = true
      killHookProcess(child.pid)
    }, timeoutMs)

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk)
      if (verboseEnabled()) stderr.write(chunk)
    })
    // Stdout intentionally drained but discarded.
    child.stdout?.on('data', () => {})

    child.on('error', (err) => {
      clearTimeout(timer)
      const msg = `[ucp] escalation hook (${hook.source}) failed to start: ${err.message}\n`
      stderr.write(msg)
      resolve({
        invoked: true,
        source: hook.source,
        exitCode: null,
        durationMs: Date.now() - start,
        stderr: msg,
        timedOut: false,
      })
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        stderr.write(`[ucp] escalation hook (${hook.source}) timed out after ${timeoutMs}ms\n`)
      } else if (code !== 0 && code !== null) {
        stderr.write(`[ucp] escalation hook (${hook.source}) exited with code ${code}\n`)
      }
      resolve({
        invoked: true,
        source: hook.source,
        exitCode: code,
        durationMs: Date.now() - start,
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        timedOut,
      })
    })

    // Swallow EPIPE: a fast-exiting hook (e.g. `exit 7`, SIGKILL on timeout)
    // can close its stdin before our payload write drains. We don't care —
    // the 'close' handler reports the real exit code. Without this listener,
    // the EPIPE bubbles as an unhandled error and crashes the process.
    child.stdin?.on('error', () => {})
    child.stdin?.end(`${JSON.stringify(opts.payload)}\n`)
  })
}

function defaultShell(): string {
  return process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh'
}

function defaultShellArgs(command: string): string[] {
  return process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command]
}

function killHookProcess(pid: number | undefined): void {
  if (pid === undefined) return
  if (process.platform === 'win32') {
    // Node's child.kill() only targets the wrapper process on Windows. taskkill
    // with /T preserves the documented hard-timeout semantics for shell hooks
    // that spawn children. Fire-and-forget; the child 'close' event remains the
    // single source of truth for result resolution.
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {})
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Process already exited; the normal close handler will resolve.
    }
  }
}

/**
 * Type guard — does this look like a checkout response with `requires_escalation`?
 *
 * UCP spec: the checkout response is a flat object — `status`, `continue_url`,
 * and `messages` are top-level fields alongside `id`, `line_items`, etc.
 * `requires_escalation` is a checkout STATUS VALUE, not an error envelope.
 * The dispatcher unwraps MCP content before calling us; we narrow at the
 * run-handler boundary on the flat response shape.
 */
export function isEscalationEnvelope(result: unknown): result is Record<string, unknown> {
  if (typeof result !== 'object' || result === null) return false
  return (result as Record<string, unknown>).status === 'requires_escalation'
}

/**
 * Build a {@link EscalationPayload} from the flat checkout response + dispatcher context.
 *
 * `continue_url` and `messages` are top-level fields on the flat checkout response.
 * The first handoff-required message (`requires_buyer_input` or
 * `requires_buyer_review`) becomes `reason`. Both severities contribute to the
 * spec status `requires_escalation`; neither is a separate checkout status.
 */
export function buildEscalationPayload(
  result: Record<string, unknown>,
  context: { business?: string | undefined; operation?: string | undefined },
): EscalationPayload {
  const messages = Array.isArray(result.messages) ? result.messages : []
  // Walk messages for the most meaningful escalation reason.
  const escalationMsg = messages.find(
    (m: unknown) =>
      typeof m === 'object' &&
      m !== null &&
      ((m as Record<string, unknown>).severity === 'requires_buyer_review' ||
        (m as Record<string, unknown>).severity === 'requires_buyer_input'),
  ) as Record<string, unknown> | undefined

  const payload: EscalationPayload = {
    status: typeof result.status === 'string' ? result.status : 'requires_escalation',
  }
  if (typeof result.continue_url === 'string') payload.url = result.continue_url
  if (typeof escalationMsg?.content === 'string') payload.reason = escalationMsg.content
  if (context.business !== undefined) payload.business = context.business
  if (context.operation !== undefined) payload.operation = context.operation
  return payload
}
