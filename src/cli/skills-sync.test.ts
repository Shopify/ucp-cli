// Exercises the real `syncSkillsWithCleanup` against a real (but minimal)
// incur CLI in a tmpdir, with --no-global so install lands inside the
// sandbox. Verifies:
//   * Hand-written skills/<name>/SKILL.md files survive the sync.
//   * Auto-generated per-command skills are pruned.
//   * Other CLIs' skills sharing the install root are NOT touched (pre-seed
//     a sentinel skill dir; assert it survives).
//   * Output summary lists only kept skills.

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Cli, z } from 'incur'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { syncSkillsWithCleanup } from './skills-sync.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ucp-skills-sync-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function writeHandWrittenSkill(slug: string, name: string, body = 'body'): Promise<void> {
  const dir = path.join(tmpDir, 'skills', slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n\n${body}\n`)
}

function buildTestCli() {
  // Mimic ucp shape: a few subcommand groups so incur generates per-group
  // skill files we can verify get pruned.
  return Cli.create('ucp', { description: 'test' })
    .command('cart', {
      description: 'cart ops',
      args: z.object({}),
      async run(c) {
        return c.ok({})
      },
    })
    .command('checkout', {
      description: 'checkout ops',
      args: z.object({}),
      async run(c) {
        return c.ok({})
      },
    })
    .command('order', {
      description: 'order ops',
      args: z.object({}),
      async run(c) {
        return c.ok({})
      },
    })
}

async function readInstalledSkills(): Promise<string[]> {
  const installRoot = path.join(tmpDir, '.agents', 'skills')
  try {
    return (await fs.readdir(installRoot)).sort()
  } catch {
    return []
  }
}

describe('syncSkillsWithCleanup', () => {
  it('keeps hand-written skills and prunes auto-generated ones', async () => {
    await writeHandWrittenSkill('ucp', 'ucp', 'top-level skill body')

    let captured = ''
    await syncSkillsWithCleanup({
      name: 'ucp',
      cli: buildTestCli(),
      description: 'test',
      argv: ['--no-global'],
      cwd: tmpDir,
      stdout: (s) => {
        captured += s
      },
    })

    const installed = await readInstalledSkills()
    expect(installed).toEqual(['ucp'])

    // The hand-written body wins, not the auto-gen one.
    const installedBody = await fs.readFile(
      path.join(tmpDir, '.agents', 'skills', 'ucp', 'SKILL.md'),
      'utf8',
    )
    expect(installedBody).toContain('top-level skill body')

    // Summary lists only kept skills.
    expect(captured).toContain('✓ ucp')
    expect(captured).toContain('1 skill synced')
    expect(captured).not.toContain('ucp-cart')
  })

  it('preserves additional hand-written sub-skills (e.g. ucp-checkout) past cleanup', async () => {
    await writeHandWrittenSkill('ucp', 'ucp', 'top body')
    await writeHandWrittenSkill('ucp-checkout', 'ucp-checkout', 'checkout journey body')

    await syncSkillsWithCleanup({
      name: 'ucp',
      cli: buildTestCli(),
      description: 'test',
      argv: ['--no-global'],
      cwd: tmpDir,
      stdout: () => {},
    })

    const installed = await readInstalledSkills()
    expect(installed).toEqual(['ucp', 'ucp-checkout'])

    const checkoutBody = await fs.readFile(
      path.join(tmpDir, '.agents', 'skills', 'ucp-checkout', 'SKILL.md'),
      'utf8',
    )
    expect(checkoutBody).toContain('checkout journey body')
  })

  it('does not delete unrelated skills that this sync did not produce', async () => {
    // Pre-seed a skill from some "other CLI" sharing the install root.
    const otherSkillDir = path.join(tmpDir, '.agents', 'skills', 'other-cli')
    await fs.mkdir(otherSkillDir, { recursive: true })
    await fs.writeFile(path.join(otherSkillDir, 'SKILL.md'), '---\nname: other-cli\n---\n\nbody')

    await writeHandWrittenSkill('ucp', 'ucp')

    await syncSkillsWithCleanup({
      name: 'ucp',
      cli: buildTestCli(),
      description: 'test',
      argv: ['--no-global'],
      cwd: tmpDir,
      stdout: () => {},
    })

    const installed = await readInstalledSkills()
    expect(installed).toContain('other-cli')
    expect(installed).toContain('ucp')
    // Sanity: auto-gen still gone
    expect(installed).not.toContain('cart')
    expect(installed).not.toContain('ucp-cart')
  })

  it('emits a helpful summary when no hand-written skills exist', async () => {
    // Note: no writeHandWrittenSkill calls — skills/ dir doesn't exist.
    let captured = ''
    await syncSkillsWithCleanup({
      name: 'ucp',
      cli: buildTestCli(),
      description: 'test',
      argv: ['--no-global'],
      cwd: tmpDir,
      stdout: (s) => {
        captured += s
      },
    })

    expect(captured).toContain('No skills synced')
    const installed = await readInstalledSkills()
    expect(installed).toEqual([])
  })

  // Sibling content (views/, references/, assets/) lives next to SKILL.md in
  // the source skill directory but incur's SyncSkills.sync only stages the
  // SKILL.md content. Our wrapper backfills the missing copies so referenced
  // paths actually resolve post-install.
  it('copies non-SKILL.md siblings (views/, references/, assets/) to install paths', async () => {
    await writeHandWrittenSkill('ucp', 'ucp', 'body')
    // Simulate the real bundled layout.
    const sourceSkillDir = path.join(tmpDir, 'skills', 'ucp')
    await fs.mkdir(path.join(sourceSkillDir, 'views'), { recursive: true })
    await fs.writeFile(
      path.join(sourceSkillDir, 'views', 'compact.jmespath'),
      'products[*].title\n',
    )
    await fs.mkdir(path.join(sourceSkillDir, 'references'), { recursive: true })
    await fs.writeFile(path.join(sourceSkillDir, 'references', 'SETUP.md'), '# Setup\n')
    await fs.writeFile(path.join(sourceSkillDir, 'references', 'REFERENCE.md'), '# Reference\n')

    await syncSkillsWithCleanup({
      name: 'ucp',
      cli: buildTestCli(),
      description: 'test',
      argv: ['--no-global'],
      cwd: tmpDir,
      stdout: () => {},
    })

    const installRoot = path.join(tmpDir, '.agents', 'skills', 'ucp')
    expect(await fs.readFile(path.join(installRoot, 'SKILL.md'), 'utf8')).toContain('body')
    expect(await fs.readFile(path.join(installRoot, 'views', 'compact.jmespath'), 'utf8')).toBe(
      'products[*].title\n',
    )
    expect(await fs.readFile(path.join(installRoot, 'references', 'SETUP.md'), 'utf8')).toBe(
      '# Setup\n',
    )
    expect(await fs.readFile(path.join(installRoot, 'references', 'REFERENCE.md'), 'utf8')).toBe(
      '# Reference\n',
    )
  })

  it('overwrites stale sibling content on re-sync (force: true)', async () => {
    await writeHandWrittenSkill('ucp', 'ucp', 'body')
    const sourceViews = path.join(tmpDir, 'skills', 'ucp', 'views')
    await fs.mkdir(sourceViews, { recursive: true })
    await fs.writeFile(path.join(sourceViews, 'v.jmespath'), 'v1\n')

    await syncSkillsWithCleanup({
      name: 'ucp',
      cli: buildTestCli(),
      description: 'test',
      argv: ['--no-global'],
      cwd: tmpDir,
      stdout: () => {},
    })

    // Update source, re-sync, expect install to reflect the new content.
    await fs.writeFile(path.join(sourceViews, 'v.jmespath'), 'v2\n')
    await syncSkillsWithCleanup({
      name: 'ucp',
      cli: buildTestCli(),
      description: 'test',
      argv: ['--no-global'],
      cwd: tmpDir,
      stdout: () => {},
    })

    const installed = await fs.readFile(
      path.join(tmpDir, '.agents', 'skills', 'ucp', 'views', 'v.jmespath'),
      'utf8',
    )
    expect(installed).toBe('v2\n')
  })
})
