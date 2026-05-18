// Shared test helpers.
//
// Vitest discovers `*.test.ts`; this file is plain `.ts`, deliberately not a
// test file. Exports things every test uses: a serve() shim around incur's
// CLI dispatcher (captures stdout + exit code), and minimal default stubs for
// the profile-store dependency surface so individual tests only override the
// stubs they actually exercise.

import type { ProfileCliDependencies } from './cli/profile.js'
import type { createUcpCli } from './cli.js'
import type { PlatformProfile } from './core/profile.js'
import type { ActiveSession, UserProfile } from './core/profile-store.js'

const BLANK_BODY: PlatformProfile = {
  ucp: { version: '2026-04-08', status: 'success', services: {}, payment_handlers: {} },
  signing_keys: [],
}

const BLANK_META = {
  created_at: '2026-05-01T00:00:00.000Z',
  protocol_versions: { min: '2026-01-23', max: '2026-04-08' },
}

export function userProfile(name: string, overrides: Partial<UserProfile> = {}): UserProfile {
  return { name, body: BLANK_BODY, meta: BLANK_META, ...overrides }
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
    saveUserProfile: async (input) =>
      userProfile(input.name, { meta: input.meta, body: input.body }),
    readActive: async () => ({}),
    writeActive: async () => {},
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
