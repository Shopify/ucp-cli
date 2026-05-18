// Shared Zod-issue formatter.
//
// Every UcpError thrown after a `safeParse` failure uses the same one-line
// `<path>: <message>; <path>: <message>` shape. Centralizing the formatter
// keeps that wire-text contract consistent across cache / profile / store /
// any future schema boundary.

export interface ZodLikeIssue {
  path: PropertyKey[]
  message: string
}

export function formatZodIssues(issues: readonly ZodLikeIssue[]): string {
  return issues
    .map((issue) => `${issue.path.map((p) => String(p)).join('.') || '<root>'}: ${issue.message}`)
    .join('; ')
}
