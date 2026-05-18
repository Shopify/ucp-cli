// Response-projection resolver for `--view <expr|@file|:alias>`.
//
// Two concerns, one module: (1) take the raw flag value and turn it into a
// compiled JMESPath expression, failing fast on parse / file / stdin-collision
// errors BEFORE any network I/O; (2) apply that expression to the response
// envelope, where the projection result REPLACES the envelope entirely.
//
// `--view` operates on the WHOLE envelope, not just `envelope.result`. The
// view file is the envelope spec — what it emits IS the response. That gives
// callers control over the noise/signal trade-off per view: a kick-the-tires
// view drops dispatch identity and slims `ucp` down to status+version; an
// agent-facing view can re-emit the full envelope shape it needs.
//
// Why envelope-level (not result-level): the original `result`-only design
// forced every view to carry the dispatch-identity tax (business / endpoint /
// transport / full ucp.capabilities block) on output. For human kick-the-tires
// runs, that was the bulk of the rendered output. Letting the view choose
// what to keep keeps the projection's stated job — "show me a compact view" —
// honest at the rendered output.
//
// CTAs flow through a separate channel (incur extras), unaffected by the view
// projection. Error envelopes (no `result` field) also pass through unchanged
// so a typo'd view never silently swallows an error message.
//
// Resolver semantics mirror `--input` deliberately:
//   - `:<alias>` → load a package-local view for the current operation capability
//                  (e.g. catalog + :compact => catalog.compact.jmespath)
//   - `@<path>`  → load expression from file (UTF-8, trim, `~` expanded)
//   - `-`        → REJECTED. `--input` owns stdin; sharing stdin with `--view`
//                  silently breaks any agent that combines them.
//   - otherwise  → treat as an inline JMESPath expression
//
// Compile-on-resolve is load-bearing: a typo in the expression should surface
// in milliseconds at the CLI boundary, not after a network round-trip. The
// returned ViewState carries the compiled AST so the dispatcher can apply
// without recompiling per call.

import { readdir as fsReadDir, readFile as fsReadFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import type { JSONValue } from '@jmespath-community/jmespath'
import { compile, TreeInterpreter } from '@jmespath-community/jmespath'

// `ExpressionNode` is the AST type returned by `compile()` but is not exported
// by the package's index module. `ReturnType<typeof compile>` is the load-
// bearing way to name it without a `// @ts-expect-error` import dance.
type ExpressionNode = ReturnType<typeof compile>

import { ErrorCodes, UcpError } from '../lib/errors.js'
import { findPackageRoot } from '../lib/package-root.js'

export type ViewCapability = string

type ReadDir = (path: string) => Promise<string[]>

export interface ResolveViewOptions {
  /** Raw flag value — inline expression, `:<alias>`, `@<path>`, or `-` (rejected). */
  raw: string
  /** Current operation capability. Required only for package-local `:<alias>` views. */
  capability?: ViewCapability | undefined
  /** Injectable file reader for tests. */
  readFile?: (path: string) => Promise<string>
  /** Injectable directory reader for tests (used to report available package-local aliases). */
  readDir?: ReadDir
  /** Injectable package views directory for tests. Defaults to package-root skills/ucp/views. */
  packageViewsDir?: string | undefined
}

export interface ViewState {
  source: 'inline' | 'file' | 'package'
  /** Original path token for @file, actual resolved path for package-local aliases. */
  path?: string
  /** Package-local alias token without the leading `:`. Present when source: 'package'. */
  alias?: string
  /** Operation capability used to resolve a package-local alias. Present when source: 'package'. */
  capability?: ViewCapability
  expression: string
  compiled: ExpressionNode
}

export async function resolveView(opts: ResolveViewOptions): Promise<ViewState> {
  const { raw } = opts
  const readFile = opts.readFile ?? ((p: string) => fsReadFile(p, 'utf-8'))
  const readDir = opts.readDir ?? ((p: string) => fsReadDir(p))

  if (raw === '-') {
    const alternatives =
      opts.capability === undefined
        ? 'an inline expression or use @<path> to load from a file'
        : 'an inline expression, :<alias>, or use @<path> to load from a file'
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.INVALID_INPUT,
      message: `--view: stdin is reserved for --input; pass ${alternatives}`,
    })
  }

  let expression: string
  let source: ViewState['source']
  let path: string | undefined
  let alias: string | undefined
  let capability: ViewCapability | undefined

  if (raw.startsWith(':')) {
    source = 'package'
    alias = raw.slice(1)
    if (!isValidPackageAlias(alias)) {
      throw new UcpError({
        layer: 'client',
        code: ErrorCodes.INVALID_INPUT,
        message:
          '--view: package-local view aliases must match :name or :name.part (lowercase letters, numbers, _, -; each part starts with a letter)',
      })
    }
    capability = opts.capability
    if (capability === undefined) {
      throw new UcpError({
        layer: 'client',
        code: ErrorCodes.INVALID_INPUT,
        message:
          '--view: package-local view aliases require an operation capability; use an inline expression or @<path> for custom files',
      })
    }
    const viewsDir = opts.packageViewsDir ?? packageViewsDirectory()
    path = join(viewsDir, packageViewFilename(capability, alias))
    expression = await readPackageView({ alias, capability, path, viewsDir, readFile, readDir })
  } else if (raw.startsWith('@')) {
    source = 'file'
    path = raw.slice(1)
    if (path === '') {
      throw new UcpError({
        layer: 'client',
        code: ErrorCodes.INVALID_INPUT,
        message: '--view: @ requires a file path (e.g. --view @./view.jmespath)',
      })
    }
    let body: string
    try {
      body = await readFile(expandTilde(path))
    } catch (err) {
      throw new UcpError({
        layer: 'client',
        code: ErrorCodes.INVALID_INPUT,
        message: `--view: cannot read file ${path}: ${(err as Error).message}`,
        cause: err as Error,
      })
    }
    expression = body.trim()
    if (expression === '') {
      throw new UcpError({
        layer: 'client',
        code: ErrorCodes.INVALID_INPUT,
        message: `--view: file ${path} is empty`,
      })
    }
  } else {
    source = 'inline'
    expression = raw
  }

  let compiled: ExpressionNode
  try {
    compiled = compile(expression)
  } catch (err) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.INVALID_INPUT,
      message: `--view: JMESPath parse error (${viewLocation({ source, path, alias })}): ${(err as Error).message}`,
      cause: err as Error,
    })
  }

  return {
    source,
    ...(path !== undefined ? { path } : {}),
    ...(alias !== undefined ? { alias } : {}),
    ...(capability !== undefined ? { capability } : {}),
    expression,
    compiled,
  }
}

interface ReadPackageViewOptions {
  alias: string
  capability: ViewCapability
  path: string
  viewsDir: string
  readFile: (path: string) => Promise<string>
  readDir: ReadDir
}

async function readPackageView(opts: ReadPackageViewOptions): Promise<string> {
  let body: string
  try {
    body = await opts.readFile(opts.path)
  } catch (err) {
    const available = await availablePackageAliases(opts.viewsDir, opts.capability, opts.readDir)
    const availableText = available.length === 0 ? 'none' : available.join(', ')
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.INVALID_INPUT,
      message: `--view: unknown package-local view :${opts.alias} for ${opts.capability}. Tried ${packageViewDisplayPath(opts.capability, opts.alias)}. Available for ${opts.capability}: ${availableText}. Use --view @<path> for custom files.`,
      cause: err as Error,
    })
  }
  const expression = body.trim()
  if (expression === '') {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.INVALID_INPUT,
      message: `--view: package-local view :${opts.alias} for ${opts.capability} is empty`,
    })
  }
  return expression
}

async function availablePackageAliases(
  viewsDir: string,
  capability: ViewCapability,
  readDir: ReadDir,
): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readDir(viewsDir)
  } catch {
    return []
  }
  const prefix = `${capability}.`
  return entries
    .filter((name) => name.startsWith(prefix) && name.endsWith('.jmespath'))
    .map((name) => name.slice(prefix.length, -'.jmespath'.length))
    .sort((a, b) => a.localeCompare(b))
}

function isValidPackageAlias(alias: string): boolean {
  return /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/.test(alias)
}

function packageViewFilename(capability: ViewCapability, alias: string): string {
  return `${capability}.${alias}.jmespath`
}

function packageViewDisplayPath(capability: ViewCapability, alias: string): string {
  return `skills/ucp/views/${packageViewFilename(capability, alias)}`
}

function packageViewsDirectory(): string {
  return join(findPackageRoot(import.meta.url), 'skills', 'ucp', 'views')
}

// `~` resolves to $HOME; `~/foo` to $HOME/foo. Anything else passes through
// (including `~user`, which we deliberately don't support — passwd lookups
// are out of scope and inconsistent across platforms).
function expandTilde(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return resolvePath(homedir(), path.slice(2))
  return path
}

function viewLocation(view: {
  source: ViewState['source']
  path?: string | undefined
  alias?: string | undefined
}): string {
  if (view.source === 'inline') return 'inline'
  if (view.source === 'package') return `from :${view.alias ?? '<unknown>'}`
  return `from @${view.path}`
}

export interface Envelope {
  result?: unknown
  [key: string]: unknown
}

/**
 * Apply a compiled view to the WHOLE envelope. Pure function: the input
 * envelope is not mutated.
 *
 * Semantics: the JMESPath expression evaluates against the envelope itself,
 * and the projection result REPLACES the entire envelope. This gives the
 * view full control over the response shape — agents/humans can opt into
 * a slim envelope (`{ucp: {version: ucp.version}, result: ...}`) or drop
 * the envelope entirely (`result.products[*].title`) per view file.
 *
 * Two passthrough rules:
 *   1. `view === undefined` — flag not set, envelope returned as-is.
 *   2. `envelope.result === undefined` — error envelopes and meta payloads
 *      (dry-run preview, --input-schema output) don't carry a `result`;
 *      projecting them would replace a meaningful error message with the
 *      view's idea of an envelope shape (typically null when fields don't
 *      exist). Passthrough keeps the error surface intact so `--view`
 *      never silently swallows an op failure.
 *
 * On the success path, the return type is widened to `unknown` because a
 * view can produce any JMESPath value (object, array, scalar, null). The
 * generic `T` is preserved only on the passthrough branches where the
 * input is returned by reference.
 */
export function applyView<T extends Envelope>(
  envelope: T,
  view: ViewState | undefined,
): T | unknown {
  if (view === undefined) return envelope
  if (envelope.result === undefined) return envelope
  // Runtime evaluation can throw on type mismatches (e.g. `length(@)` against a
  // non-string/array/object) or unknown function calls. Surface those as a
  // typed INVALID_INPUT so the agent gets the same well-formed error envelope
  // it would for a parse-time failure (see resolveView), instead of a generic
  // unhandled error bubbling up to the global handler.
  try {
    return TreeInterpreter.search(view.compiled, envelope as unknown as JSONValue)
  } catch (err) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.INVALID_INPUT,
      message: `--view: JMESPath runtime error (${viewLocation(view)}): ${(err as Error).message}`,
      cause: err as Error,
    })
  }
}
