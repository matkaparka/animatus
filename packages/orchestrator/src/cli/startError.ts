/**
 * What to tell a person whose start failed for a reason they can fix, in place of a stack trace. Null for anything else.
 */
export function friendlyStartError(e: unknown): string | null {
  if (typeof e !== 'object' || e === null) return null
  const err = e as { code?: unknown; port?: unknown }
  if (err.code === 'EADDRINUSE') {
    const port = typeof err.port === 'number' ? ` ${err.port}` : ''
    return `Port${port} is already in use. Is Animatus already running? Close the other one, or change servers.stage_port and servers.console_port in the configuration.`
  }
  return null
}
