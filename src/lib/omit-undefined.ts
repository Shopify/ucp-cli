// Drop keys whose value is `undefined` from an object.
//
// `exactOptionalPropertyTypes: true` makes `{ x: T | undefined }` distinct
// from `{ x?: T }` — the former requires every key present (even as
// undefined), the latter requires absence. Forwarding caller-supplied
// optional fields between the two shapes therefore needs an inline ceremony
// at every spread site:
//
//   ...(opts.signal !== undefined ? { signal: opts.signal } : {})
//
// Repeated 20+ times across the codebase (discover, operation, cache, mcp-
// client, profile, cli). One named operation collapses each call site to:
//
//   ...omitUndefined({ signal: opts.signal, force: opts.force, ... })
//
// Returned type narrows out `undefined` from each value so downstream code
// that consumes the spread object sees the exact-optional shape.

export function omitUndefined<T extends object>(
  obj: T,
): { [K in keyof T]: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v
  }
  return out as { [K in keyof T]: Exclude<T[K], undefined> }
}
