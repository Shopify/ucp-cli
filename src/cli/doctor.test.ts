// runDoctor() — local install health check.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlatformProfile } from '../core/profile.js'
import { saveUserProfile, writeActive } from '../core/profile-store.js'
import { runDoctor } from './doctor.js'

const SAMPLE_BODY: PlatformProfile = {
  ucp: { version: '2026-04-08', status: 'success', services: {}, payment_handlers: {} },
  signing_keys: [],
}

const SAMPLE_META = {
  created_at: '2026-05-05T12:00:00Z',
  profile_url: 'https://mybot.example.com/profile.json',
}

function findCheck(
  result: { checks: { id: string; status: string; detail: string }[] },
  id: string,
) {
  const check = result.checks.find((c) => c.id === id)
  if (check === undefined) throw new Error(`no check with id "${id}" in ${JSON.stringify(result)}`)
  return check
}

describe('runDoctor — clean install', () => {
  let homeDir: string

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ucp-cli-doctor-test-'))
  })
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  it('passes writability checks but fails active profile when nothing is configured', async () => {
    const result = await runDoctor({ homeDir, skipNetwork: true, env: {} })
    expect(result.ok).toBe(false)
    expect(findCheck(result, 'ucp-home').status).toBe('ok')
    expect(findCheck(result, 'profiles-dir').status).toBe('ok')
    expect(findCheck(result, 'cache-dir').status).toBe('ok')
    expect(findCheck(result, 'active-yaml').status).toBe('ok')
    expect(findCheck(result, 'active-profile').status).toBe('fail')
    expect(findCheck(result, 'active-profile').detail).toContain('profile init --name agent')
  })
})

describe('runDoctor — active.yaml states', () => {
  let homeDir: string

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ucp-cli-doctor-test-'))
  })
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  it('reports active.yaml content when present and parseable', async () => {
    await saveUserProfile({ name: 'prod', body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir })
    await writeActive({ profile: 'prod', business: 'https://shop.example.com' }, { homeDir })
    const result = await runDoctor({ homeDir, skipNetwork: true, env: {} })
    const active = findCheck(result, 'active-yaml')
    expect(active.status).toBe('ok')
    expect(active.detail).toContain('"business":"https://shop.example.com"')
  })

  it('warns on corrupt active.yaml and fails because no profile is selected', async () => {
    await writeFile(join(homeDir, 'active.yaml'), '!!! not yaml [[[ broken', 'utf-8')
    const result = await runDoctor({ homeDir, skipNetwork: true, env: {} })
    expect(result.ok).toBe(false)
    expect(findCheck(result, 'active-yaml').status).toBe('warn')
    expect(findCheck(result, 'active-profile').status).toBe('fail')
  })
})

describe('runDoctor — user profile branch', () => {
  let homeDir: string

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ucp-cli-doctor-test-'))
  })
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  it('passes when the named profile is on disk and parses', async () => {
    await saveUserProfile({ name: 'prod', body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir })
    await writeActive({ profile: 'prod' }, { homeDir })
    const result = await runDoctor({ homeDir, skipNetwork: true, env: {} })
    expect(result.ok).toBe(true)
    expect(findCheck(result, 'active-profile').status).toBe('ok')
  })

  it('fails when active.yaml references a profile that does not exist', async () => {
    await writeActive({ profile: 'ghost' }, { homeDir })
    const result = await runDoctor({ homeDir, skipNetwork: true, env: {} })
    expect(result.ok).toBe(false)
    expect(findCheck(result, 'active-profile').status).toBe('fail')
    expect(findCheck(result, 'active-profile').detail).toContain('ghost')
  })

  it('UCP_PROFILE env wins over active.yaml when checking which profile to validate', async () => {
    await saveUserProfile({ name: 'prod', body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir })
    await writeActive({ profile: 'ghost' }, { homeDir })
    const result = await runDoctor({
      homeDir,
      skipNetwork: true,
      env: { UCP_PROFILE: 'prod' },
    })
    expect(result.ok).toBe(true)
    expect(findCheck(result, 'active-profile').status).toBe('ok')
  })
})

describe('runDoctor — network probe', () => {
  let homeDir: string

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ucp-cli-doctor-test-'))
  })
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  it('marks profile-url ok when HEAD returns 2xx', async () => {
    await saveUserProfile({ name: 'prod', body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir })
    await writeActive({ profile: 'prod' }, { homeDir })
    const fakeFetch = vi.fn(async () => new Response(null, { status: 200 }))
    const result = await runDoctor({
      homeDir,
      env: {},
      fetch: fakeFetch as unknown as typeof fetch,
    })
    expect(findCheck(result, 'profile-url').status).toBe('ok')
    expect(fakeFetch).toHaveBeenCalledWith(
      'https://mybot.example.com/profile.json',
      expect.objectContaining({ method: 'HEAD' }),
    )
  })

  it('warns (does not fail) when HEAD returns non-2xx — profile may not be hosted yet', async () => {
    await saveUserProfile({ name: 'prod', body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir })
    await writeActive({ profile: 'prod' }, { homeDir })
    const fakeFetch = vi.fn(async () => new Response(null, { status: 404 }))
    const result = await runDoctor({
      homeDir,
      env: {},
      fetch: fakeFetch as unknown as typeof fetch,
    })
    expect(result.ok).toBe(true)
    expect(findCheck(result, 'profile-url').status).toBe('warn')
  })

  it('warns when fetch throws (network unreachable)', async () => {
    await saveUserProfile({ name: 'prod', body: SAMPLE_BODY, meta: SAMPLE_META }, { homeDir })
    await writeActive({ profile: 'prod' }, { homeDir })
    const fakeFetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const result = await runDoctor({
      homeDir,
      env: {},
      fetch: fakeFetch as unknown as typeof fetch,
    })
    expect(result.ok).toBe(true)
    expect(findCheck(result, 'profile-url').status).toBe('warn')
    expect(findCheck(result, 'profile-url').detail).toContain('ECONNREFUSED')
  })

  it('warns when local profile has no profile_url yet', async () => {
    await saveUserProfile(
      { name: 'deferred', body: SAMPLE_BODY, meta: { created_at: SAMPLE_META.created_at } },
      { homeDir },
    )
    await writeActive({ profile: 'deferred' }, { homeDir })
    const fakeFetch = vi.fn()
    const result = await runDoctor({
      homeDir,
      env: {},
      fetch: fakeFetch as unknown as typeof fetch,
    })
    expect(result.ok).toBe(true)
    expect(findCheck(result, 'profile-url').status).toBe('warn')
    expect(fakeFetch).not.toHaveBeenCalled()
  })

  it('skipNetwork omits the profile-url check', async () => {
    const result = await runDoctor({ homeDir, skipNetwork: true, env: {} })
    expect(result.checks.find((c) => c.id === 'profile-url')).toBeUndefined()
  })
})
