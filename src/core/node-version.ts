interface ParsedNodeVersion {
  core: [major: number, minor: number, patch: number]
  prerelease: boolean
}

const NODE_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[-0-9A-Za-z.]+)?(?:\+[-0-9A-Za-z.]+)?$/

function parseNodeVersion(version: string): ParsedNodeVersion | undefined {
  const match = NODE_VERSION_PATTERN.exec(version)
  if (match === null) return undefined

  const core: ParsedNodeVersion['core'] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (core.some((component) => !Number.isSafeInteger(component))) return undefined

  return { core, prerelease: match[4] !== undefined }
}

/**
 * Compare all three numeric components of Node's runtime version against the
 * package floor. Runtime versions may include prerelease or build suffixes;
 * malformed versions fail closed instead of making a diagnostic throw.
 */
export function isSupportedNodeVersion(version: string): boolean {
  const current = parseNodeVersion(version)
  if (current === undefined) return false

  const minimum = parseNodeVersion(__MIN_NODE_VERSION__)
  if (minimum === undefined || minimum.prerelease) {
    throw new Error(`Invalid minimum Node version: ${__MIN_NODE_VERSION__}`)
  }

  const [currentMajor, currentMinor, currentPatch] = current.core
  const [minimumMajor, minimumMinor, minimumPatch] = minimum.core
  if (currentMajor !== minimumMajor) return currentMajor > minimumMajor
  if (currentMinor !== minimumMinor) return currentMinor > minimumMinor
  if (currentPatch !== minimumPatch) return currentPatch > minimumPatch

  // A prerelease of the boundary is below its stable release. Build metadata
  // does not set `prerelease`, so it compares equal to the boundary.
  return !current.prerelease
}
