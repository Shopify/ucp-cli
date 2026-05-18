// User profile filesystem management.
//
// Operates on the `~/.ucp/profiles/<name>/` tree:
//
//   profiles/
//     <name>/
//       profile.json   — agent profile body (the artifact the user hosts)
//       meta.json      — { profile_url?, defaults?, created_at?, protocol_versions? }
//
// Plus the session-state pair:
//
//   active.yaml        — { profile?: string, business?: string }
//
// Local key material is intentionally absent: the spec mandates RFC 9421 + ECDSA
// (P-256) over JWK keys for both REST and MCP transports, and we add that
// in v0.1.1 once the implementation has its own conformance harness against
// the RFC's canonical vectors. Until then `signing_keys[]` in user-authored
// profile bodies is allowed but unused on the client side.
//
// CRUD primitives only — user-facing verbs (`init`, `list`, `show`, `publish`,
// `use`) are layered on top.
//
// Naming rule: profile names must match `^[a-z0-9][a-z0-9._-]*$`. Same
// charset as cache filenames (PROTOCOL §7) so cross-platform behavior
// is uniform. Lowercase-only to avoid macOS/Windows case-insensitive
// filesystem surprises.

import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { z } from 'incur'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { ErrorCodes, UcpError } from '../lib/errors.js'
import { formatZodIssues } from '../lib/zod-format.js'
import { type PlatformProfile, parsePlatformProfile } from './profile.js'
import { acceptsHttpsUrl } from './url.js'

// ─── Schemas (zod) ────────────────────────────────────────────────────────
//
// User-facing files (active.yaml, meta.json, profile.json) parse through
// these. Validation gives every parse boundary a structured failure
// instead of `as`-casted garbage propagating into transport code paths.
// PROTOCOL §12 forward-compat rule: `.loose()` on metadata-shaped objects
// so unknown fields survive.

const httpsUrlSchema = z.string().refine((value) => acceptsHttpsUrl(value), {
  message: 'must be an HTTPS URL',
})

export const profileMetaSchema = z
  .object({
    // All fields optional: profile init can defer hosting/catalog wiring, and
    // session.ts supplies runtime fallbacks where appropriate.
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    // Optional because a freshly-created local profile may be intended for
    // managed hosting before the upload service exists. Supplying a URL means
    // either the user hosts profile.json themselves or the managed service has
    // returned its canonical URL; publish infers which by URL origin.
    profile_url: httpsUrlSchema.optional(),
    profile_id: z.string().optional(),
    etag: z.string().optional(),
    published_at: z.string().optional(),
    protocol_versions: z.object({ min: z.string(), max: z.string() }).optional(),
    // `defaults.catalog` is the business URL catalog ops fall back to when
    // no business is resolved. Discovery hits `<catalog>/.well-known/ucp`
    // through the normal `discover()` path — no bypass. `.loose()` for
    // PROTOCOL §12 forward-compat: future `defaults.cart` etc. survive on
    // old clients. HTTPS-only so a broken meta.json fails at the profile
    // boundary, not mid-dispatch.
    defaults: z.object({ catalog: httpsUrlSchema.optional() }).loose().optional(),
  })
  .loose()

export const activeSessionSchema = z
  .object({
    profile: z.string().optional(),
    business: z.string().optional(),
  })
  .loose()

export type ProfileMeta = z.infer<typeof profileMetaSchema>
export type ActiveSession = z.infer<typeof activeSessionSchema>

export interface UserProfile {
  name: string
  body: PlatformProfile
  meta: ProfileMeta
}

export interface ProfileStoreOptions {
  /** Override the UCP home directory ($UCP_HOME or ~/.ucp). For tests. */
  homeDir?: string
}

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/

// ─── Path helpers ─────────────────────────────────────────────────────────

export function profileStoreHome(opts: ProfileStoreOptions = {}): string {
  return opts.homeDir ?? process.env.UCP_HOME ?? join(homedir(), '.ucp')
}

export function profilesRoot(opts: ProfileStoreOptions = {}): string {
  return join(profileStoreHome(opts), 'profiles')
}

export function profileDir(name: string, opts: ProfileStoreOptions = {}): string {
  return join(profilesRoot(opts), name)
}

export function activeYamlPath(opts: ProfileStoreOptions = {}): string {
  return join(profileStoreHome(opts), 'active.yaml')
}

export function validateProfileName(name: string): void {
  if (!PROFILE_NAME_RE.test(name)) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.PROFILE_INVALID_NAME,
      message: `profile name "${name}" must match ^[a-z0-9][a-z0-9._-]*$ (lowercase, start with alphanumeric)`,
    })
  }
}

// ─── Profile CRUD ─────────────────────────────────────────────────────────

export async function listProfiles(opts: ProfileStoreOptions = {}): Promise<string[]> {
  const root = profilesRoot(opts)
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return []
  }
  // Filter out non-directories; ignore anything that doesn't match the name rule.
  const result: string[] = []
  for (const name of entries) {
    if (!PROFILE_NAME_RE.test(name)) continue
    try {
      const s = await stat(join(root, name))
      if (s.isDirectory()) result.push(name)
    } catch {
      // race or permission issue — skip
    }
  }
  return result.sort()
}

export async function profileExists(
  name: string,
  opts: ProfileStoreOptions = {},
): Promise<boolean> {
  if (!PROFILE_NAME_RE.test(name)) return false
  try {
    const s = await stat(profileDir(name, opts))
    return s.isDirectory()
  } catch {
    return false
  }
}

export async function readUserProfile(
  name: string,
  opts: ProfileStoreOptions = {},
): Promise<UserProfile> {
  validateProfileName(name)
  const dir = profileDir(name, opts)
  let bodyRaw: string
  let metaRaw: string
  try {
    ;[bodyRaw, metaRaw] = await Promise.all([
      readFile(join(dir, 'profile.json'), 'utf-8'),
      readFile(join(dir, 'meta.json'), 'utf-8'),
    ])
  } catch (err) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.PROFILE_NOT_FOUND,
      message: `profile "${name}" not found at ${dir}`,
      cause: err as Error,
    })
  }
  let bodyParsed: unknown
  let metaParsed: unknown
  try {
    bodyParsed = JSON.parse(bodyRaw)
    metaParsed = JSON.parse(metaRaw)
  } catch (err) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.SCHEMA_VALIDATION_FAILED,
      message: `profile "${name}": profile.json or meta.json is not valid JSON`,
      cause: err as Error,
    })
  }
  // parsePlatformProfile throws UcpError(client, SCHEMA_VALIDATION_FAILED) on
  // failure — same shape and layer as meta-schema failures, so a meta-only
  // failure path stays the only thing left to handle inline.
  const body = parsePlatformProfile(bodyParsed, `profile "${name}"`)
  const meta = profileMetaSchema.safeParse(metaParsed)
  if (!meta.success) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.SCHEMA_VALIDATION_FAILED,
      message: `profile "${name}" meta.json failed schema validation: ${formatZodIssues(meta.error.issues)}`,
    })
  }
  return { name, body, meta: meta.data }
}

export interface SaveProfileInput {
  name: string
  body: PlatformProfile
  meta: ProfileMeta
  /** Allow overwriting an existing profile. Default false. */
  overwrite?: boolean
}

export async function saveUserProfile(
  input: SaveProfileInput,
  opts: ProfileStoreOptions = {},
): Promise<UserProfile> {
  validateProfileName(input.name)
  const dir = profileDir(input.name, opts)
  if (input.overwrite !== true && (await profileExists(input.name, opts))) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.PROFILE_ALREADY_EXISTS,
      message: `profile "${input.name}" already exists at ${dir}`,
    })
  }
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await Promise.all([
    writeFile(join(dir, 'profile.json'), `${JSON.stringify(input.body, null, 2)}\n`, 'utf-8'),
    writeFile(join(dir, 'meta.json'), `${JSON.stringify(input.meta, null, 2)}\n`, 'utf-8'),
  ])
  return { name: input.name, body: input.body, meta: input.meta }
}

// ─── Active session (active.yaml) ─────────────────────────────────────────

/**
 * active.yaml is session state — low-stakes and may be hand-edited. Missing
 * file, malformed YAML, and shape mismatch all degrade to an empty session
 * rather than throwing: a corrupt active.yaml shouldn't take the whole
 * dispatcher offline. profile.json / meta.json are different — those are
 * identity material and {@link readUserProfile} is strict.
 */
export async function readActive(opts: ProfileStoreOptions = {}): Promise<ActiveSession> {
  let raw: string
  try {
    raw = await readFile(activeYamlPath(opts), 'utf-8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch {
    return {}
  }
  if (parsed === null || parsed === undefined) return {}
  const result = activeSessionSchema.safeParse(parsed)
  return result.success ? result.data : {}
}

export async function writeActive(
  session: ActiveSession,
  opts: ProfileStoreOptions = {},
): Promise<void> {
  const home = profileStoreHome(opts)
  await mkdir(home, { recursive: true })
  await writeFileAtomic(activeYamlPath(opts), stringifyYaml(session))
}

// Same-FS rename is atomic on POSIX, so readers never see a torn file and
// crash-mid-write leaves the previous version in place. No fsync — the cost
// of losing the last write on power-loss is one re-issue of the caller.
async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`
  try {
    await writeFile(tmp, content, 'utf-8')
    await rename(tmp, filePath)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}
