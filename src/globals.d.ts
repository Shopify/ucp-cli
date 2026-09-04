// Build-time defines (scripts/defines.mjs). Nothing version-specific belongs
// here: the UCP release is chosen by the active agent profile's `ucp.version`
// and every per-release artifact is a lookup in src/core/releases.ts.
declare const __CLI_VERSION__: string
declare const __BUILD_NUMBER__: string
declare const __DEFAULT_CATALOG_URL__: string
declare const __MIN_NODE_MAJOR__: number
