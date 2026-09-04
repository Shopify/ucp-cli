// Module-scoped verbose-mode writer.
//
// At CLI boot, `cli.ts` parses `--verbose` from argv and calls
// `setVerboseWriter(process.stderr.write.bind(process.stderr))`. Every layer
// in the dispatcher path (cache, discover, mcp-client, session) emits trace
// lines through `vlog()`. When the writer is null (default), `vlog()` is a
// cheap no-op — no allocations, no string formatting cost.
//
// Why module-scoped instead of param-plumbing:
//   • Verbose is a process-lifetime flag, not per-request. Threading it
//     through every option type (DiscoverOptions, McpRpcOptions, CacheOptions,
//     CallOperationOptions) infects 4+ signatures and 6+ call sites for a
//     debug feature. Module scope is the right granularity.
//   • MCP server mode mutes verbose at boot (`setVerboseWriter(null)`) so
//     stderr can't corrupt the JSON-RPC stream. One toggle, one place.
//   • Tests inject a capturing writer in beforeEach/afterEach pairs — same
//     test ergonomics as a passed-in callback, without the signature noise.
//
// AsyncLocalStorage was considered for per-request scoping (e.g. one MCP
// request verbose while another isn't). Rejected: MCP mode is verbose-off
// wholesale, and per-request verbosity isn't a real use case for v0.1.

let writer: ((msg: string) => void) | null = null

/**
 * Install (or clear) the verbose writer. Pass `null` to disable.
 * Idempotent — calling twice with the same writer is harmless.
 *
 * Default at process start is `null` (verbose disabled).
 */
export function setVerboseWriter(w: ((msg: string) => void) | null): void {
  writer = w
}

/**
 * Emit one trace line. No-op when verbose is disabled.
 *
 * The `[ucp]` prefix keeps verbose trace lines grep-able for humans and log
 * scrapers tailing stderr. Trailing newline is appended here so call sites
 * stay terse.
 */
export function vlog(msg: string): void {
  if (writer === null) return
  writer(`[ucp] ${msg}\n`)
}

/** True when a writer is currently installed. Cheap; tests use it as a guard. */
export function verboseEnabled(): boolean {
  return writer !== null
}

// Unconditional warning writer. Defaults to stderr (safe in MCP-over-stdio
// mode, where stdout is the protocol stream); tests inject a capturing
// writer. Distinct from vlog: warnings fire without --verbose because they
// describe declared configuration the engine is ignoring (e.g. a profile
// transport ucp-cli does not support) — the design rule is "not a silent
// no-op, not a hard failure".
let warnWriter: ((msg: string) => void) | null = null

/** Install (or clear) the warning writer. `null` restores the stderr default. */
export function setWarnWriter(w: ((msg: string) => void) | null): void {
  warnWriter = w
}

/** Emit one warning line, regardless of verbose mode. */
export function uwarn(msg: string): void {
  const write = warnWriter ?? ((m: string) => process.stderr.write(m))
  write(`[ucp] warning: ${msg}\n`)
}
