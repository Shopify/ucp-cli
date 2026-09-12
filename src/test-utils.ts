// Shared test helpers.
//
// Vitest discovers `*.test.ts`; this file is plain `.ts`, deliberately not a
// test file. Exports things every test uses: a serve() shim around incur's
// CLI dispatcher (captures stdout + exit code), and minimal default stubs for
// the profile-store dependency surface so individual tests only override the
// stubs they actually exercise.

import type { ProfileCliDependencies } from './cli/profile.js'
import type { createUcpCli } from './cli.js'
import {
  type AgentProfile,
  createDiyProfile,
  loadAgentProfile,
  type Profile,
  type ProfileSource,
} from './core/agent.js'
import { classifyStoredProfile, type ProfileKind } from './core/legacy-profile.js'
import type { PlatformProfile } from './core/profile.js'
import type {
  ActiveSession,
  DiyUserProfile,
  ProfileMeta,
  UserProfile,
} from './core/profile-store.js'
import { LATEST, RELEASES, type Version } from './core/releases.js'

const BLANK_BODY: PlatformProfile = {
  ucp: { version: '2026-08-25', status: 'success', services: {}, payment_handlers: {} },
  keys: [],
}

const BLANK_META: ProfileMeta = {
  created_at: '2026-05-01T00:00:00.000Z',
}

interface UserProfileOverrides {
  body?: PlatformProfile | undefined
  meta?: ProfileMeta | undefined
  kind?: ProfileKind | undefined
}

/**
 * A stubbed `readUserProfile` result. `kind` is CLASSIFIED, not defaulted, so
 * a stub cannot claim a kind the real store would never return for the same
 * two documents; pass `kind` explicitly to model a marked profile.
 */
export function userProfile(name: string): DiyUserProfile
export function userProfile(name: string, overrides: UserProfileOverrides): UserProfile
export function userProfile(name: string, overrides: UserProfileOverrides = {}): UserProfile {
  const body = overrides.body ?? BLANK_BODY
  const meta = overrides.meta ?? BLANK_META
  const kind = overrides.kind ?? classifyStoredProfile(body, meta).kind
  if (kind === 'managed') {
    return {
      name,
      meta,
      kind,
      ...(overrides.body !== undefined ? { body: overrides.body } : {}),
    }
  }
  return { name, body, meta, kind }
}

export interface AgentProfileFixtureOptions {
  /** Spec release the profile declares. Defaults to {@link LATEST}. */
  version?: Version
  /** Body provenance. Defaults to a locally authored DIY rendering. */
  source?: ProfileSource
  /** Explicit URL-override provenance. Defaults false. */
  urlOverride?: boolean
  /** Local profile name used in messages. Defaults to `'agent'`. */
  name?: string
  /** Hosted URL. Defaults to the release's published agent-profile URL. */
  url?: string
  /** Replace `ucp.services` wholesale (the platform side of negotiation). */
  services?: Record<string, Array<Record<string, unknown>>>
  /** Replace `ucp.capabilities` wholesale. */
  capabilities?: Record<string, Array<Record<string, unknown>>>
}

/**
 * Build a fetched-and-validated {@link AgentProfile} for tests.
 *
 * Starts from the release's VERBATIM published template (the document
 * `profile init` writes) and runs it through the real `loadAgentProfile`, so
 * fixtures cannot declare something the loader would
 * have rejected — e.g. a `dev.ucp.*` entry off the profile's own version.
 */
export function agentProfileFixture(options: AgentProfileFixtureOptions = {}): AgentProfile {
  const version = options.version ?? LATEST
  const release = RELEASES[version]
  const body = JSON.parse(release.agentProfileJson) as {
    ucp: Record<string, unknown>
  }
  if (options.services !== undefined) body.ucp.services = options.services
  if (options.capabilities !== undefined) body.ucp.capabilities = options.capabilities
  return loadAgentProfile({
    body,
    url: options.url ?? release.defaultAgentProfileUrl,
    source: options.source ?? 'diy',
    urlOverride: options.urlOverride ?? false,
    name: options.name ?? 'agent',
  })
}

/**
 * One rendering of a runtime {@link Profile}, asserting it exists.
 * `Profile.renderings` is `Partial` by contract (a DIY Profile fills exactly
 * one key), so tests that know which key they seeded say so here instead of
 * spreading non-null assertions.
 */
export function rendering(profile: Profile, version: Version): AgentProfile {
  const found = profile.renderings[version]
  if (found === undefined) {
    throw new Error(
      `test fixture has no UCP ${version} rendering (has: ${Object.keys(profile.renderings).join(', ') || 'none'})`,
    )
  }
  return found
}

export type ProfileFixtureOptions = Omit<AgentProfileFixtureOptions, 'source'>

/** Build a singleton DIY runtime Profile around {@link agentProfileFixture}. */
export function profileFixture(options: ProfileFixtureOptions = {}): Profile {
  const agent = agentProfileFixture(options)
  return createDiyProfile({
    body: agent.body,
    url: agent.url,
    urlOverride: agent.urlOverride,
    name: agent.name ?? 'agent',
  })
}

export async function serveCli(
  cli: ReturnType<typeof createUcpCli>,
  argv: string[],
): Promise<{ output: string; exitCode: number }> {
  let output = ''
  let exitCode: number | undefined
  await cli.serve(argv, {
    stdout(s) {
      output += s
    },
    exit(code) {
      exitCode = code
    },
  })
  return { output, exitCode: exitCode ?? 0 }
}

// Minimal noop defaults for the profile-store CRUD layer. Reads return empty/
// blank; writes succeed silently. Tests override only the stubs whose
// behavior they assert on, and assert against captured side effects rather
// than relying on default behavior staying constant.
export function defaultProfileDeps(): ProfileCliDependencies {
  return {
    listProfiles: async () => [],
    profileExists: async () => false,
    readUserProfile: async (name: string) => userProfile(name),
    readProfileMeta: async () => BLANK_META,
    saveUserProfile: async (input) =>
      userProfile(input.name, { meta: input.meta, body: input.body }),
    readActive: async () => ({}),
    writeActive: async () => {},
    env: {},
  }
}

// captureWrites / captureSaves return a stub plus the array it appends to,
// so tests can assert on the recorded calls without re-spelling the
// `array = []; stub = async (x) => { array.push(x) }` pattern each time.
export function captureWrites(): {
  writes: ActiveSession[]
  writeActive: (session: ActiveSession) => Promise<void>
} {
  const writes: ActiveSession[] = []
  return {
    writes,
    writeActive: async (session) => {
      writes.push(session)
    },
  }
}

export function captureSaves(
  produce: (
    input: Parameters<NonNullable<ProfileCliDependencies['saveUserProfile']>>[0],
  ) => UserProfile = (input) => userProfile(input.name, { meta: input.meta, body: input.body }),
): {
  saves: Array<Parameters<NonNullable<ProfileCliDependencies['saveUserProfile']>>[0]>
  saveUserProfile: NonNullable<ProfileCliDependencies['saveUserProfile']>
} {
  const saves: Array<Parameters<NonNullable<ProfileCliDependencies['saveUserProfile']>>[0]> = []
  return {
    saves,
    saveUserProfile: async (input) => {
      saves.push(input)
      return produce(input)
    },
  }
}

// Proxy-env isolation for tests.
//
// All six vars must be cleared, not just the four triggers: NO_PROXY/no_proxy
// change the rendered proxy summary by their mere presence, so a test that
// clears less passes on a clean laptop and fails on a proxied CI runner — the
// exact environment the proxy feature serves.
//
// Cleanup must call `resetProxyStateForTests()`, never the installer: running
// `installProxyDispatcher()` after `vi.unstubAllEnvs()` would install the
// developer's real corporate proxy as the process-global dispatcher for the
// rest of the worker.
export const PROXY_ENV_VARS = [
  'http_proxy',
  'HTTP_PROXY',
  'https_proxy',
  'HTTPS_PROXY',
  'no_proxy',
  'NO_PROXY',
] as const

/** Clear every proxy var so assertions do not depend on the host env. */
export function clearProxyEnv(stubEnv: (name: string, value: undefined) => void): void {
  for (const name of PROXY_ENV_VARS) stubEnv(name, undefined)
}
