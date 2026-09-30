export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One-line description of an error for logs and status details; includes a network error code when there is one. */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause: unknown = err.cause
    const code = isRecord(cause) && typeof cause.code === 'string' ? cause.code : undefined
    return code === undefined ? err.message : `${err.message} (${code})`
  }
  return String(err)
}
