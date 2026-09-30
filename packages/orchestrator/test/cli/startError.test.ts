import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import { friendlyStartError } from '../../src/cli/startError.ts'

describe('a start that failed for a reason the person can fix', () => {
  it('a port that is taken says which, and what to do', async () => {
    const first = createServer()
    await new Promise<void>((resolve) => first.listen(0, '127.0.0.1', resolve))
    const port = (first.address() as { port: number }).port
    const error = await new Promise<unknown>((resolve) => {
      const second = createServer()
      second.once('error', resolve)
      second.listen(port, '127.0.0.1')
    })
    first.close()
    const text = friendlyStartError(error)
    expect(text).toContain(`Port ${port} is already in use`)
    expect(text).toContain('servers.stage_port')
  })

  it('anything else is left to the stack trace', () => {
    expect(friendlyStartError(new Error('boom'))).toBeNull()
    expect(friendlyStartError(null)).toBeNull()
    expect(friendlyStartError('EADDRINUSE')).toBeNull()
    expect(friendlyStartError({ code: 'EADDRINUSE' })).toContain('Port is already in use')
  })
})
