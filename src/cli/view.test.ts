// `--view` resolver + applier unit tests.
//
// Two surfaces, pinned independently: the resolver's syntactic decisions
// (`@file` vs `-` vs inline; tilde expansion; parse-time failure surfacing),
// and the applier's envelope contract (preserve dispatch identity + cta,
// passthrough on error envelopes, mutate only `result`).
//
// These tests do not exercise CLI flag wiring — that lives in src/cli.test.ts.
// Keeping the seams separated lets `--view` be reasoned about as a pure
// function before any dispatcher integration.

import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { UcpError } from '../lib/errors.js'
import { applyView, resolveView } from './view.js'

describe('resolveView — input shapes', () => {
  it('compiles an inline expression and reports source: inline', async () => {
    const view = await resolveView({ raw: 'result.products[*].title' })
    expect(view.source).toBe('inline')
    expect(view.path).toBeUndefined()
    expect(view.expression).toBe('result.products[*].title')
    expect(view.compiled).toBeDefined()
  })

  it('resolves package-local :<alias> views under the current capability', async () => {
    const readFile = vi.fn(async () => '\n result.products[*].title \n')
    const view = await resolveView({
      raw: ':compact',
      capability: 'catalog',
      packageViewsDir: '/package/views',
      readFile,
    })
    expect(view.source).toBe('package')
    expect(view.alias).toBe('compact')
    expect(view.capability).toBe('catalog')
    expect(view.path).toBe(join('/package/views', 'catalog.compact.jmespath'))
    expect(view.expression).toBe('result.products[*].title')
    expect(readFile).toHaveBeenCalledWith(join('/package/views', 'catalog.compact.jmespath'))
  })

  it('treats dots inside :<alias> as alias text, not a cross-capability namespace', async () => {
    const readFile = vi.fn(async () => 'result')
    await resolveView({
      raw: ':cart.summary',
      capability: 'catalog',
      packageViewsDir: '/package/views',
      readFile,
    })
    expect(readFile).toHaveBeenCalledWith(join('/package/views', 'catalog.cart.summary.jmespath'))
  })

  it('reads from @<path>, trims whitespace, and reports source: file with original path', async () => {
    const readFile = vi.fn(async () => '\n  result.products[*].title  \n')
    const view = await resolveView({ raw: '@./views/titles.jmespath', readFile })
    expect(view.source).toBe('file')
    expect(view.path).toBe('./views/titles.jmespath')
    expect(view.expression).toBe('result.products[*].title')
    expect(readFile).toHaveBeenCalledWith('./views/titles.jmespath')
  })

  it('expands ~ and ~/ in @<path>', async () => {
    const readFile = vi.fn(async () => 'result.id')
    await resolveView({ raw: '@~/views/x.jmespath', readFile })
    expect(readFile).toHaveBeenCalledWith(resolvePath(homedir(), 'views/x.jmespath'))

    await resolveView({ raw: '@~', readFile })
    expect(readFile).toHaveBeenCalledWith(homedir())
  })
})

describe('resolveView — error paths', () => {
  it('rejects `-` (stdin reserved for --input)', async () => {
    await expect(resolveView({ raw: '-' })).rejects.toMatchObject({
      name: 'Ucp.UcpError',
      code: 'INVALID_INPUT',
      message: expect.stringContaining('stdin is reserved for --input'),
    })
  })

  it('rejects package-local aliases without an operation capability', async () => {
    await expect(resolveView({ raw: ':compact' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('require an operation capability'),
    })
  })

  it('rejects invalid package-local aliases before reading files', async () => {
    const readFile = vi.fn(async () => 'result')
    for (const raw of [':', ':../x', ':/tmp/x', ':foo/bar', ':.summary', ':summary.']) {
      await expect(resolveView({ raw, capability: 'catalog', readFile })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: expect.stringContaining('package-local view aliases must match'),
      })
    }
    expect(readFile).not.toHaveBeenCalled()
  })

  it('reports available aliases when a package-local view is unknown', async () => {
    const readFile = vi.fn(async () => {
      throw new Error('ENOENT')
    })
    const readDir = vi.fn(async () => [
      'catalog.compact.jmespath',
      'catalog.summary.jmespath',
      'cart.summary.jmespath',
    ])
    await expect(
      resolveView({
        raw: ':cart.summary',
        capability: 'catalog',
        packageViewsDir: '/package/views',
        readFile,
        readDir,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('Tried skills/ucp/views/catalog.cart.summary.jmespath'),
    })
    await expect(
      resolveView({
        raw: ':cart.summary',
        capability: 'catalog',
        packageViewsDir: '/package/views',
        readFile,
        readDir,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('Available for catalog: compact, summary'),
    })
  })

  it('rejects bare `@` (missing path)', async () => {
    await expect(resolveView({ raw: '@' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('@ requires a file path'),
    })
  })

  it('surfaces file-read errors as INVALID_INPUT with the original path token', async () => {
    const readFile = vi.fn(async () => {
      throw new Error('ENOENT: no such file or directory')
    })
    await expect(resolveView({ raw: '@./missing.jmespath', readFile })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringMatching(/cannot read file \.\/missing\.jmespath.*ENOENT/),
    })
  })

  it('rejects empty file content', async () => {
    const readFile = vi.fn(async () => '   \n\n   ')
    await expect(resolveView({ raw: '@./empty.jmespath', readFile })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('is empty'),
    })
  })

  it('catches JMESPath parse errors at resolve time (before any dispatch)', async () => {
    await expect(resolveView({ raw: 'result.foo[' })).rejects.toMatchObject({
      name: 'Ucp.UcpError',
      code: 'INVALID_INPUT',
      message: expect.stringMatching(/--view: JMESPath parse error \(inline\)/),
    })
  })

  it('parse errors from @file include the file path in the location hint', async () => {
    const readFile = vi.fn(async () => 'result.foo[')
    await expect(resolveView({ raw: '@./broken.jmespath', readFile })).rejects.toMatchObject({
      message: expect.stringContaining('from @./broken.jmespath'),
    })
  })

  it('parse errors from package-local aliases include the alias in the location hint', async () => {
    const readFile = vi.fn(async () => 'result.foo[')
    await expect(
      resolveView({ raw: ':compact', capability: 'catalog', packageViewsDir: '/bundle', readFile }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('from :compact'),
    })
  })

  it('all error paths throw UcpError (not a bare Error)', async () => {
    await expect(resolveView({ raw: '-' })).rejects.toBeInstanceOf(UcpError)
    await expect(resolveView({ raw: 'foo[' })).rejects.toBeInstanceOf(UcpError)
  })
})

describe('applyView — envelope-level projection', () => {
  // Canonical envelope from opRun: dispatch identity at root, ucp hoisted as
  // a sibling of result, optional cta. The new contract: the view sees this
  // whole envelope and its output REPLACES it. Tests below pin the three
  // shapes that matter — full replacement, error-envelope passthrough, and
  // input non-mutation.
  const envelope = {
    business: 'https://shop.example.com',
    endpoint: 'https://shop.example.com/api/ucp/mcp',
    transport: 'mcp+jsonrpc',
    ucp: { version: '2026-04-08', status: 'ok' },
    result: {
      products: [
        { id: 'p1', title: 'Boots', price: 100 },
        { id: 'p2', title: 'Hat', price: 30 },
      ],
    },
  }

  it('is a no-op when view is undefined (flag not set)', () => {
    expect(applyView(envelope, undefined)).toBe(envelope)
  })

  it('replaces the whole envelope with the projection — caller has full control', async () => {
    // The view sees the envelope; its output IS the new envelope. Dispatch
    // identity, ucp, and any other keys are gone unless the view re-emits
    // them. This is what lets a kick-the-tires view drop noise wholesale.
    const view = await resolveView({ raw: 'result.products[*].title' })
    const out = applyView(envelope, view)
    expect(out).toEqual(['Boots', 'Hat'])
  })

  it('lets a view re-emit a slim envelope (ucp + projected result)', async () => {
    // The kick-the-tires recipe the package-local views use: keep ucp.version +
    // status as protocol confirmation, drop dispatch identity, project result.
    const view = await resolveView({
      raw: '{ucp: {version: ucp.version, status: ucp.status}, result: result.products[*].title}',
    })
    const out = applyView(envelope, view)
    expect(out).toEqual({
      ucp: { version: '2026-04-08', status: 'ok' },
      result: ['Boots', 'Hat'],
    })
  })

  it('does not mutate the input envelope', async () => {
    const view = await resolveView({ raw: 'result.products[*].title' })
    const snapshot = JSON.parse(JSON.stringify(envelope))
    applyView(envelope, view)
    expect(envelope).toEqual(snapshot)
  })

  it('supports filter expressions inside the projection', async () => {
    const view = await resolveView({ raw: 'result.products[?price > `50`].title' })
    expect(applyView(envelope, view)).toEqual(['Boots'])
  })

  it('returns [] for list-wildcard path misses (jmespath compaction)', async () => {
    // List wildcard projections drop null values per JMESPath spec — missing
    // keys evaluate to null and compact out. Pinned so a future jmespath bump
    // doesn't silently change the empty-shape contract downstream formatters
    // render against.
    const view = await resolveView({ raw: 'result.products[*].nonexistent' })
    expect(applyView(envelope, view)).toEqual([])
  })

  it('returns null for non-projection path misses (no compaction)', async () => {
    const scalar = await resolveView({ raw: 'totally.absent.field' })
    expect(applyView(envelope, scalar)).toBeNull()
  })

  it('passes error envelopes (no result field) through unchanged', async () => {
    // Hard contract: a view never silently swallows an error message. If the
    // op failed (no `result` field), projection is skipped and the error
    // envelope reaches the user verbatim — even with a view that would
    // happily evaluate against the error shape.
    const errorEnvelope = {
      code: 'SCHEMA_VALIDATION_FAILED',
      message: 'cart line_items[0].quantity must be >= 1',
      cta: { description: 'fix input', commands: [] },
    }
    const view = await resolveView({ raw: 'result.products[*].title' })
    expect(applyView(errorEnvelope, view)).toEqual(errorEnvelope)
  })

  it('projects envelopes with result: null (only result: undefined triggers passthrough)', async () => {
    // null is a legitimate result value (e.g. a no-op response). The
    // passthrough rule keys strictly on `result === undefined`, so the view
    // DOES run here and resolves against the envelope. Pin the behavior so a
    // future refactor doesn't accidentally widen the passthrough.
    const view = await resolveView({ raw: 'result' })
    const env = { business: 'x', result: null }
    expect(applyView(env, view)).toBeNull()
  })

  it('surfaces JMESPath runtime errors as INVALID_INPUT (not generic crash)', async () => {
    // length() requires array | object | string; calling it on a number throws
    // a runtime type error from the JMESPath interpreter. Without the wrap in
    // applyView, that error would bubble unhandled to incur's global error
    // handler and surface as a generic UNKNOWN failure. Pin the typed envelope.
    const view = await resolveView({ raw: 'length(result)' })
    const env = { business: 'x', result: 42 }
    expect(() => applyView(env, view)).toThrow(
      expect.objectContaining({
        code: 'INVALID_INPUT',
        message: expect.stringMatching(/--view: JMESPath runtime error \(inline\)/),
      }),
    )
  })

  it('runtime error from a file-loaded view names the file in the location hint', async () => {
    // Symmetric to the parse-error test for resolveView: file-loaded views
    // should report `from @<path>` so the agent can find the broken view.
    const readFile = vi.fn().mockResolvedValue('length(result)')
    const view = await resolveView({ raw: '@./broken.jmespath', readFile })
    expect(() => applyView({ result: 42 }, view)).toThrow(
      expect.objectContaining({
        code: 'INVALID_INPUT',
        message: expect.stringMatching(
          /--view: JMESPath runtime error \(from @\.\/broken\.jmespath\)/,
        ),
      }),
    )
  })
})
