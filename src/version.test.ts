import { describe, expect, it } from 'vitest'

describe('build defines', () => {
  it('CLI version is a semver-shaped string', () => {
    expect(typeof __CLI_VERSION__).toBe('string')
    expect(__CLI_VERSION__).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('build number is a numeric string', () => {
    expect(__BUILD_NUMBER__).toMatch(/^\d+$/)
  })

  it('default profile URL resolves to the configured template', () => {
    expect(__DEFAULT_PROFILE_URL__).toMatch(/^https:\/\/[\w.-]+\/.+\.json(\?.*)?$/)
  })
})
