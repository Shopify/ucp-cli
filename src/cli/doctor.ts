// `ucp doctor` — local install health check.
//
// Verifies what can be answered locally, plus a single HEAD probe of the
// active profile's hosting URL. Each check that doesn't yet have a feature
// behind it is deliberately omitted: an always-green check for a feature
// that doesn't ship trains users to ignore the output.
//
// Returns a structured envelope so machine consumers (CI, agents) can
// pattern-match on individual checks. `ok` is the AND of all `fail` checks;
// `warn` statuses don't gate `ok` because they describe optional state (e.g.
// a local profile before the upload service returns a profile_url).

import { access, constants, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  activeYamlPath,
  type ProfileStoreOptions,
  profileDir,
  profileStoreHome,
  profilesRoot,
  readActive,
  readUserProfile,
} from '../core/profile-store.js'

export interface DoctorDeps {
  homeDir?: string
  /** Injectable fetch for tests / offline mode. */
  fetch?: typeof fetch
  /** Skip the network probe. Defaults to false. */
  skipNetwork?: boolean
  /** Override env-var lookup for tests. */
  env?: Record<string, string | undefined>
}

export type CheckStatus = 'ok' | 'warn' | 'fail'

export interface Check {
  id: string
  status: CheckStatus
  detail: string
}

export interface DoctorResult {
  ok: boolean
  checks: Check[]
}

const HEAD_TIMEOUT_MS = 5_000

export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorResult> {
  const env = deps.env ?? process.env
  const storeOpts: ProfileStoreOptions = deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}
  const checks: Check[] = []

  // 1. ~/.ucp home + cache + profiles dirs writable. Side-effect: mkdir
  // recursive so a clean install passes (matches what readActive/saveUserProfile
  // do on first write). Failure here means the rest of the CLI is broken too.
  const home = profileStoreHome(storeOpts)
  checks.push(await checkWritable('ucp-home', home))
  checks.push(await checkWritable('profiles-dir', profilesRoot(storeOpts)))
  checks.push(await checkWritable('cache-dir', join(home, 'cache')))

  // 2. active.yaml resolves (degraded-empty allowed; readActive never throws).
  // The check exists so a corrupt file shows up explicitly rather than silently
  // collapsing the session to defaults.
  const activeCheck = await checkActive(storeOpts)
  checks.push(activeCheck)

  // 3. Active local profile parses from disk. Profile init is required; there
  // is no synthetic runtime profile for operations.
  const active = await readActive(storeOpts)
  const profileName = env.UCP_PROFILE ?? active.profile
  checks.push(await checkProfile(profileName, storeOpts))

  // 4. Profile hosting URL reachable. HEAD is best-effort: warn (not fail) on
  // failure since a missing-yet-managed profile URL is a legitimate intermediate state
  // and a network blip shouldn't fail `doctor` for a perfectly valid setup.
  if (deps.skipNetwork !== true) {
    checks.push(await checkProfileUrl(profileName, storeOpts, env, deps.fetch ?? fetch))
  }

  const ok = checks.every((c) => c.status !== 'fail')
  return { ok, checks }
}

async function checkWritable(id: string, path: string): Promise<Check> {
  try {
    await mkdir(path, { recursive: true })
    await access(path, constants.W_OK)
    return { id, status: 'ok', detail: path }
  } catch (err) {
    return { id, status: 'fail', detail: `${path}: ${(err as Error).message}` }
  }
}

async function checkActive(opts: ProfileStoreOptions): Promise<Check> {
  // readActive degrades to {} on parse failure; check the file directly so we
  // can distinguish "missing" (fine) from "present but malformed" (warn).
  try {
    await access(activeYamlPath(opts), constants.R_OK)
  } catch {
    return { id: 'active-yaml', status: 'ok', detail: 'no active.yaml' }
  }
  const active = await readActive(opts)
  // readActive returning empty {} when the file exists is the malformed signal.
  // It's the same shape as a stale file truncated to 0 bytes; treat as warn so
  // the user knows but it doesn't gate `ok`.
  if (Object.keys(active).length === 0) {
    return {
      id: 'active-yaml',
      status: 'warn',
      detail: `${activeYamlPath(opts)} present but parsed empty (corrupt or truncated?)`,
    }
  }
  return { id: 'active-yaml', status: 'ok', detail: JSON.stringify(active) }
}

async function checkProfile(name: string | undefined, opts: ProfileStoreOptions): Promise<Check> {
  if (name === undefined || name === '') {
    return {
      id: 'active-profile',
      status: 'fail',
      detail: 'no local profile selected; run `ucp profile init --name agent`',
    }
  }
  try {
    await access(profileDir(name, opts), constants.R_OK)
  } catch {
    return {
      id: 'active-profile',
      status: 'fail',
      detail: `profile "${name}" referenced but not found on disk`,
    }
  }
  try {
    await readUserProfile(name, opts)
    return { id: 'active-profile', status: 'ok', detail: `profile "${name}" parsed cleanly` }
  } catch (err) {
    return {
      id: 'active-profile',
      status: 'fail',
      detail: `profile "${name}" failed to parse: ${(err as Error).message}`,
    }
  }
}

async function checkProfileUrl(
  name: string | undefined,
  opts: ProfileStoreOptions,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
): Promise<Check> {
  let url: string | undefined
  if (name === undefined || name === '') {
    return { id: 'profile-url', status: 'warn', detail: 'no local profile; skipped probe' }
  }
  try {
    const profile = await readUserProfile(name, opts)
    url = env.UCP_AGENT_PROFILE_URL ?? profile.meta.profile_url
  } catch {
    // already covered by checkProfile; silent here to avoid double-fail noise
    return { id: 'profile-url', status: 'warn', detail: 'profile unreadable; skipped probe' }
  }
  if (url === undefined || url === '') {
    return {
      id: 'profile-url',
      status: 'warn',
      detail: 'profile has no profile_url (managed upload may not be configured yet)',
    }
  }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), HEAD_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, { method: 'HEAD', signal: ac.signal })
    if (res.ok) {
      return { id: 'profile-url', status: 'ok', detail: `${url} → ${res.status}` }
    }
    return {
      id: 'profile-url',
      status: 'warn',
      detail: `${url} → HTTP ${res.status} (profile may not be hosted yet)`,
    }
  } catch (err) {
    return {
      id: 'profile-url',
      status: 'warn',
      detail: `${url} unreachable: ${(err as Error).message}`,
    }
  } finally {
    clearTimeout(timer)
  }
}
