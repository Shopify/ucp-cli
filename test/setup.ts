import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const xdgDataHome = mkdtempSync(join(tmpdir(), 'ucp-cli-vitest-xdg-'))

// Incur stores installed-skill metadata under XDG_DATA_HOME. Several CLI tests
// assert exact JSON envelopes, so inheriting a developer's real `ucp skills add`
// state makes test output nondeterministic by injecting "skills are out of date"
// CTAs. Force every Vitest worker onto an empty data home before tests create
// CLI instances.
process.env.XDG_DATA_HOME = xdgDataHome

process.on('exit', () => {
  rmSync(xdgDataHome, { recursive: true, force: true })
})
