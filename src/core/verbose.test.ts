// Tests for the module-scoped verbose writer. Pin behaviors that matter:
// (1) vlog is a no-op when no writer is installed (the production default,
// must never accidentally hit stderr from a daemon mode), (2) installed
// writers receive the [ucp] prefix + trailing newline contract that log
// scrapers depend on, (3) `null` clears the writer cleanly so MCP boot
// can mute mid-process.

import { afterEach, describe, expect, it } from 'vitest'

import { setVerboseWriter, verboseEnabled, vlog } from './verbose.js'

describe('verbose', () => {
  afterEach(() => {
    setVerboseWriter(null)
  })

  it('is a no-op when no writer is installed', () => {
    expect(verboseEnabled()).toBe(false)
    expect(() => vlog('should not throw or write')).not.toThrow()
  })

  it('emits [ucp] prefix and trailing newline once a writer is set', () => {
    const lines: string[] = []
    setVerboseWriter((msg) => {
      lines.push(msg)
    })
    expect(verboseEnabled()).toBe(true)
    vlog('discover: hello')
    vlog('cache: world')
    expect(lines).toEqual(['[ucp] discover: hello\n', '[ucp] cache: world\n'])
  })

  it('passing null clears the writer (MCP-mode mute path)', () => {
    const lines: string[] = []
    setVerboseWriter((msg) => {
      lines.push(msg)
    })
    vlog('one')
    setVerboseWriter(null)
    vlog('two')
    expect(verboseEnabled()).toBe(false)
    expect(lines).toEqual(['[ucp] one\n'])
  })
})
