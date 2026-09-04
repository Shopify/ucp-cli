// INVARIANT: `code` → `layer` is a FUNCTION.
//
// No error code may be thrown at two different `layer` values. An agent that
// groups failures by `code` is grouping by remedy; a code thrown at two layers
// silently merges two remedies. Before the 2026-09 rename this was violated
// twice — `PROFILE_VERSION_MISMATCH` was `client` in `agent.ts` (our own
// profile) and `transport` in `profile.ts` (a merchant's), and
// `PROFILE_SCHEMA_INVALID` straddled the same seam. The renames fixed both;
// this file is what stops it recurring.
//
// ── How it is enforced ─────────────────────────────────────────────────────
//
// `ERROR_LAYERS` (src/lib/errors.ts) is the declaration. This test parses the
// real source with the TypeScript compiler API and checks it against every
// construction site, rather than trusting a comment or exercising only the
// paths that happen to have tests:
//
//   1. `new UcpError({ layer: <literal>, code: ErrorCodes.X })` — checked
//      directly against `ERROR_LAYERS`.
//   2. Sites where `code` and/or `layer` is computed (mcp-client's status
//      mapping, cache.ts's caller-supplied codes) cannot be read statically.
//      Each is declared in `DYNAMIC_SITES` with the codes it can emit, and
//      the test fails when a site appears that is not declared — so a new
//      dynamic site cannot slip through unexamined.
//   3. `fetchCached({ errorCodes, errorLayer })` call sites — the values that
//      feed cache.ts's generic throws — are resolved and checked too.
//
// Rejected alternative: have every throw site read its layer from the
// registry. PROTOCOL §4.2 wants `layer` stated at the site that knows it, and
// 80+ sites would have to be rewritten to buy the same guarantee this gets by
// reading the source.

import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import type * as TS from 'typescript'
import { describe, expect, it } from 'vitest'

import { ERROR_LAYERS, ErrorCodes } from './errors.js'
import type { ErrorLayer } from './types.js'

// Loaded through `createRequire`, not `import`: vite tries (and fails) to
// read a source map next to typescript.js and prints a stack trace on every
// run. A plain CJS require sidesteps vite's transform pipeline entirely.
const ts: typeof TS = createRequire(import.meta.url)('typescript')

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Construction sites whose `code` and/or `layer` is computed at runtime, keyed
 * by `<path>#<enclosing function>`. Declaring the emittable codes here is the
 * price of not being able to read them off the AST; the test asserts the set
 * of dynamic sites in source matches these keys exactly.
 */
const DYNAMIC_SITES: Record<string, { layer: ErrorLayer; codes: string[] }> = {
  // Status → code mapping for JSON-RPC error envelopes.
  'core/mcp-client.ts#rpcError': {
    layer: 'transport',
    codes: [
      ErrorCodes.MCP_RPC_ERROR,
      ErrorCodes.AUTH_REQUIRED,
      ErrorCodes.INSUFFICIENT_PERMISSIONS,
      ErrorCodes.IDEMPOTENCY_CONFLICT,
      ErrorCodes.RATE_LIMITED,
      ErrorCodes.BUSINESS_SERVER_ERROR,
      ErrorCodes.SERVICE_UNAVAILABLE,
    ],
  },
  // Same mapping, no JSON-RPC envelope present.
  'core/mcp-client.ts#httpError': {
    layer: 'transport',
    codes: [
      ErrorCodes.TRANSPORT_HTTP_ERROR,
      ErrorCodes.AUTH_REQUIRED,
      ErrorCodes.INSUFFICIENT_PERMISSIONS,
      ErrorCodes.IDEMPOTENCY_CONFLICT,
      ErrorCodes.RATE_LIMITED,
      ErrorCodes.BUSINESS_SERVER_ERROR,
      ErrorCodes.SERVICE_UNAVAILABLE,
    ],
  },
  // Generic cached fetch: both code and layer come from the caller. The
  // `fetchCached` call-site scan below verifies what callers actually pass.
  'core/cache.ts#fetchCached': {
    layer: 'transport',
    codes: [
      ErrorCodes.PROFILE_FETCH_FAILED,
      ErrorCodes.PROFILE_INVALID_JSON,
      ErrorCodes.PROFILE_SCHEMA_INVALID,
    ],
  },
}

interface Site {
  /** `<path>#<enclosing function>` */
  id: string
  code: string | undefined
  layer: string | undefined
}

function sourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'generated') continue
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.ts')) continue
      if (entry.name.endsWith('.test.ts')) continue
      if (entry.name === 'test-utils.ts') continue
      out.push(full)
    }
  }
  walk(SRC_ROOT)
  return out.sort()
}

/** Nearest named function/method/variable-bound arrow enclosing `node`. */
function enclosingName(node: TS.Node): string {
  for (let n: TS.Node | undefined = node; n !== undefined; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name !== undefined) return n.name.text
    if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name)) return n.name.text
    if (
      (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
      n.parent !== undefined &&
      ts.isVariableDeclaration(n.parent) &&
      ts.isIdentifier(n.parent.name)
    ) {
      return n.parent.name.text
    }
  }
  return '<module>'
}

function stringLiteralValue(node: TS.Expression | undefined): string | undefined {
  if (node === undefined) return undefined
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return undefined
}

/** `ErrorCodes.FOO` → `'FOO'`; a plain string literal → its value. */
function codeValue(node: TS.Expression | undefined): string | undefined {
  if (node === undefined) return undefined
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'ErrorCodes'
  ) {
    return node.name.text
  }
  return stringLiteralValue(node)
}

function property(obj: TS.ObjectLiteralExpression, name: string): TS.Expression | undefined {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    if (!ts.isIdentifier(prop.name) && !ts.isStringLiteral(prop.name)) continue
    if (prop.name.text === name) return prop.initializer
  }
  return undefined
}

interface Scan {
  sites: Site[]
  /** Resolved `fetchCached({ errorCodes, errorLayer })` pairs. */
  cachedFetches: { id: string; layer: string; codes: string[] }[]
}

function scan(): Scan {
  const sites: Site[] = []
  const cachedFetches: Scan['cachedFetches'] = []

  for (const file of sourceFiles()) {
    const rel = relative(SRC_ROOT, file).split(sep).join('/')
    const sf = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.ESNext,
      /* setParentNodes */ true,
    )
    // Module-level `const X = { fetchFailed: ErrorCodes.A, ... }` maps, so a
    // `errorCodes: PROFILE_ERROR_CODES` reference can be resolved.
    const codeMaps = new Map<string, string[]>()
    const collectCodeMaps = (node: TS.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined
      ) {
        const init = ts.isAsExpression(node.initializer)
          ? node.initializer.expression
          : node.initializer
        if (ts.isObjectLiteralExpression(init)) {
          const codes = init.properties
            .filter(ts.isPropertyAssignment)
            .map((p) => codeValue(p.initializer))
            .filter((c): c is string => c !== undefined)
          if (codes.length > 0) codeMaps.set(node.name.text, codes)
        }
      }
      ts.forEachChild(node, collectCodeMaps)
    }
    collectCodeMaps(sf)

    const visit = (node: TS.Node): void => {
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'UcpError'
      ) {
        const arg = node.arguments?.[0]
        const obj = arg !== undefined && ts.isObjectLiteralExpression(arg) ? arg : undefined
        sites.push({
          id: `${rel}#${enclosingName(node)}`,
          code: obj === undefined ? undefined : codeValue(property(obj, 'code')),
          layer: obj === undefined ? undefined : stringLiteralValue(property(obj, 'layer')),
        })
      }
      // Any options object carrying `errorCodes` feeds cache.ts's throws.
      if (ts.isObjectLiteralExpression(node)) {
        const errorCodes = property(node, 'errorCodes')
        if (errorCodes !== undefined) {
          const codes = ts.isIdentifier(errorCodes)
            ? (codeMaps.get(errorCodes.text) ?? [])
            : ts.isObjectLiteralExpression(errorCodes)
              ? errorCodes.properties
                  .filter(ts.isPropertyAssignment)
                  .map((p) => codeValue(p.initializer))
                  .filter((c): c is string => c !== undefined)
              : []
          cachedFetches.push({
            id: `${rel}#${enclosingName(node)}`,
            // cache.ts defaults `errorLayer` to 'transport'.
            layer: stringLiteralValue(property(node, 'errorLayer')) ?? 'transport',
            codes,
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }

  return { sites, cachedFetches }
}

const SCAN = scan()

describe('code → layer is a function', () => {
  it('finds the throw sites at all (guards against a silently empty scan)', () => {
    expect(SCAN.sites.length).toBeGreaterThan(50)
    expect(SCAN.cachedFetches.length).toBeGreaterThan(0)
  })

  it('every statically-readable `new UcpError` site agrees with ERROR_LAYERS', () => {
    const mismatches = SCAN.sites
      .filter((s) => s.code !== undefined && s.layer !== undefined)
      .filter((s) => ERROR_LAYERS[s.code as keyof typeof ERROR_LAYERS] !== s.layer)
      .map((s) => `${s.id}: ${s.code} thrown at layer '${s.layer}'`)
    expect(mismatches).toEqual([])
  })

  it('no code is thrown at two different layers', () => {
    const layersByCode = new Map<string, Set<string>>()
    const record = (code: string, layer: string) => {
      const set = layersByCode.get(code) ?? new Set<string>()
      set.add(layer)
      layersByCode.set(code, set)
    }
    for (const site of SCAN.sites) {
      if (site.code === undefined || site.layer === undefined) continue
      record(site.code, site.layer)
    }
    for (const [id, decl] of Object.entries(DYNAMIC_SITES)) {
      // Only count declared dynamic sites that actually exist in source; the
      // "no undeclared dynamic site" test below pins the other direction.
      if (!SCAN.sites.some((s) => s.id === id)) continue
      for (const code of decl.codes) record(code, decl.layer)
    }
    for (const fetch of SCAN.cachedFetches) {
      for (const code of fetch.codes) record(code, fetch.layer)
    }

    const straddling = [...layersByCode.entries()]
      .filter(([, layers]) => layers.size > 1)
      .map(([code, layers]) => `${code}: ${[...layers].sort().join(' + ')}`)
    expect(straddling).toEqual([])
  })

  it('every dynamic site is declared, and declares only codes at its layer', () => {
    const dynamic = SCAN.sites
      .filter((s) => s.code === undefined || s.layer === undefined)
      .map((s) => s.id)
    expect([...new Set(dynamic)].sort()).toEqual(Object.keys(DYNAMIC_SITES).sort())

    const wrong: string[] = []
    for (const [id, decl] of Object.entries(DYNAMIC_SITES)) {
      for (const code of decl.codes) {
        if (ERROR_LAYERS[code as keyof typeof ERROR_LAYERS] !== decl.layer) {
          wrong.push(`${id}: ${code} declared '${decl.layer}'`)
        }
      }
    }
    expect(wrong).toEqual([])
  })

  it('fetchCached callers supply codes that match their declared layer', () => {
    const wrong: string[] = []
    for (const call of SCAN.cachedFetches) {
      expect(call.codes.length).toBeGreaterThan(0)
      for (const code of call.codes) {
        if (ERROR_LAYERS[code as keyof typeof ERROR_LAYERS] !== call.layer) {
          wrong.push(`${call.id}: ${code} at layer '${call.layer}'`)
        }
      }
    }
    expect(wrong).toEqual([])
  })

  it('ERROR_LAYERS covers exactly the registered codes', () => {
    expect(Object.keys(ERROR_LAYERS).sort()).toEqual(Object.keys(ErrorCodes).sort())
  })

  it('every layered code has a throw site, and every null-layer code has none', () => {
    const thrown = new Set<string>()
    for (const site of SCAN.sites) if (site.code !== undefined) thrown.add(site.code)
    for (const [id, decl] of Object.entries(DYNAMIC_SITES)) {
      if (!SCAN.sites.some((s) => s.id === id)) continue
      for (const code of decl.codes) thrown.add(code)
    }
    for (const call of SCAN.cachedFetches) for (const code of call.codes) thrown.add(code)

    // A registered code nobody throws is registry rot; a `null`-layer code
    // thrown as a UcpError means it grew a layer and the map is stale.
    const unthrown = Object.entries(ERROR_LAYERS)
      .filter(([code, layer]) => layer !== null && !thrown.has(code))
      .map(([code]) => code)
    const unexpectedlyThrown = Object.entries(ERROR_LAYERS)
      .filter(([code, layer]) => layer === null && thrown.has(code))
      .map(([code]) => code)
    expect({ unthrown, unexpectedlyThrown }).toEqual({ unthrown: [], unexpectedlyThrown: [] })
  })
})
