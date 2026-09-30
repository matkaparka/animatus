import { createServer } from 'node:net'

/** Asks the OS for a free TCP port on the loopback interface: bind port 0, read it, close. */
export function getFreePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, host, () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close((err) => {
        if (err || port === 0) reject(err ?? new Error('the OS did not report a port'))
        else resolve(port)
      })
    })
  })
}

export interface PortAllocatorOptions {
  /** Ports that must never be handed out (fixed ports of other services, well-known ports). */
  reserved?: Iterable<number>
  host?: string
  /** Where candidate ports come from. Defaults to `getFreePort`; injectable for tests. */
  source?: () => Promise<number>
  /** How many candidates to try before giving up (default 50). */
  maxAttempts?: number
}

/**
 * Hands out loopback ports. The OS may give the same ephemeral port to two callers that bind and
 * release in quick succession, so the allocator remembers what it issued and never hands out the same
 * port twice in a session; it also skips a reserved set.
 */
export class PortAllocator {
  private readonly reserved = new Set<number>()
  private readonly issued = new Set<number>()
  private readonly source: () => Promise<number>
  private readonly maxAttempts: number

  constructor(options: PortAllocatorOptions = {}) {
    for (const port of options.reserved ?? []) this.reserved.add(port)
    const host = options.host ?? '127.0.0.1'
    this.source = options.source ?? (() => getFreePort(host))
    this.maxAttempts = options.maxAttempts ?? 50
  }

  /** Keeps `ports` out of future allocations (for example the fixed ports declared in manifests). */
  reserve(...ports: number[]): void {
    for (const port of ports) this.reserved.add(port)
  }

  isReserved(port: number): boolean {
    return this.reserved.has(port)
  }

  async allocate(): Promise<number> {
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const port = await this.source()
      // No await between the check and the add: concurrent callers cannot both pass.
      if (this.reserved.has(port) || this.issued.has(port)) continue
      this.issued.add(port)
      return port
    }
    throw new Error(
      `no free port that is neither reserved nor already issued after ${this.maxAttempts} attempts`
    )
  }
}
