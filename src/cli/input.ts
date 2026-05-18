// Operation input assembly for command-line payload flags.
//
// Commands collect raw flag values; this module turns them into the JSON object
// that is validated against the resolved operation schema. It deliberately owns
// only syntax and overlay precedence. Operation-specific wrapping, such as MCP
// `meta.ucp-agent`, belongs in the dispatcher.
//
// `--set` paths use JSON Pointer (RFC 6901) rather than dot-separated segments.
// UCP namespaces operation fields with reverse-domain keys
// (e.g. `signals.dev.ucp.buyer_ip`), and a dotted path could not address them
// without an escape mechanism. JSON Pointer makes each `/`-delimited segment
// literal, with `~0`/`~1` available to escape `~` and `/` themselves.

import { readFile } from 'node:fs/promises'

import { ErrorCodes, UcpError } from '../lib/errors.js'

export interface BuildOperationInputOptions {
  /** JSON object literal, `@file`, or `-` for stdin. */
  json?: string
  /** Repeatable typed overlays, applied in order. */
  set?: readonly string[]
  /** Repeatable string overlays, applied after `set`. */
  setString?: readonly string[]
  /** Injectable file reader for tests. */
  readFile?: (path: string) => Promise<string>
  /** Injectable stdin reader for tests. */
  readStdin?: () => Promise<string>
}

type JsonObject = Record<string, unknown>

export async function buildOperationInput(
  options: BuildOperationInputOptions = {},
): Promise<JsonObject> {
  const input =
    options.json === undefined
      ? {}
      : await parseJsonSource(options.json, {
          readFile: options.readFile ?? ((path) => readFile(path, 'utf-8')),
          readStdin: options.readStdin ?? readProcessStdin,
        })

  for (const assignment of options.set ?? []) {
    applyAssignment(input, assignment, inferValue)
  }
  for (const assignment of options.setString ?? []) {
    applyAssignment(input, assignment, (value) => value)
  }

  return input
}

async function parseJsonSource(
  source: string,
  readers: { readFile: (path: string) => Promise<string>; readStdin: () => Promise<string> },
): Promise<JsonObject> {
  const body =
    source === '-'
      ? await readers.readStdin()
      : source.startsWith('@')
        ? await readers.readFile(source.slice(1))
        : source

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (err) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.INVALID_INPUT,
      message: '--input must be valid JSON',
      cause: err as Error,
    })
  }

  if (!isPlainObject(parsed)) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.INVALID_INPUT,
      message: '--input must parse to a JSON object',
    })
  }

  return parsed
}

function applyAssignment(
  target: JsonObject,
  assignment: string,
  parseValue: (value: string) => unknown,
): void {
  const equals = assignment.indexOf('=')
  if (equals <= 0) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.INVALID_INPUT,
      message: `input overlay must be <json-pointer>=<value>: ${assignment}`,
    })
  }

  const pointer = assignment.slice(0, equals)
  const rawValue = assignment.slice(equals + 1)
  const segments = parseJsonPointer(pointer)
  const value = parseValue(rawValue)

  // Walker descends through `segments[0..N-1]`, then writes the value at
  // segments[N]. Two ergonomic deviations from RFC 6901/6902 strict
  // semantics, both deliberate:
  //   1. Auto-create missing intermediate paths. RFC 6902 `add` requires
  //      the parent to exist; we synthesize it. Pick `[]` if the next
  //      segment looks like an array index (digits with no leading zero,
  //      or `-` for append); pick `{}` otherwise.
  //   2. Walk INTO existing arrays via numeric index. Strict RFC 6901
  //      already supports this on read; we extend to write.
  // The append token `-` is honored only as the FINAL segment (per
  // RFC 6902 add); as an intermediate it doesn't address a specific slot,
  // so we error.
  let cursor: JsonObject | unknown[] = target
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i] as string
    const nextSegment = segments[i + 1] as string

    if (segment === '-') {
      throw new UcpError({
        layer: 'client',
        code: ErrorCodes.INVALID_INPUT,
        message: `input overlay cannot use '-' as an intermediate segment in ${pointer}; '-' is the array-append token and may only appear as the final segment`,
      })
    }

    if (Array.isArray(cursor)) {
      const idx = parseArrayIndex(segment, pointer)
      const arrCurrent: unknown = cursor[idx]
      if (arrCurrent === undefined) {
        const next: JsonObject | unknown[] = isArrayIndex(nextSegment) ? [] : {}
        cursor[idx] = next
        cursor = next
        continue
      }
      if (!isPlainObject(arrCurrent) && !Array.isArray(arrCurrent)) {
        throw new UcpError({
          layer: 'client',
          code: ErrorCodes.INVALID_INPUT,
          message: `input overlay cannot set ${pointer}: ${segment} is already a non-container value`,
        })
      }
      cursor = arrCurrent
      continue
    }

    const objCurrent: unknown = cursor[segment]
    if (objCurrent === undefined) {
      const next: JsonObject | unknown[] = isArrayIndex(nextSegment) ? [] : {}
      cursor[segment] = next
      cursor = next
      continue
    }
    if (!isPlainObject(objCurrent) && !Array.isArray(objCurrent)) {
      throw new UcpError({
        layer: 'client',
        code: ErrorCodes.INVALID_INPUT,
        message: `input overlay cannot set ${pointer}: ${segment} is already a non-container value`,
      })
    }
    cursor = objCurrent
  }

  const finalSegment = segments[segments.length - 1] as string
  if (Array.isArray(cursor)) {
    if (finalSegment === '-') {
      cursor.push(value)
      return
    }
    cursor[parseArrayIndex(finalSegment, pointer)] = value
    return
  }
  if (finalSegment === '-') {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.INVALID_INPUT,
      message: `input overlay cannot use '-' as the final segment in ${pointer}: parent is not an array`,
    })
  }
  cursor[finalSegment] = value
}

// True for a non-negative integer with no leading zeros, OR the special
// '-' append token. Mirrors RFC 6901 §4 array-index semantics + RFC 6902
// add-with-`-` for append.
function isArrayIndex(segment: string): boolean {
  return segment === '-' || /^(?:0|[1-9]\d*)$/.test(segment)
}

// Parse a numeric array index. Throws on leading zeros, non-digits, or the
// '-' token (which has its own append semantics handled by the caller).
function parseArrayIndex(segment: string, pointer: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(segment)) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.INVALID_INPUT,
      message: `input overlay path ${pointer} steps into an array but segment '${segment}' is not a valid array index (use a non-negative integer with no leading zeros, or '-' as the final segment to append)`,
    })
  }
  return Number(segment)
}

// RFC 6901 with one ergonomic concession: leading slash is optional. `query`
// and `/query` both mean the same thing; the leading slash adds zero user value
// and the strict form lost a real-world live-test (typed `query=hat`, got
// rejected). Slash remains the segment separator (not dot) so reverse-DNS
// extension keys like `signals.dev.ucp.buyer_ip` survive without ambiguity.
function parseJsonPointer(pointer: string): string[] {
  if (pointer === '') {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.INVALID_INPUT,
      message: 'input overlay path must not be empty (root replacement is what --input is for)',
    })
  }
  const normalized = pointer.startsWith('/') ? pointer.slice(1) : pointer
  const segments = normalized
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
  if (segments.some((segment) => segment.length === 0)) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.INVALID_INPUT,
      message: `input overlay path must not contain empty segments: ${pointer}`,
    })
  }
  return segments
}

function inferValue(raw: string): unknown {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw === 'null') return null
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) return Number(raw)
  if (raw.startsWith('{') || raw.startsWith('[') || raw.startsWith('"')) {
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  return raw
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf-8')
}
