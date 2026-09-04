// `ucp profile *` command tree.
//
// Local profile work only: generate/inspect/select profiles. There is no
// upload verb, because ucp-cli never writes to a profile URL. `meta.profile_url`
// is the identity that goes on the wire; if you own that URL, you put
// profile.json there yourself by whatever means you host with, and `ucp doctor`
// is what checks the two agree.

import { stdin as promptInput, stderr as promptOutput } from 'node:process'
import { createInterface } from 'node:readline/promises'

import { Cli, z } from 'incur'
import { DEFAULT_CATALOG_URL } from '../core/profile.js'
import {
  listProfiles,
  type ProfileMeta,
  profileDir,
  profileExists,
  readActive,
  readUserProfile,
  saveUserProfile,
  writeActive,
} from '../core/profile-store.js'
import { LATEST, release, SUPPORTED_VERSIONS } from '../core/releases.js'
import { acceptsHttpsUrl, parseHttpsUrl } from '../core/url.js'
import { ErrorCodes, UcpError } from '../lib/errors.js'

export interface ProfileCliDependencies {
  listProfiles?: typeof listProfiles
  readUserProfile?: typeof readUserProfile
  saveUserProfile?: typeof saveUserProfile
  profileExists?: typeof profileExists
  readActive?: typeof readActive
  writeActive?: typeof writeActive
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
  /** Optional HTTPS URL means the user will host profile.json themselves. */
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
        description: `create a UCP ${v} profile`,
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
    message: 'profile init needs a profile name in non-interactive mode',
    cta: {
      description:
        'Pass a profile name. Omit --profile-url to present the stock published profile for the release; pass --profile-url when you host profile.json yourself.',
      commands: [
        {
          command: `ucp profile init --name ${DEFAULT_PROFILE_NAME}`,
          description: "create a local profile on the platform's published profile URL",
        },
        {
          command: `ucp profile init --name ${DEFAULT_PROFILE_NAME} --profile-url https://example.com/.well-known/ucp`,
          description: 'create a local profile for a self-hosted HTTPS URL',
        },
      ],
    },
  }
}

async function promptForInit(defaults: InitPromptDefaults): Promise<InitPromptResult> {
  promptOutput.write('No UCP profile found.\n\n')
  promptOutput.write(
    'A UCP profile is a public JSON document businesses fetch to identify this agent and discover supported capabilities.\n\n',
  )
  promptOutput.write(
    'To use an existing profile, place profile.json and meta.json under ~/.ucp/profiles/<name>/, then run `ucp profile use <name>`.\n\n',
  )

  const rl = createInterface({ input: promptInput, output: promptOutput })
  try {
    const rawName = await rl.question(`Profile name [${defaults.name}]: `)
    const rawProfileUrl = await rl.question(
      "Profile URL (optional HTTPS; leave blank to use the platform's published profile): ",
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
  const save = deps.saveUserProfile ?? saveUserProfile
  const exists = deps.profileExists ?? profileExists
  const readAct = deps.readActive ?? readActive
  const writeAct = deps.writeActive ?? writeActive
  const prompt = deps.promptInit ?? promptForInit

  return Cli.create('profile', { description: 'Profile management' })
    .command('list', {
      description: 'List configured profiles (active is marked)',
      args: z.object({}),
      options: z.object({}),
      async run() {
        const [profiles, active] = await Promise.all([list(), readAct()])
        return {
          active: active.profile ?? null,
          profiles: profiles.map((name) => ({
            name,
            active: name === active.profile,
          })),
        }
      },
    })
    .command('show', {
      description: 'Display a profile (defaults to active)',
      args: z.object({ name: z.string().optional() }),
      options: z.object({}),
      async run(c) {
        const name = c.args.name ?? (await readAct()).profile
        if (name === undefined) {
          return c.error({
            code: ErrorCodes.PROFILE_NOT_FOUND,
            message: 'no local profile selected',
            cta: {
              description: 'Create a local profile first, then run show again.',
              commands: [
                {
                  command: `ucp profile init --name ${DEFAULT_PROFILE_NAME}`,
                  description: 'create and activate a local profile',
                },
              ],
            },
          })
        }
        return read(name)
      },
    })
    .command('init', {
      description: 'Create a local profile',
      args: z.object({}),
      options: z.object({
        name: z.string().optional().describe('Profile name (filesystem-safe identifier).'),
        profileUrl: optionalHttpsOption('--profile-url').describe(
          'Public HTTPS URL if you will host profile.json yourself. THE ONLY WAY to advertise a custom capability set: the URL is the identity both sides read, so whoever controls it controls what this agent claims (there is no signing). Omit to present the stock published profile for --version.',
        ),
        version: supportedVersionOption()
          .default(LATEST)
          .describe(
            `UCP release this profile speaks (${SUPPORTED_VERSIONS.join(', ')}; default ${LATEST}). This is the whole of version selection: it picks meta.profile_url, and negotiation runs against whatever that URL serves. On the default path the identity is "a stock <version> agent" — self-host with --profile-url to change it.`,
          ),
        activate: z
          .boolean()
          .default(false)
          .describe(
            'Mark the new profile as active in active.yaml. The first profile is activated automatically.',
          ),
        force: z.boolean().default(false).describe('Re-create an existing profile in place.'),
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

        if (!c.options.force && (await exists(name))) {
          // Idempotent no-op so agents can safely run `profile init` at the
          // start of a session without flooding output or mutating state.
          // Return shape mirrors the create case (`name` + `activated`) so a
          // caller doesn't need to branch on `created` to read either.
          return {
            name,
            created: false,
            activated: false,
            message: 'profile already exists; no changes made',
          }
        }

        let priorCreatedAt: string | undefined
        if (c.options.force && (await exists(name))) {
          try {
            const prior = await read(name)
            priorCreatedAt = prior.meta.created_at
          } catch {
            // Corrupt prior meta — fall back to a fresh timestamp rather
            // than refuse the re-init, which is exactly what --force is for.
          }
        }

        // `release()` rather than an index + cast: the option schema already
        // rejects anything outside the window, so this is the same lookup
        // stated once instead of an assertion the reader has to trust.
        const rel = release(c.options.version)
        if (rel === undefined) return c.error(unsupportedVersionError(c.options.version))

        const profilesBefore = await list()
        const now = new Date().toISOString()
        // profile.json is the verbatim document `rel.defaultAgentProfileUrl`
        // serves. Cloned, not shared: the user is expected to edit this file,
        // and handing out the registry's singleton would let one edit leak
        // into every later init in the same process. On the default path the
        // file is decorative — the CLI negotiates from its bundled snapshot of
        // that URL — so pointing --profile-url at a URL you own, and uploading
        // this file there, is what makes an edit take effect on either side.
        const body = structuredClone(rel.agentProfileTemplate)
        const meta: ProfileMeta = {
          created_at: priorCreatedAt ?? now,
          updated_at: now,
          ...(c.options.catalog !== undefined ? { defaults: { catalog: c.options.catalog } } : {}),
          // Version selection is ENTIRELY this URL choice; no version is
          // persisted as a scalar. The business GETs this URL and reads
          // `ucp.version` off what it serves; the CLI reads the same version
          // locally — from its bundled snapshot of a release default, or from
          // this profile's own profile.json when the URL is yours.
          profile_url:
            profileUrl !== undefined
              ? requireHttpsString(profileUrl, 'profile URL')
              : rel.defaultAgentProfileUrl,
        }

        const profile = await save({ name, body, meta, overwrite: c.options.force })

        const shouldActivate = c.options.activate || profilesBefore.length === 0
        if (shouldActivate) {
          const prev = await readAct()
          await writeAct({ ...prev, profile: name })
        }
        // Terse envelope: omit `body` (the full ~5KB profile JSON) and
        // `meta` (signing keys, capabilities, etc.) which are agent
        // context noise on every init. Callers that want the full body
        // can run `ucp profile show <name>` or read profile.json directly
        // at the path returned here.
        return {
          name: profile.name,
          created: true,
          activated: shouldActivate,
          path: profileDir(profile.name),
          // `version` echoes what was written, but `profile_url` is the field
          // that DECIDES it — the CLI and the business both read the version
          // off whatever that URL serves.
          version: c.options.version,
          ...(profile.meta.profile_url !== undefined
            ? { profile_url: profile.meta.profile_url }
            : {}),
        }
      },
    })
    .command('use', {
      description: 'Switch the active profile',
      args: z.object({ name: z.string() }),
      options: z.object({}),
      async run(c) {
        if (!(await exists(c.args.name))) {
          throw new UcpError({
            layer: 'client',
            code: ErrorCodes.PROFILE_NOT_FOUND,
            message: `profile "${c.args.name}" does not exist`,
          })
        }
        const prev = await readAct()
        await writeAct({ ...prev, profile: c.args.name })
        return { profile: c.args.name, previous: prev.profile ?? null }
      },
    })
}
