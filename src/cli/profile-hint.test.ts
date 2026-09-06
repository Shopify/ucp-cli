// The switch-profiles hint for PROTOCOL_VERSION_INCOMPATIBLE.
//
// The rule under test is where a local profile's version comes from:
// `profile.json`, exactly like request-time negotiation. The end-to-end wire
// assertions live in `src/cli-errors.test.ts`; this suite pins the derivation
// itself so the profile URL cannot override the local declaration.

import { describe, expect, it } from 'vitest'

import type { UserProfile } from '../core/profile-store.js'
import { LATEST, RELEASES, type Version } from '../core/releases.js'
import { userProfile } from '../test-utils.js'
import { buildProfileSwitchCta, localProfilesSpeaking } from './profile-hint.js'

const URL_0408 = RELEASES['2026-04-08'].defaultAgentProfileUrl
const URL_0825 = RELEASES['2026-08-25'].defaultAgentProfileUrl

interface StoredProfile {
  version: Version
  profileUrl?: string
}

function profileBody(version: Version): UserProfile['body'] {
  return JSON.parse(RELEASES[version].agentProfileJson) as UserProfile['body']
}

function store(profiles: Record<string, StoredProfile>) {
  return {
    listProfiles: async () => Object.keys(profiles).sort(),
    readUserProfile: async (name: string) => {
      const profile = profiles[name]
      if (profile === undefined) throw new Error(`no such profile: ${name}`)
      return userProfile(name, {
        body: profileBody(profile.version),
        meta: profile.profileUrl === undefined ? {} : { profile_url: profile.profileUrl },
      })
    },
  }
}

describe('localProfilesSpeaking', () => {
  it('reads the version from profile.json even when the URL implies another release', async () => {
    const matches = await localProfilesSpeaking(
      ['2026-04-08'],
      'agent',
      store({
        agent: { version: '2026-08-25', profileUrl: URL_0825 },
        'agent-0408': { version: '2026-04-08', profileUrl: URL_0825 },
      }),
    )
    expect(matches).toStrictEqual([{ name: 'agent-0408', version: '2026-04-08' }])
  })

  it('excludes the active profile — it is the one that just failed', async () => {
    const matches = await localProfilesSpeaking(
      ['2026-04-08'],
      'agent-0408',
      store({ 'agent-0408': { version: '2026-04-08', profileUrl: URL_0408 } }),
    )
    expect(matches).toStrictEqual([])
  })

  it('excludes profiles whose profile.json version is not offered', async () => {
    const matches = await localProfilesSpeaking(
      ['2026-04-08'],
      'agent',
      store({
        agent: { version: '2026-08-25', profileUrl: URL_0825 },
        other: { version: '2026-08-25', profileUrl: URL_0408 },
      }),
    )
    expect(matches).toStrictEqual([])
  })

  it('includes a matching profile when the URL is the user’s', async () => {
    const matches = await localProfilesSpeaking(
      ['2026-04-08'],
      'agent',
      store({
        agent: { version: '2026-08-25', profileUrl: URL_0825 },
        mine: { version: '2026-04-08', profileUrl: 'https://you.example/agent.json' },
      }),
    )
    expect(matches).toStrictEqual([{ name: 'mine', version: '2026-04-08' }])
  })

  it('includes a matching profile with no profile_url', async () => {
    const matches = await localProfilesSpeaking(
      ['2026-04-08'],
      'agent',
      store({
        agent: { version: '2026-08-25', profileUrl: URL_0825 },
        deferred: { version: '2026-04-08' },
      }),
    )
    expect(matches).toStrictEqual([{ name: 'deferred', version: '2026-04-08' }])
  })

  it('is best-effort: an unreadable profile is skipped, not fatal', async () => {
    // This decorates an error that already happened. Throwing here would
    // replace a precise version-mismatch report with a profile-store failure.
    const matches = await localProfilesSpeaking(['2026-04-08'], 'agent', {
      listProfiles: async () => ['broken', 'agent-0408'],
      readUserProfile: async (name: string) => {
        if (name === 'broken') throw new Error('meta.json is not valid JSON')
        return userProfile(name, {
          body: profileBody('2026-04-08'),
          meta: { profile_url: URL_0408 },
        })
      },
    })
    expect(matches).toStrictEqual([{ name: 'agent-0408', version: '2026-04-08' }])
  })

  it('survives a profile store that cannot be listed at all', async () => {
    const matches = await localProfilesSpeaking(['2026-04-08'], 'agent', {
      listProfiles: async () => {
        throw new Error('EACCES')
      },
      readUserProfile: async (name: string) => userProfile(name),
    })
    expect(matches).toStrictEqual([])
  })
})

describe('buildProfileSwitchCta', () => {
  it('is undefined with no matches — an empty CTA is worse than none', () => {
    expect(buildProfileSwitchCta([], { command: 'discover', displayName: 'ucp' })).toBeUndefined()
  })

  it('names every match, because which one to use depends on what else it declares', () => {
    const cta = buildProfileSwitchCta(
      [
        { name: 'agent-0408', version: '2026-04-08' },
        { name: 'legacy', version: '2026-04-08' },
      ],
      { command: 'catalog search', displayName: 'ucp' },
    )
    expect(cta?.description).toContain("'agent-0408' speaks 2026-04-08")
    expect(cta?.description).toContain("'legacy' speaks 2026-04-08")
    // `Cta` is incur's generic command type (a string or a {command,...}
    // object); the hint always emits the object form.
    expect(cta?.commands.map((c) => (typeof c === 'string' ? c : c.command))).toStrictEqual([
      'ucp catalog search --profile agent-0408',
      'ucp catalog search --profile legacy',
    ])
  })

  it('explains that switching profiles is the version switch, with no reinstall', () => {
    const cta = buildProfileSwitchCta([{ name: 'other', version: LATEST }], {
      command: 'discover',
      displayName: 'ucp',
    })
    expect(cta?.description).toMatch(/ACTIVE profile/)
    expect(cta?.description).toMatch(/No reinstall/)
  })
})
