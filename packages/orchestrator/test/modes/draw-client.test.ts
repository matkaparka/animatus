import { afterEach, describe, expect, it } from 'vitest'
import { ForgeCallError, ForgeClient } from '../../src/modes/draw/client.ts'
import type { GeneratePayload } from '../../src/modes/draw/client.ts'
import {
  FakeForgeService,
  defaultCatalog,
  gate,
  healthy,
  okPicture,
  serviceError,
} from './draw-support.ts'

const payload: GeneratePayload = {
  checkpoint: 'anime-model',
  prompt: '1girl',
  negative_prompt: '',
  width: 1024,
  height: 1024,
  steps: 30,
  cfg_scale: 5,
  sampler_name: 'Euler a',
  seed: -1,
  loras: [],
  route: 'default',
}

const services: FakeForgeService[] = []
afterEach(async () => {
  for (const s of services.splice(0)) await s.stop()
})
async function setup(generateTimeoutMs = 5000) {
  const service = new FakeForgeService()
  services.push(service)
  const url = await service.start()
  return { service, client: new ForgeClient(url, { generateTimeoutMs }) }
}
const failure = async (p: Promise<unknown>): Promise<ForgeCallError> => {
  const e = await p.then(
    () => {
      throw new Error('expected a failure')
    },
    (err: unknown) => err
  )
  expect(e).toBeInstanceOf(ForgeCallError)
  return e as ForgeCallError
}

describe('the health of the image service', () => {
  it('reads what the service reports about itself', async () => {
    const { client } = await setup()
    const h = await client.health()
    expect(h).toMatchObject({ ok: true, ready: true })
    expect(h.config).toMatchObject({ max_long_side: 1024, forge_reachable: true })
  })

  it('a service that says it is broken (503) is an answer with its own reason, not an error', async () => {
    const { service, client } = await setup()
    service.health = () => ({
      status: 503,
      body: {
        ok: false,
        ready: false,
        service: 'forge',
        detail: 'the blocklist cannot be used (gone)',
        config: {},
      },
    })
    expect(await client.health()).toMatchObject({
      ok: false,
      ready: false,
      detail: 'the blocklist cannot be used (gone)',
    })
  })

  it('a service that is not there is an error that says so', async () => {
    const { service, client } = await setup()
    await service.stop()
    const e = await failure(client.health())
    expect(e.code).toBe('unreachable')
    expect(e.retryable).toBe(true)
    expect(e.message).toContain('cannot reach the image service')
  })

  it('an answer that is not the contract is a bad answer, whatever the status', async () => {
    const { service, client } = await setup()
    service.health = () => ({ status: 200, body: 'ok' })
    expect((await failure(client.health())).code).toBe('bad_answer')
    service.health = () => ({ status: 200, body: { ok: 'yes' } })
    const e = await failure(client.health())
    expect(e.code).toBe('bad_answer')
    expect(e.message).toContain('GET /health')
    service.health = () => ({ status: 500, body: '<html>oops</html>' })
    const html = await failure(client.health())
    expect(html).toMatchObject({ code: 'bad_answer', status: 500 })
    expect(html.message).toContain('oops')
  })
})

describe('the catalog', () => {
  it('lists what may be used', async () => {
    const { client } = await setup()
    const c = await client.catalog()
    expect(c.checkpoints.map((x) => x.name)).toContain('anime-model')
    expect(c.checkpoints.find((x) => x.name === 'heavy-model')).toMatchObject({
      allowed: false,
      why_not: expect.stringContaining('architecture'),
    })
    expect(c.loras.find((x) => x.name === 'sword-lora')?.alias).toBe('SwordStyle')
  })

  it('a service that cannot reach Forge answers with its own words', async () => {
    const { service, client } = await setup()
    service.catalog = () =>
      serviceError(
        502,
        'forge_unreachable',
        'cannot reach Forge at http://x (is it running with --api?)',
        true
      )
    const e = await failure(client.catalog())
    expect(e).toMatchObject({ code: 'forge_unreachable', retryable: true, status: 502 })
    expect(e.message).toContain('--api')
  })

  it('a list in another shape is a bad answer', async () => {
    const { service, client } = await setup()
    service.catalog = () => ({ status: 200, body: { ...defaultCatalog(), checkpoints: 'many' } })
    expect((await failure(client.catalog())).code).toBe('bad_answer')
  })
})

describe('a picture', () => {
  it('comes back with its bytes and what the service says about it', async () => {
    const { service, client } = await setup()
    const r = await client.generate(payload)
    expect(r).toMatchObject({ status: 'ok', width: 1024, attempts: 1 })
    expect(service.generateCalls()).toEqual([payload])
  })

  it('a refusal and a block are answers, with their reasons', async () => {
    const { service, client } = await setup()
    service.generate = () => ({ status: 200, body: { status: 'rejected', reason: 'empty_prompt' } })
    expect(await client.generate(payload)).toEqual({ status: 'rejected', reason: 'empty_prompt' })
    service.generate = () => ({
      status: 200,
      body: { status: 'blocked', reason: 'rating', attempts: 2 },
    })
    expect(await client.generate(payload)).toEqual({
      status: 'blocked',
      reason: 'rating',
      attempts: 2,
    })
  })

  it('a failure keeps the words, the code and the retry hint of the service', async () => {
    const { service, client } = await setup()
    service.generate = () =>
      serviceError(502, 'forge_error', 'Forge answered 500: CUDA out of memory', true)
    expect(await failure(client.generate(payload))).toMatchObject({
      code: 'forge_error',
      retryable: true,
      status: 502,
      message: 'Forge answered 500: CUDA out of memory',
    })
    service.generate = () =>
      serviceError(422, 'lora_not_allowed', 'the LoRA "x" is not in lora_allowlist')
    expect(await failure(client.generate(payload))).toMatchObject({
      code: 'lora_not_allowed',
      retryable: false,
    })
  })

  it('an "ok" without a picture, or a status nobody knows, is never taken for one', async () => {
    const { service, client } = await setup()
    service.generate = () => okPicture({ image_b64: '' })
    expect((await failure(client.generate(payload))).code).toBe('bad_answer')
    service.generate = () => ({ status: 200, body: { status: 'maybe' } })
    expect((await failure(client.generate(payload))).code).toBe('bad_answer')
    service.generate = () => ({ status: 200, body: { status: 'ok' } })
    expect((await failure(client.generate(payload))).code).toBe('bad_answer')
    service.generate = () => ({ status: 200, body: '' })
    expect((await failure(client.generate(payload))).code).toBe('bad_answer')
  })

  it('a service that takes too long is a timeout', async () => {
    const { service, client } = await setup(150)
    const g = gate()
    service.generate = async () => (await g.wait, okPicture())
    const e = await failure(client.generate(payload))
    expect(e.code).toBe('timeout')
    expect(e.message).toContain('did not answer POST /generate')
    g.open()
  })

  it('a caller that gives up closes the connection, and the abort is not dressed up as a service error', async () => {
    const { service, client } = await setup()
    const g = gate()
    service.generate = async () => (await g.wait, okPicture())
    const ctl = new AbortController()
    const pending = client.generate(payload, ctl.signal)
    await expect.poll(() => service.generateCalls().length).toBe(1)
    ctl.abort()
    const e = await pending.then(
      () => null,
      (err: unknown) => err
    )
    expect(e).not.toBeInstanceOf(ForgeCallError)
    expect((e as Error).name).toMatch(/Abort/)
    await expect.poll(() => service.hungUp.length).toBe(1)
    g.open()
  })

  it('a caller that is already aborted never sends anything', async () => {
    const { service, client } = await setup()
    const ctl = new AbortController()
    ctl.abort()
    await expect(client.generate(payload, ctl.signal)).rejects.not.toBeInstanceOf(ForgeCallError)
    expect(service.calls).toEqual([])
  })
})

describe('the size setting', () => {
  it('is sent as it is, and a refusal of the service says why', async () => {
    const { service, client } = await setup()
    await client.setMaxLongSide(768)
    expect(service.calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/config',
      body: { max_long_side: 768 },
    })
    service.config = () => ({
      status: 400,
      body: {
        error: {
          code: 'invalid_config',
          message: 'max_long_side must be a multiple of 64',
          retryable: false,
        },
      },
    })
    expect(await failure(client.setMaxLongSide(770))).toMatchObject({
      code: 'invalid_config',
      message: 'max_long_side must be a multiple of 64',
    })
  })

  it('the health of a healthy service is what the tests assume', () => {
    expect(healthy().status).toBe(200)
  })
})
