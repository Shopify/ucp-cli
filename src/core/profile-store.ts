// User profile filesystem management.
//
// Operates on the `~/.ucp/profiles/<name>/` tree:
//
//   profiles/
//     <name>/
//       profile.json   — agent profile body (the artifact the user hosts)
//       meta.json      — { profile_url?, defaults?, created_at? }
//
// Role split, load-bearing (see src/cli/session.ts and src/core/agent.ts).
// For a named DIY Profile, `profile.json` is the declaration ucp-cli plans
// from and `meta.profile_url` is its stored rendering URL. A named managed
// alias keeps those files only as migration/storage state; session resolution
// rebuilds its runtime renderings from bundled releases. Nothing here fetches
// or uploads: `ucp doctor` is the only live reader of a Profile URL, and no
// ucp-cli command writes to one.
//
// Plus the session-state pair:
//
//   active.yaml        — { profile?: string, business?: string }
//
// Local key material is intentionally absent: the spec mandates RFC 9421 + ECDSA
// (P-256) over JWK keys for both REST and MCP transports, and we add that
// in v0.1.1 once the implementation has its own conformance harness against
// the RFC's canonical vectors. Until then `keys[]` (the profile's JWK Set;
// `signing_keys[]` before spec 2026-08-25) in user-authored profile bodies is
// allowed but unused on the client side.
//
// CRUD primitives only — user-facing verbs (`init`, `list`, `show`, `use`)
// are layered on top.
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
import type { CtaBlock } from '../lib/types.js'
import { formatZodIssues } from '../lib/zod-format.js'
import {
  classifyStoredProfile,
  markProfileMeta,
  PROFILE_FORMAT_VERSION,
  type ProfileKind,
} from './legacy-profile.js'
import { type PlatformProfile, parsePlatformProfile } from './profile.js'
import { acceptsHttpsUrl } from './url.js'
import { uwarn } from './verbose.js'

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
    // Optional for forward/backward compatibility: `profile init` writes it
    // so the remote identity is explicit, but an older profile may omit it,
    // in which case session resolution uses the profile body's release URL.
    profile_url: httpsUrlSchema.optional(),
    // `defaults.catalog` is the business URL catalog ops fall back to when
    // no business is resolved. Discovery hits `<catalog>/.well-known/ucp`
    // through the normal `discover()` path — no bypass. `.loose()` for
    // PROTOCOL §12 forward-compat: future `defaults.cart` etc. survive on
    // old clients. HTTPS-only so a broken meta.json fails at the profile
    // boundary, not mid-dispatch.
    defaults: z.object({ catalog: httpsUrlSchema.optional() }).loose().optional(),
    // ── Canonical format marker ─────────────────────────────────────────
    // Written once, by the legacy upgrade in `readUserProfile`. `kind` is
    // the stored classification that session resolution turns into a runtime
    // Profile (see core/legacy-profile.ts); `format_version` is what makes the
    // upgrade a one-time event — a marked profile is never fingerprinted
    // again. Both stay optional: an
    // unmigrated profile is legal input, that is the entire point.
    //
    // `format_version` is a plain integer, not a literal: a profile written
    // by a NEWER build must not fail this schema on an older client. Reading
    // it as "at least PROFILE_FORMAT_VERSION" keeps forward-compat honest.
    format_version: z.number().int().optional(),
    kind: z.enum(['managed', 'diy']).optional(),
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

interface UserProfileBase {
  name: string
  meta: ProfileMeta
}

export interface ManagedUserProfile extends UserProfileBase {
  /**
   * A managed Profile never requires a body. Reads omit even a historical
   * body used for classification; a save may still echo the body it wrote.
   */
  body?: PlatformProfile
  kind: 'managed'
}

export interface DiyUserProfile extends UserProfileBase {
  /** The locally authored declaration a DIY runtime Profile is built from. */
  body: PlatformProfile
  kind: 'diy'
}

/**
 * A stored Profile after classification. Callers branch on `kind`, never on
 * body shape — the fingerprint vocabulary stops at core/legacy-profile.ts.
 */
export type UserProfile = ManagedUserProfile | DiyUserProfile

export interface ProfileStoreOptions {
  /** Override the UCP home directory ($UCP_HOME or ~/.ucp). For tests. */
  homeDir?: string
}

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/

type StoredProfileFile = 'profile.json' | 'meta.json'

function profileRepairCta(name: string, file: StoredProfileFile): CtaBlock {
  const metadataGuidance =
    file === 'meta.json'
      ? 'Because meta.json could not be read and validated, ucp-cli cannot preserve a custom profile_url from it. Add --profile-url with the HTTPS URL you need to retain.'
      : 'Any custom profile_url in the readable, valid meta.json is preserved unless --profile-url is passed.'
  return {
    description: `Re-initializing Profile "${name}" rewrites its local DIY document from the selected release and updates its identity metadata, replacing local profile.json edits. ${metadataGuidance}`,
    commands: [
      {
        command: `ucp profile init --name ${name} --force`,
        description: `rewrite local DIY Profile "${name}" document and metadata`,
      },
    ],
  }
}

function parseStoredJson(raw: string, name: string, file: StoredProfileFile): unknown {
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.SCHEMA_VALIDATION_FAILED,
      message: `profile "${name}" ${file} is not valid JSON`,
      cause: err as Error,
      context: { kind: 'profile-store', profile: name, file },
      cta: profileRepairCta(name, file),
    })
  }
}

function validateStoredMeta(input: unknown, name: string): ProfileMeta {
  const meta = profileMetaSchema.safeParse(input)
  if (meta.success) return meta.data
  throw new UcpError({
    layer: 'client',
    code: ErrorCodes.SCHEMA_VALIDATION_FAILED,
    message: `profile "${name}" meta.json failed schema validation: ${formatZodIssues(meta.error.issues)}`,
    context: {
      kind: 'profile-store',
      profile: name,
      file: 'meta.json',
      issues: meta.error.issues,
    },
    cta: profileRepairCta(name, 'meta.json'),
  })
}

function storedProfileBodyError(name: string, err: UcpError): UcpError {
  const details = {
    message: err.shortMessage,
    ...(err.hint !== undefined ? { hint: err.hint } : {}),
    retryable: err.retryable,
    context: {
      kind: 'profile-store',
      profile: name,
      file: 'profile.json',
      ...(err.context !== undefined ? { validation: err.context } : {}),
    },
    cta: profileRepairCta(name, 'profile.json'),
  }
  if (err.code === ErrorCodes.AGENT_PROFILE_VERSION_UNSUPPORTED) {
    return new UcpError({
      layer: 'client',
      code: ErrorCodes.AGENT_PROFILE_VERSION_UNSUPPORTED,
      ...details,
    })
  }
  return new UcpError({
    layer: 'client',
    code: ErrorCodes.SCHEMA_VALIDATION_FAILED,
    ...details,
  })
}

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

async function readStoredProfileFile(
  name: string,
  file: StoredProfileFile,
  opts: ProfileStoreOptions,
): Promise<string> {
  const path = join(profileDir(name, opts), file)
  try {
    return await readFile(path, 'utf-8')
  } catch (err) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.PROFILE_NOT_FOUND,
      message: `profile "${name}" ${file} could not be read at ${path}`,
      cause: err as Error,
      context: { kind: 'profile-store', profile: name, file },
      cta: profileRepairCta(name, file),
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

/** Read and validate only a local Profile's metadata (used by --force repair). */
export async function readProfileMeta(
  name: string,
  opts: ProfileStoreOptions = {},
): Promise<ProfileMeta> {
  validateProfileName(name)
  const raw = await readStoredProfileFile(name, 'meta.json', opts)
  return validateStoredMeta(parseStoredJson(raw, name, 'meta.json'), name)
}

export interface ReadUserProfileOptions extends ProfileStoreOptions {
  /**
   * Test seam for the one-time marker write. Production uses the same atomic
   * rename `active.yaml` gets; a test injects a rejecting implementation to
   * prove a read-only (or full) `~/.ucp` still resolves a session.
   */
  writeMeta?: (path: string, content: string) => Promise<void>
  /**
   * Set false for exploratory scans. The Profile is still classified, but an
   * unmarked legacy meta.json is neither stamped nor reported as a failed
   * migration write. Active session reads leave this enabled (the default).
   */
  migrate?: boolean
}

async function stampProfileMeta(
  name: string,
  meta: ProfileMeta,
  kind: ProfileKind,
  needsMarker: boolean,
  opts: ReadUserProfileOptions,
): Promise<ProfileMeta> {
  if (!needsMarker || opts.migrate === false) return meta

  const marked = markProfileMeta(meta, kind)
  const metaPath = join(profileDir(name, opts), 'meta.json')
  const write = opts.writeMeta ?? writeFileAtomic
  try {
    await write(metaPath, `${JSON.stringify(marked, null, 2)}\n`)
  } catch (err) {
    uwarn(
      `profile "${name}": could not record format_version ${PROFILE_FORMAT_VERSION} / kind "${kind}" in ${metaPath} (${(err as Error).message}); continuing with the resolved profile and retrying on the next run`,
    )
  }
  return marked
}

/**
 * Read a local profile, resolving its {@link ProfileKind}.
 *
 * Unmarked profiles are classified once — see core/legacy-profile.ts for the
 * rules — and active reads stamp the decision into `meta.json` so the next
 * read is a plain lookup. Exploratory scans can set `migrate: false` to keep
 * classification read-only. Only `meta.json` is ever written: `profile.json`
 * and `headers.json` are the user's bytes and are left exactly as found, which
 * also keeps a downgrade to an older ucp-cli working.
 *
 * The marker write is best-effort. Commerce does not depend on it: a failed
 * stamp warns on stderr and returns the same in-memory classification, and
 * the next process tries again. The classification itself is deterministic,
 * so "retry later" cannot mean "decide differently".
 */
export async function readUserProfile(
  name: string,
  opts: ReadUserProfileOptions = {},
): Promise<UserProfile> {
  // Metadata first is deliberate. Besides making repair guidance accurate,
  // it lets an explicit managed marker terminate the read before profile.json:
  // that file is retained only for downgrade compatibility and may be absent
  // or damaged without changing the managed runtime identity.
  const meta = await readProfileMeta(name, opts)
  if (meta.kind === 'managed') {
    const { needsMarker } = classifyStoredProfile(undefined, meta)
    return {
      name,
      meta: await stampProfileMeta(name, meta, 'managed', needsMarker, opts),
      kind: 'managed',
    }
  }

  // DIY markers and unmarked legacy entries both require a real, valid body.
  // The latter must also fingerprint the raw parsed JSON before it can acquire
  // a durable classification.
  const bodyRaw = await readStoredProfileFile(name, 'profile.json', opts)
  const bodyParsed = parseStoredJson(bodyRaw, name, 'profile.json')
  let body: PlatformProfile
  try {
    body = parsePlatformProfile(bodyParsed, `profile "${name}"`)
  } catch (err) {
    // parsePlatformProfile is shared with non-store callers. Re-wrap its two
    // stable failures so global CLI middleware can distinguish a broken local
    // document and retain the actual-name repair CTA.
    if (
      err instanceof UcpError &&
      (err.code === ErrorCodes.SCHEMA_VALIDATION_FAILED ||
        err.code === ErrorCodes.AGENT_PROFILE_VERSION_UNSUPPORTED)
    ) {
      throw storedProfileBodyError(name, err)
    }
    throw err
  }
  // Classify the RAW parsed JSON, not `body`: `parsePlatformProfile` is
  // allowed to fill schema defaults, and a fingerprint of a value the user
  // never wrote is a fingerprint of nothing.
  const { kind, needsMarker } = classifyStoredProfile(bodyParsed, meta)
  const resolvedMeta = await stampProfileMeta(name, meta, kind, needsMarker, opts)
  if (kind === 'managed') return { name, meta: resolvedMeta, kind }
  return { name, body, meta: resolvedMeta, kind }
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
  // Per-file atomic, body BEFORE meta, sequential — not `Promise.all`.
  // `meta.json` is what says how `profile.json` is read (including the
  // format marker), so a crash between the two must leave a stale
  // description of a real body, never a marker describing bytes that were
  // never written.
  await writeFileAtomic(join(dir, 'profile.json'), `${JSON.stringify(input.body, null, 2)}\n`)
  await writeFileAtomic(join(dir, 'meta.json'), `${JSON.stringify(input.meta, null, 2)}\n`)
  // Classify what we just wrote rather than assume: the returned record has
  // to agree with what the next `readUserProfile` will say about the same
  // two files, and only `meta` can carry a marker that overrides the body.
  const { kind } = classifyStoredProfile(input.body, input.meta)
  return { name: input.name, body: input.body, meta: input.meta, kind }
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
