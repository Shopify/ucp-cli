// `ucp profile *` command tree.
//
// Local profile work only: generate/inspect/select profiles. There is no
// upload verb, because ucp-cli never writes to a profile URL. For a DIY
// Profile, `meta.profile_url` is the identity that goes on the wire; if you own
// that URL, you put profile.json there yourself by whatever means you host
// with, and `ucp doctor` is what checks the two agree. Managed renderings come
// from the installed release registry instead.

import { stdin as promptInput, stderr as promptOutput } from 'node:process'
import { createInterface } from 'node:readline/promises'

import { Cli, z } from 'incur'
import { createAdHocProfile, type Profile } from '../core/agent.js'
import { PROFILE_FORMAT_VERSION } from '../core/legacy-profile.js'
import { DEFAULT_CATALOG_URL } from '../core/profile.js'
import {
  type ActiveSession,
  listProfiles,
  type ProfileMeta,
  profileDir,
  profileExists,
  readActive,
  readProfileMeta,
  readUserProfile,
  saveUserProfile,
  type UserProfile,
  writeActive,
} from '../core/profile-store.js'
import {
  LATEST,
  RELEASES,
  release,
  releaseByDefaultAgentProfileUrl,
  SUPPORTED_VERSIONS,
  type Version,
} from '../core/releases.js'
import { acceptsHttpsUrl, parseHttpsUrl } from '../core/url.js'
import { ErrorCodes, UcpError } from '../lib/errors.js'
import { materializeUserProfile } from './session.js'

export interface ProfileCliDependencies {
  listProfiles?: typeof listProfiles
  readUserProfile?: typeof readUserProfile
  readProfileMeta?: typeof readProfileMeta
  saveUserProfile?: typeof saveUserProfile
  profileExists?: typeof profileExists
  readActive?: typeof readActive
  writeActive?: typeof writeActive
  /** Override environment lookup for deterministic tests. Defaults to process.env. */
  env?: Record<string, string | undefined>
  /** Test override for prompt eligibility. Default derives from TTY + c.agent. */
  canPrompt?: boolean
  /** Test/user-interface injection. Default uses readline on stderr. */
  promptInit?: (defaults: InitPromptDefaults) => Promise<InitPromptResult>
}

const DEFAULT_PROFILE_NAME = 'agent'

interface InitPromptDefaults {
  name: string
}

interface InitPromptResult {
  name?: string
  /** Optional HTTPS URL where the user will publish profile.json. */
  profileUrl?: string
}

// `--version` is validated against the release registry, not a date shape.
// A well-formed date we support no schemas for is exactly as unusable as a
// typo, and the remedy ("pick one of these") is the same, so the message names
// the whole supported set rather than describing a grammar.
function supportedVersionOption() {
  return z.string().refine((v) => (SUPPORTED_VERSIONS as readonly string[]).includes(v), {
    message: `--version must be one of: ${SUPPORTED_VERSIONS.join(', ')}`,
  })
}

function optionalHttpsOption(field: string) {
  return z
    .string()
    .optional()
    .refine((value) => value === undefined || acceptsHttpsUrl(value), {
      message: `${field} must be an HTTPS URL`,
    })
}

function requireHttpsString(value: string, label: string): string {
  return parseHttpsUrl(value, label).toString()
}

function isSet(value: string | undefined): value is string {
  return value !== undefined && value !== ''
}

function selectedProfileName(
  env: Record<string, string | undefined>,
  active: ActiveSession,
): string | undefined {
  if (isSet(env.UCP_PROFILE)) return env.UCP_PROFILE
  return isSet(active.profile) ? active.profile : undefined
}

function initProfileUrl(
  explicit: string | undefined,
  priorMeta: ProfileMeta | undefined,
  selectedReleaseDefault: string,
): string {
  if (explicit !== undefined) return requireHttpsString(explicit, 'profile URL')
  const prior = priorMeta?.profile_url
  if (prior !== undefined && releaseByDefaultAgentProfileUrl(prior) === undefined) return prior
  return selectedReleaseDefault
}

const PROFILE_OVERRIDE_KEYS = ['UCP_PROFILE', 'UCP_AGENT_PROFILE_URL'] as const

type ProfileOverrideKey = (typeof PROFILE_OVERRIDE_KEYS)[number]

type ProfileUseTarget = { kind: 'managed' } | { kind: 'local'; name: string }

function profileOverrides(
  env: Record<string, string | undefined>,
  target: ProfileUseTarget,
): ProfileOverrideKey[] {
  return PROFILE_OVERRIDE_KEYS.filter((key) => {
    const value = env[key]
    if (!isSet(value)) return false
    // UCP_PROFILE still has higher precedence, but when it selects the same
    // name it does not make the newly persisted selection ineffective.
    if (key === 'UCP_PROFILE' && target.kind === 'local') return value !== target.name
    return true
  })
}

function joinOverrideKeys(keys: readonly ProfileOverrideKey[]): string {
  return keys.length === 2 ? `${keys[0]} and ${keys[1]}` : (keys[0] ?? '')
}

function useResultWithOverrideWarning<T extends object>(
  result: T,
  target: ProfileUseTarget,
  env: Record<string, string | undefined>,
) {
  const overriddenBy = profileOverrides(env, target)
  if (overriddenBy.length === 0) return result

  const setKeys = joinOverrideKeys(overriddenBy)
  let message: string
  if (target.kind === 'managed') {
    message = `active.yaml now selects the Shopify managed Profile, but it is not effective while ${setKeys} ${overriddenBy.length === 1 ? 'is' : 'are'} set; unset ${overriddenBy.length === 1 ? 'that environment variable' : 'those environment variables'} to use it`
  } else if (
    overriddenBy.includes('UCP_PROFILE') &&
    overriddenBy.includes('UCP_AGENT_PROFILE_URL')
  ) {
    message = `active.yaml now selects local Profile "${target.name}", but UCP_PROFILE selects the effective name and UCP_AGENT_PROFILE_URL overrides its stored identity rendering; unset both environment variables to use this selection and its stored descriptor`
  } else if (overriddenBy.includes('UCP_PROFILE')) {
    message = `active.yaml now selects local Profile "${target.name}", but UCP_PROFILE takes precedence; unset it to use this selection.`
  } else {
    message = `active.yaml now selects local Profile "${target.name}", but its stored identity rendering is overridden by UCP_AGENT_PROFILE_URL; unset that environment variable to use the stored descriptor`
  }
  return { ...result, overridden_by: overriddenBy, message }
}

const MANAGED_PROFILE_LABEL = 'Shopify managed'

interface ProfileRenderingDescriptor {
  version: Version
  profile_url: string
}

const PROFILE_URL_OVERRIDE_PROVENANCE = ['UCP_AGENT_PROFILE_URL'] as const

function activeProfileUrlOverride(env: Record<string, string | undefined>): string | undefined {
  return isSet(env.UCP_AGENT_PROFILE_URL)
    ? requireHttpsString(env.UCP_AGENT_PROFILE_URL, 'profile URL')
    : undefined
}

function managedRenderings(): ProfileRenderingDescriptor[] {
  return SUPPORTED_VERSIONS.map((version) => ({
    version,
    profile_url: requireHttpsString(RELEASES[version].defaultAgentProfileUrl, 'profile URL'),
  }))
}

function managedOverrideRendering(profileUrl: string): ProfileRenderingDescriptor {
  // Use the same live factory as session resolution. Besides keeping the
  // known-URL/LATEST choice in one place, this emits the required warning when
  // an unknown scalar URL makes ucp-cli plan against the bundled LATEST body.
  const runtime = createAdHocProfile(profileUrl)
  const rendering = Object.values(runtime.renderings)[0]
  if (rendering === undefined) throw new Error('ad-hoc Profile has no rendering')
  return { version: rendering.version, profile_url: rendering.url }
}

function runtimeRenderings(profile: Profile): ProfileRenderingDescriptor[] {
  return SUPPORTED_VERSIONS.flatMap((version) => {
    const rendering = profile.renderings[version]
    return rendering === undefined ? [] : [{ version, profile_url: rendering.url }]
  })
}

// Stored inspection deliberately has its own projection: `profile show <name>`
// must expose an invalid DIY body so the user can repair it, not materialize it.
function renderingsFor(
  profile: UserProfile,
  profileUrlOverride?: string,
): ProfileRenderingDescriptor[] {
  if (profile.kind === 'managed') {
    if (profileUrlOverride === undefined) return managedRenderings()
    return [managedOverrideRendering(profileUrlOverride)]
  }

  const rel = release(profile.body.ucp.version)
  if (rel === undefined) {
    throw new Error(
      `profile "${profile.name}" declares unsupported UCP ${profile.body.ucp.version}`,
    )
  }
  return [
    {
      version: rel.version,
      profile_url: requireHttpsString(
        profileUrlOverride ?? profile.meta.profile_url ?? rel.defaultAgentProfileUrl,
        'profile URL',
      ),
    },
  ]
}

function virtualManagedDescriptor(active: boolean, profileUrlOverride?: string) {
  return {
    kind: 'managed' as const,
    label: MANAGED_PROFILE_LABEL,
    active,
    renderings:
      profileUrlOverride === undefined
        ? managedRenderings()
        : [managedOverrideRendering(profileUrlOverride)],
    ...(profileUrlOverride !== undefined ? { overridden_by: PROFILE_URL_OVERRIDE_PROVENANCE } : {}),
  }
}

function localProfileSummary(
  profile: UserProfile,
  active: boolean,
  profileUrlOverride?: string,
  runtimeProfile?: Profile,
) {
  return {
    name: profile.name,
    kind: profile.kind,
    active,
    renderings:
      runtimeProfile === undefined
        ? renderingsFor(profile, profileUrlOverride)
        : runtimeRenderings(runtimeProfile),
    ...(profileUrlOverride !== undefined ? { overridden_by: PROFILE_URL_OVERRIDE_PROVENANCE } : {}),
  }
}

function localProfileDescriptor(
  profile: UserProfile,
  active: boolean,
  profileUrlOverride?: string,
) {
  const summary = localProfileSummary(profile, active, profileUrlOverride)
  if (profile.kind === 'managed') return { ...summary, meta: profile.meta }
  return { ...summary, body: profile.body, meta: profile.meta }
}

// Belt-and-braces for `--version`: the option schema rejects unsupported
// values, so this is the structured form of a condition that should be
// unreachable. Kept because the alternative is a cast, and because a future
// caller that bypasses the schema (library use, a new command) should get the
// supported set rather than a crash.
function unsupportedVersionError(version: string): {
  code: string
  message: string
  cta: { description: string; commands: Array<{ command: string; description: string }> }
} {
  return {
    code: ErrorCodes.INVALID_INPUT,
    message: `UCP ${version} is not supported; ucp-cli supports ${SUPPORTED_VERSIONS.join(', ')}`,
    cta: {
      description: `Pick a supported release, or upgrade ucp-cli if you need a newer one.`,
      commands: SUPPORTED_VERSIONS.map((v) => ({
        command: `ucp profile init --name ${DEFAULT_PROFILE_NAME} --version ${v}`,
        description: `create a DIY Profile pinned to UCP ${v}`,
      })),
    },
  }
}

function profileInitRequiresNameError(): {
  code: string
  message: string
  cta: {
    description: string
    commands: Array<{ command: string; description: string }>
  }
} {
  return {
    code: ErrorCodes.PROFILE_INIT_REQUIRES_NAME,
    message:
      'profile init creates a custom or release-pinned DIY Profile and needs --name in non-interactive mode; normal users do not need to initialize a Profile',
    cta: {
      description:
        "Shopify's managed Profile is used by default. Run profile init only for a custom or release-pinned DIY Profile; omit --profile-url to pin the selected release at its published URL.",
      commands: [
        {
          command: `ucp profile init --name ${DEFAULT_PROFILE_NAME}`,
          description: "create a DIY Profile pinned to the release's published profile URL",
        },
        {
          command: `ucp profile init --name ${DEFAULT_PROFILE_NAME} --profile-url https://example.com/.well-known/ucp`,
          description: 'create a DIY Profile for an HTTPS URL you own',
        },
      ],
    },
  }
}

async function promptForInit(defaults: InitPromptDefaults): Promise<InitPromptResult> {
  promptOutput.write(
    'Create a DIY Profile pinned to one UCP release. Normal use relies on the Shopify managed Profile and does not require initialization.\n\n',
  )
  promptOutput.write(
    'Use a DIY Profile when you need a custom capability document or want to stay pinned to a specific release.\n\n',
  )

  const rl = createInterface({ input: promptInput, output: promptOutput })
  try {
    const rawName = await rl.question(`DIY Profile name [${defaults.name}]: `)
    const rawProfileUrl = await rl.question(
      "Profile URL (optional HTTPS; leave blank to pin the release's published profile): ",
    )
    const trimmedProfileUrl = rawProfileUrl.trim()
    return {
      name: rawName.trim() || defaults.name,
      ...(trimmedProfileUrl !== '' ? { profileUrl: trimmedProfileUrl } : {}),
    }
  } finally {
    rl.close()
  }
}

export function buildProfileCli(deps: ProfileCliDependencies = {}) {
  const list = deps.listProfiles ?? listProfiles
  const read = deps.readUserProfile ?? readUserProfile
  const readMeta = deps.readProfileMeta ?? readProfileMeta
  const save = deps.saveUserProfile ?? saveUserProfile
  const exists = deps.profileExists ?? profileExists
  const readAct = deps.readActive ?? readActive
  const writeAct = deps.writeActive ?? writeActive
  const prompt = deps.promptInit ?? promptForInit
  const env = deps.env ?? process.env

  // Every command here carries `mcp: false`: profile management is local CLI
  // state, not a commerce operation, and one MCP stdio server serves many
  // unrelated agent conversations — none of them may repoint the operator's
  // active profile out from under the others. Any command added below needs
  // the same annotation, or it silently becomes an agent-callable tool.
  return Cli.create('profile', { description: 'Inspect and manage UCP Profiles' })
    .command('list', {
      description: 'List the Shopify managed Profile and local Profiles (active is marked)',
      mcp: false,
      args: z.object({}),
      options: z.object({}),
      async run() {
        const [names, active] = await Promise.all([list(), readAct()])
        const selected = selectedProfileName(env, active)
        const profileUrlOverride = activeProfileUrlOverride(env)
        const localProfiles = await Promise.all(
          names.map(async (name) => {
            try {
              const isActive = name === selected
              const stored = isActive ? await read(name) : await read(name, { migrate: false })
              const effectiveUrlOverride = isActive ? profileUrlOverride : undefined
              const runtime = isActive
                ? materializeUserProfile(stored, effectiveUrlOverride)
                : undefined
              return localProfileSummary(stored, isActive, effectiveUrlOverride, runtime)
            } catch {
              return { name, kind: 'invalid' as const, active: name === selected }
            }
          }),
        )
        return {
          profiles: [
            virtualManagedDescriptor(
              selected === undefined,
              selected === undefined ? profileUrlOverride : undefined,
            ),
            ...localProfiles,
          ],
        }
      },
    })
    .command('show', {
      description: 'Display a Profile (defaults to the active Profile)',
      mcp: false,
      args: z.object({ name: z.string().optional().describe('Local Profile name.') }),
      options: z.object({}),
      async run(c) {
        const active = await readAct()
        const selected = selectedProfileName(env, active)
        const name = c.args.name ?? selected
        // The selected Profile is shown with its effective URL override, even
        // when named explicitly. A foreign positional name remains a stored
        // inspection so it can be repaired without active env precedence.
        const profileUrlOverride = name === selected ? activeProfileUrlOverride(env) : undefined
        if (name === undefined) return virtualManagedDescriptor(true, profileUrlOverride)
        return localProfileDescriptor(await read(name), name === selected, profileUrlOverride)
      },
    })
    .command('init', {
      description: 'Create a DIY Profile pinned to one UCP release',
      mcp: false,
      args: z.object({}),
      options: z.object({
        name: z.string().optional().describe('Profile name (filesystem-safe identifier).'),
        profileUrl: optionalHttpsOption('--profile-url').describe(
          'Public HTTPS URL where businesses read profile.json. Use a URL you own to advertise a custom capability set; whoever controls the URL controls what this agent claims (there is no signing). With --force, omitting this preserves a custom URL from readable metadata, while missing/unreadable metadata or a Shopify release-default URL uses the selected --version default.',
        ),
        version: supportedVersionOption()
          .default(LATEST)
          .describe(
            `UCP release to pin (${SUPPORTED_VERSIONS.join(', ')}; default ${LATEST}). Writes that release's profile.json snapshot. On --force without --profile-url, a custom URL from readable metadata is preserved and a Shopify release-default URL rotates to this release's default.`,
          ),
        activate: z
          .boolean()
          .default(false)
          .describe(
            'Activate the target DIY Profile, including an existing Profile left unchanged without --force. Without this flag, the current selection stays active (Shopify managed on a fresh install).',
          ),
        force: z
          .boolean()
          .default(false)
          .describe(
            'Re-create an existing Profile in place, preserving readable metadata and any custom profile_url it contains; a Shopify release-default URL rotates to --version. If meta.json is unreadable, pass --profile-url to retain a custom URL.',
          ),
        catalog: optionalHttpsOption('--catalog').describe(
          `Catalog business URL recorded as meta.defaults.catalog (discovery hits <url>/.well-known/ucp). If omitted, session resolution falls through to UCP_DEFAULT_CATALOG, then the baked-in default '${DEFAULT_CATALOG_URL}'.`,
        ),
      }),
      async run(c) {
        const canPrompt =
          deps.canPrompt ??
          (process.stdin.isTTY === true && process.stderr.isTTY === true && c.agent !== true)
        let name = c.options.name
        let profileUrl = c.options.profileUrl

        if (name === undefined && canPrompt) {
          const prompted = await prompt({ name: DEFAULT_PROFILE_NAME })
          name = prompted.name ?? name
          profileUrl = prompted.profileUrl ?? profileUrl
        }

        if (name === undefined) return c.error(profileInitRequiresNameError())

        const alreadyExists = await exists(name)
        if (!c.options.force && alreadyExists) {
          // Without --force, init never re-creates the Profile. Explicit
          // activation still validates it (which may stamp a legacy kind
          // marker) before writing active.yaml; without --activate this is a
          // total no-op.
          if (c.options.activate) {
            const target = await read(name)
            materializeUserProfile(target)
            const prev = await readAct()
            await writeAct({ ...prev, profile: name })
            return useResultWithOverrideWarning(
              {
                name,
                created: false,
                activated: true,
                message: 'profile already exists; activated without re-creating it',
              },
              { kind: 'local', name },
              env,
            )
          }
          return {
            name,
            created: false,
            activated: false,
            message: 'profile already exists; no changes made',
          }
        }

        let priorMeta: ProfileMeta | undefined
        if (c.options.force && alreadyExists) {
          try {
            priorMeta = (await read(name)).meta
          } catch {
            // A broken profile.json must not cost an otherwise valid custom
            // URL/defaults block. Salvage meta.json independently; if metadata
            // is also unreadable, --force intentionally rebuilds it fresh.
            try {
              priorMeta = await readMeta(name)
            } catch {
              // Repairing both files is exactly what --force is for.
            }
          }
        }

        // `release()` rather than an index + cast: the option schema already
        // rejects anything outside the window, so this is the same lookup
        // stated once instead of an assertion the reader has to trust.
        const rel = release(c.options.version)
        if (rel === undefined) return c.error(unsupportedVersionError(c.options.version))

        const now = new Date().toISOString()
        // profile.json starts as the verbatim document the release's default
        // URL serves. Cloned, not shared: the user is expected to edit this
        // file, and handing out the registry's singleton would let one edit
        // leak into every later init in the same process. The CLI negotiates
        // from this file; the profile URL must serve the same document for the
        // business to see the same declaration.
        const body = structuredClone(rel.agentProfileTemplate)
        const defaults =
          c.options.catalog === undefined
            ? priorMeta?.defaults
            : { ...(priorMeta?.defaults ?? {}), catalog: c.options.catalog }
        const meta: ProfileMeta = {
          ...(priorMeta ?? {}),
          created_at: priorMeta?.created_at ?? now,
          updated_at: now,
          ...(defaults !== undefined ? { defaults } : {}),
          // The CLI reads `ucp.version` from profile.json; the business reads
          // it from this URL. Preserve an owned/custom URL across repair, but
          // rotate a Shopify release URL with the body so version and URL do
          // not silently diverge. An explicit --profile-url always wins.
          profile_url: initProfileUrl(profileUrl, priorMeta, rel.defaultAgentProfileUrl),
          // A current template body is also the managed rendering body. The
          // explicit marker is what makes init's pinned DIY intent durable
          // instead of eligible for legacy auto-classification on next read.
          format_version: PROFILE_FORMAT_VERSION,
          kind: 'diy',
        }

        const profile = await save({ name, body, meta, overwrite: c.options.force })

        if (c.options.activate) {
          const prev = await readAct()
          await writeAct({ ...prev, profile: name })
        }
        // Terse envelope: omit `body` (the full ~5KB profile JSON) and
        // `meta` (signing keys, capabilities, etc.) which are agent
        // context noise on every init. Callers that want the full body
        // can run `ucp profile show <name>` or read profile.json directly
        // at the path returned here.
        const result = {
          name: profile.name,
          created: true,
          activated: c.options.activate,
          path: profileDir(profile.name),
          // `version` echoes the `ucp.version` written to profile.json;
          // `profile_url` names the copy businesses read.
          version: c.options.version,
          ...(profile.meta.profile_url !== undefined
            ? { profile_url: profile.meta.profile_url }
            : {}),
        }
        return c.options.activate
          ? useResultWithOverrideWarning(result, { kind: 'local', name }, env)
          : result
      },
    })
    .command('use', {
      description: 'Switch to a local Profile, or return to Shopify managed with --managed',
      mcp: false,
      args: z.object({ name: z.string().optional().describe('Local Profile name.') }),
      options: z.object({
        managed: z
          .boolean()
          .default(false)
          .describe('Use the virtual Shopify managed Profile instead of a local Profile.'),
      }),
      async run(c) {
        const name = c.args.name
        if (c.options.managed && name !== undefined) {
          return c.error({
            code: ErrorCodes.INVALID_INPUT,
            message: 'profile use accepts either a local Profile name or --managed, not both',
          })
        }

        if (c.options.managed) {
          const prev = await readAct()
          const { profile: previous, ...remaining } = prev
          await writeAct(remaining)
          return useResultWithOverrideWarning(
            { profile: null, previous: previous ?? null },
            { kind: 'managed' },
            env,
          )
        }

        if (name === undefined) {
          return c.error({
            code: ErrorCodes.INVALID_INPUT,
            message: 'profile use needs a local Profile name or --managed',
          })
        }
        if (!(await exists(name))) {
          throw new UcpError({
            layer: 'client',
            code: ErrorCodes.PROFILE_NOT_FOUND,
            message: `profile "${name}" does not exist`,
          })
        }

        // Reading validates storage and performs the one-time legacy kind
        // migration; materialization then applies the complete runtime
        // validator before active.yaml can point at the target.
        const target = await read(name)
        materializeUserProfile(target)
        const prev = await readAct()
        await writeAct({ ...prev, profile: name })
        return useResultWithOverrideWarning(
          { profile: name, previous: prev.profile ?? null },
          { kind: 'local', name },
          env,
        )
      },
    })
}
