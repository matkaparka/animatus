import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import { PortAllocator, getFreePort } from '../../src/plugins/ports.ts'

const listenOn = (port: number) =>
  new Promise<void>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => server.close(() => resolve()))
  })

describe('getFreePort', () => {
  it('returns a port that can be bound right away', async () => {
    const port = await getFreePort()
    expect(port).toBeGreaterThanOrEqual(1024)
    expect(port).toBeLessThanOrEqual(65535)
    await listenOn(port)
  })
})

describe('PortAllocator', () => {
  it('never hands out the same port twice under concurrency (real OS source)', async () => {
    const allocator = new PortAllocator()
    const ports = await Promise.all(Array.from({ length: 200 }, () => allocator.allocate()))
    expect(new Set(ports).size).toBe(200)
  })

  it('skips ports it already issued when the source repeats itself', async () => {
    // A source that answers every value twice, like an OS recycling ports between quick bind/close cycles.
    let calls = 0
    const allocator = new PortAllocator({
      source: async () => 40000 + Math.floor(calls++ / 2),
      maxAttempts: 100,
    })
    const ports = await Promise.all(Array.from({ length: 10 }, () => allocator.allocate()))
    expect(new Set(ports).size).toBe(10)
  })

  it('avoids the reserved set, given up front or added later', async () => {
    const values = [41000, 41001, 41002, 41003]
    const allocator = new PortAllocator({
      reserved: [41000],
      source: async () => values.shift() ?? 41999,
    })
    allocator.reserve(41001)
    expect(allocator.isReserved(41000)).toBe(true)
    expect(allocator.isReserved(41001)).toBe(true)
    expect(await allocator.allocate()).toBe(41002)
    expect(await allocator.allocate()).toBe(41003)
  })

  it('gives up with a clear error when nothing qualifies', async () => {
    const allocator = new PortAllocator({
      reserved: [42000],
      source: async () => 42000,
      maxAttempts: 3,
    })
    await expect(allocator.allocate()).rejects.toThrow(/after 3 attempts/)
  })

  it('hands out ports that are actually free', async () => {
    const allocator = new PortAllocator()
    for (let i = 0; i < 5; i++) await listenOn(await allocator.allocate())
  })
})
