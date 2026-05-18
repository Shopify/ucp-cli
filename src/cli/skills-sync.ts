// Custom replacement for incur's built-in `ucp skills add` that suppresses
// auto-generated per-command sub-skills and ships only:
//   1. The curated top-level `ucp` skill (skills/ucp/SKILL.md)
//   2. Any other skill backed by a hand-written skills/<name>/SKILL.md
//
// Why this exists: incur 0.4.5 always emits a per-command-group SKILL.md
// derived from zod schemas. For our CLI those are ~70% boilerplate (inherited
// root options like --input/--set/--business repeated per subcommand) and
// stale on every flag rename. We want one comprehensive curated skill, plus
// optional per-domain skills that we author by hand. There is no incur
// config knob to disable auto-generation today (verified against incur
// source as of @incur 0.4.5), so we wrap the built-in at the bin entrypoint
// and prune what we don't want.
//
// When incur ships a `sync.skipGenerated` (or equivalent) option, this
// module + the bin-entry interception go away.

import fs from 'node:fs/promises'
import path from 'node:path'
import { Cli, SyncSkills } from 'incur'

import { findPackageRoot } from '../lib/package-root.js'

/** Hard-coded "always keep" names. Empty for now; reserve for future
 *  incur-emitted scaffolding (e.g. an index file) that we don't author. */
const ALWAYS_KEEP: ReadonlySet<string> = new Set()

export type SyncOptions = {
  /** CLI name (must match `Cli.create('<name>', ...)`). */
  name: string
  /** CLI instance returned by `Cli.create(...)`. Commands map is read via
   *  incur's exported `Cli.toCommands` WeakMap. */
  cli: unknown
  /** CLI description, threaded through to SyncSkills as the top-level group
   *  description. Should match the value passed to `Cli.create`. */
  description: string
  /** Optional one-liners printed under "Try:" after a successful sync. */
  suggestions?: readonly string[]
  /** Trailing argv after `skills add` (e.g. `--depth 2`, `--no-global`). */
  argv: readonly string[]
  /** Stdout writer. Defaults to `process.stdout.write`. Test seam. */
  stdout?: (s: string) => void
  /** Override `packageRoot()` resolution for the include glob and SyncSkills
   *  cwd. Tests pass a tmpdir; production omits. */
  cwd?: string
}

export async function syncSkillsWithCleanup(opts: SyncOptions): Promise<void> {
  const stdout = opts.stdout ?? ((s: string) => void process.stdout.write(s))

  const { depth, global } = parseAddArgs(opts.argv)
  // Mirror incur's own default: global mode resolves cwd from the package
  // root (where bundled SKILL.md files live), --no-global mode honors the
  // shell's process.cwd() (so a CLI author can `ucp skills add --no-global`
  // to install their fork's skills into a sandbox project). Tests override
  // via opts.cwd. Without this split, --no-global would install into the
  // ucp-cli repo itself when invoked from any other directory.
  const cwd = opts.cwd ?? (global === false ? process.cwd() : packageRoot())

  const keep = await readHandWrittenSkillNames(cwd)

  // `Cli.toCommands` is exported but @internal-tagged. Brittle by design;
  // covered by the integration test in test/integration/skills-sync.test.ts.
  const commands = (Cli as unknown as { toCommands: WeakMap<object, unknown> }).toCommands.get(
    opts.cli as object,
  )
  if (commands === undefined) {
    throw new Error('skills-sync: could not resolve commands map from CLI instance')
  }

  stdout('Syncing...')
  const result = await SyncSkills.sync(opts.name, commands as never, {
    cwd,
    depth,
    description: opts.description,
    global,
    include: ['skills/*'],
  })
  stdout('\r\x1b[K')

  // Only delete entries (a) THIS sync produced and (b) we didn't author.
  // Sharing an install root with other incur CLIs is safe — their skills
  // are not in `result.skills` and stay untouched.
  //
  // `result.paths` is one canonical dir per skill (`<base>/.agents/skills/<name>`).
  // `result.agents[].path` is one symlink per (skill, agent) pair (e.g.
  // `~/.claude/skills/<name>`). We match on the trailing path component so a
  // single pass cleans both canonical dirs and agent-side symlinks; whichever
  // we delete first, the other ends up being a plain unlink that still succeeds.
  const removeNames = new Set(
    result.skills.filter((s) => !keep.has(s.name) && !ALWAYS_KEEP.has(s.name)).map((s) => s.name),
  )
  const allPaths = [...result.paths, ...result.agents.map((a) => a.path)]
  for (const p of allPaths) {
    if (removeNames.has(path.basename(p))) {
      await fs.rm(p, { recursive: true, force: true })
    }
  }

  // Copy non-SKILL.md siblings (views/, references/, assets/, ...) from each
  // hand-authored source dir to its canonical install path. incur's
  // SyncSkills.sync only stages SKILL.md content from the include glob into
  // its tmpdir; sibling files/subdirs in the original skill directory get
  // dropped on the floor. Patch around it locally so referenced paths
  // (`references/SETUP.md`, `views/catalog.compact.jmespath`) actually exist
  // post-install. Copying to canonical paths only — agent-side symlinks
  // (result.agents[].path) point at the canonical, so the agent installs
  // see the new content for free.
  await copyHandWrittenSkillSiblings(cwd, keep, result.paths)

  const kept = result.skills.filter((s) => keep.has(s.name) || ALWAYS_KEEP.has(s.name))
  printSummary(kept, opts.suggestions, stdout)
}

async function copyHandWrittenSkillSiblings(
  cwd: string,
  keep: ReadonlySet<string>,
  canonicalInstallPaths: readonly string[],
): Promise<void> {
  // canonicalInstallPaths is one entry per skill, keyed by the trailing
  // path component (which equals the skill's frontmatter name).
  const installPathByName = new Map<string, string>()
  for (const p of canonicalInstallPaths) {
    installPathByName.set(path.basename(p), p)
  }

  const skillsDir = path.join(cwd, 'skills')
  let sourceEntries: import('node:fs').Dirent[]
  try {
    sourceEntries = await fs.readdir(skillsDir, { withFileTypes: true })
  } catch {
    return
  }

  for (const sourceEntry of sourceEntries) {
    if (!sourceEntry.isDirectory()) continue
    const sourceDir = path.join(skillsDir, sourceEntry.name)
    // Resolve frontmatter name to look up the install path; fall back to
    // dir basename matching incur's discoverSkills convention.
    let content: string
    try {
      content = await fs.readFile(path.join(sourceDir, 'SKILL.md'), 'utf8')
    } catch {
      continue
    }
    const match = content.match(/^name:\s*(.+)$/m)
    const skillName = (match?.[1] ?? sourceEntry.name).trim()
    if (!keep.has(skillName)) continue
    const installPath = installPathByName.get(skillName)
    if (installPath === undefined) continue

    const entries = await fs.readdir(sourceDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === 'SKILL.md') continue
      await fs.cp(path.join(sourceDir, entry.name), path.join(installPath, entry.name), {
        recursive: true,
        force: true,
      })
    }
  }
}

function parseAddArgs(argv: readonly string[]): {
  depth: number
  global: boolean | undefined
} {
  // Mirrors the parsing in incur's built-in skills add handler:
  // `--depth N`, `--depth=N`, `--no-global`. Default depth = 1.
  const depthIdx = argv.indexOf('--depth')
  const depthEq = argv.find((t) => t.startsWith('--depth='))
  let depth = 1
  if (depthIdx !== -1) {
    const raw = Number(argv[depthIdx + 1])
    if (Number.isFinite(raw)) depth = raw
  } else if (depthEq) {
    const raw = Number(depthEq.split('=')[1])
    if (Number.isFinite(raw)) depth = raw
  }
  const global = argv.includes('--no-global') ? false : undefined
  return { depth, global }
}

async function readHandWrittenSkillNames(cwd: string): Promise<Set<string>> {
  // Authoritative source for "what skills did we hand-write": the frontmatter
  // `name:` field of each skills/<dir>/SKILL.md. That's the same value incur
  // uses for the install directory name (see incur agents.ts/discoverSkills),
  // so the keep-set is in the same namespace as result.skills[].name.
  const keep = new Set<string>()
  const skillsDir = path.join(cwd, 'skills')
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(skillsDir, { withFileTypes: true })
  } catch {
    return keep
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillFile = path.join(skillsDir, entry.name, 'SKILL.md')
    try {
      const content = await fs.readFile(skillFile, 'utf8')
      const match = content.match(/^name:\s*(.+)$/m)
      keep.add((match?.[1] ?? entry.name).trim())
    } catch {
      // missing/unreadable SKILL.md — skip; incur won't ship it anyway
    }
  }
  return keep
}

function packageRoot(): string {
  return findPackageRoot(import.meta.url)
}

function printSummary(
  skills: readonly { name: string; description?: string | undefined }[],
  suggestions: readonly string[] | undefined,
  stdout: (s: string) => void,
): void {
  if (skills.length === 0) {
    stdout('No skills synced (no hand-written SKILL.md found under skills/*/SKILL.md).\n')
    return
  }
  const maxLen = Math.max(...skills.map((s) => s.name.length))
  const lines: string[] = []
  for (const s of skills) {
    const padding = s.description ? `${' '.repeat(maxLen - s.name.length)}  ${s.description}` : ''
    lines.push(`  ✓ ${s.name}${padding}`)
  }
  lines.push('')
  lines.push(`${skills.length} skill${skills.length === 1 ? '' : 's'} synced`)
  if (suggestions && suggestions.length > 0) {
    lines.push('')
    lines.push('Try:')
    for (const s of suggestions) lines.push(`  ${s}`)
  }
  stdout(`${lines.join('\n')}\n`)
}
