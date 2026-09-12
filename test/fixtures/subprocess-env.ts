const AMBIENT_UCP_STATE = new Set([
  'UCP_PROFILE',
  'UCP_AGENT_PROFILE_URL',
  'UCP_BUSINESS',
  'UCP_DEFAULT_CATALOG',
])

/**
 * Inherit the host process environment without inheriting UCP routing state.
 * Tests that claim a fresh install must not accidentally use the developer's
 * active Profile, agent URL, Business, or catalog override.
 */
export function freshUcpEnv(
  home: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !AMBIENT_UCP_STATE.has(key)) env[key] = value
  }
  env.UCP_HOME = home
  // Allow local HTTP fixtures through the production HTTPS-only URL guard.
  env.UCP_TEST_ALLOW_INSECURE_LOCALHOST = 'true'
  return { ...env, ...overrides }
}
