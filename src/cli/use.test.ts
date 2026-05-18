// runUse() — session business persistence.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readActive, writeActive } from '../core/profile-store.js'
import { runUse } from './use.js'

describe('runUse', () => {
  let homeDir: string

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ucp-cli-use-test-'))
  })

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  it('persists a business URL into active.yaml', async () => {
    const result = await runUse({ business: 'https://shop.example.com' }, { homeDir })
    expect(result).toEqual({ business: 'https://shop.example.com', previous: null })
    const active = await readActive({ homeDir })
    expect(active.business).toBe('https://shop.example.com')
  })

  it('normalizes to origin (strips path/query)', async () => {
    const result = await runUse({ business: 'https://shop.example.com/foo?bar=1' }, { homeDir })
    expect(result.business).toBe('https://shop.example.com')
  })

  it('returns previous value when overwriting', async () => {
    await writeActive({ business: 'https://old.example.com' }, { homeDir })
    const result = await runUse({ business: 'https://new.example.com' }, { homeDir })
    expect(result).toEqual({
      business: 'https://new.example.com',
      previous: 'https://old.example.com',
    })
  })

  it('preserves other active.yaml keys (e.g. profile)', async () => {
    await writeActive({ profile: 'prod', business: 'https://old.example.com' }, { homeDir })
    await runUse({ business: 'https://new.example.com' }, { homeDir })
    const active = await readActive({ homeDir })
    expect(active.profile).toBe('prod')
    expect(active.business).toBe('https://new.example.com')
  })

  it('clears business with --clear', async () => {
    await writeActive({ profile: 'prod', business: 'https://shop.example.com' }, { homeDir })
    const result = await runUse({ clear: true }, { homeDir })
    expect(result).toEqual({ business: null, previous: 'https://shop.example.com' })
    const active = await readActive({ homeDir })
    expect(active.business).toBeUndefined()
    expect(active.profile).toBe('prod')
  })

  it('--clear on already-empty business is a no-op', async () => {
    await writeActive({ profile: 'prod' }, { homeDir })
    const result = await runUse({ clear: true }, { homeDir })
    expect(result).toEqual({ business: null, previous: null })
  })

  it('rejects non-HTTPS URLs', async () => {
    await expect(
      runUse({ business: 'http://shop.example.com' }, { homeDir }),
    ).rejects.toMatchObject({ layer: 'client' })
  })

  it('rejects malformed URLs', async () => {
    await expect(runUse({ business: 'not-a-url' }, { homeDir })).rejects.toMatchObject({
      layer: 'client',
    })
  })

  it('rejects empty input (neither business nor --clear)', async () => {
    await expect(runUse({}, { homeDir })).rejects.toMatchObject({
      layer: 'client',
      code: 'INVALID_INPUT',
    })
  })

  it('rejects passing both business and --clear', async () => {
    await expect(
      runUse({ business: 'https://shop.example.com', clear: true }, { homeDir }),
    ).rejects.toMatchObject({ layer: 'client', code: 'INVALID_INPUT' })
  })
})
