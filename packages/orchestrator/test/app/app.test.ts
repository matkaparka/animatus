import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { App } from '../../src/app/app.ts'
import { parseConfig } from '../../src/config.ts'
import type { LlmRequest } from '../../src/llm/types.ts'
import { LlmError } from '../../src/llm/types.ts'
import { getFreePort } from '../../src/plugins/ports.ts'
import { MemorySecretStore } from '../../src/plugins/secrets.ts'
import { FakeTts, danmaku, installCleanup, onCleanup, rig, tempDir, tone, until } from './rig.ts'

installCleanup()

// ─────────────────────────────── tests ───────────────────────────────

describe('a chat message becomes speech', () => {
  it('danmaku -> router -> pacer -> brain -> speech -> stage, with the record kept on the way', async () => {
    const r = await rig()
    r.llm.reply = () => ['[happy][motion:nod]Hello ann', ' friend. [sad]See you soon.']
    const stage = await r.connect()
    await until(() => r.app.stage.hub.connected, 2000, 'stage hello')

    r.bili.emit(danmaku('hello there everyone'))
    await until(() => stage.begins.length >= 2, 5000, 'two utterances at the stage')

    expect(stage.begins.map((b) => b.emotion)).toEqual(['happy', 'sad'])
    expect((stage.begins[0]?.motion as { url: string } | null)?.url).toBe(
      '/asset/motions/poses/nod.vrma'
    )
    await until(() => stage.ended >= 2, 3000, 'playback ended')

    // the model saw the batch as the router formatted it, plus the persona and the tag list
    const req = r.llm.requests[0] as LlmRequest
    expect((req.messages[0]?.content as string) ?? '').toContain('Test persona')
    expect((req.messages[0]?.content as string) ?? '').toContain('nod')
    expect(req.messages.at(-1)?.content as string).toContain('hello there everyone')
    expect(r.tts.requests.map((t) => [t.text, t.style])).toEqual([
      ['Hello ann friend.', 'happy'],
      ['See you soon.', 'sad'],
    ])

    // the record
    const chat = r.app.chat.recent(5)
    expect(chat.map((c) => c.role)).toEqual(['user', 'assistant'])
    const kinds = r.app.runLog.recent(50).map((e) => e.kind)
    expect(kinds).toContain('viewer')
    expect(kinds).toContain('inbox')
    expect(kinds).toContain('speech')
    expect(r.app.traces.recent(10).length).toBeGreaterThanOrEqual(2)
    expect(r.app.alarms.list()).toEqual([])
  })

  it('waits for the stage: a message that arrives with no page connected is answered once one connects', async () => {
    const r = await rig()
    r.bili.emit(danmaku('anyone home'))
    await new Promise((res) => setTimeout(res, 200))
    expect(r.llm.requests).toHaveLength(0)
    r.llm.reply = () => ['[neutral]Yes, I am here.']
    const stage = await r.connect()
    await until(() => stage.begins.length >= 1, 5000, 'utterance after connecting')
    expect(r.llm.requests).toHaveLength(1)
  })

  it('merges chat that arrives together into one model call, as the legacy bridge did', async () => {
    const r = await rig({
      config: {
        inbox: {
          pacer: { idle_settle_sec: 0.15, min_interval_sec: 0.05 },
          filter: { max_merge: 3 },
        },
      },
    })
    const stage = await r.connect()
    await until(() => r.app.stage.hub.connected)
    r.bili.emit(danmaku('first message here', { uid: 1, uname: 'a' }))
    r.bili.emit(danmaku('second message here', { uid: 2, uname: 'b' }))
    r.bili.emit(danmaku('third message here', { uid: 3, uname: 'c' }))
    await until(() => stage.begins.length >= 1, 5000)
    expect(r.llm.requests).toHaveLength(1)
    const sent = r.llm.requests[0]?.messages.at(-1)?.content as string
    expect(sent).toContain('first message here')
    expect(sent).toContain('third message here')
  })

  it('does not stack messages: the next batch waits for the reply in progress to be spoken', async () => {
    const r = await rig()
    r.llm.reply = () => ['[neutral]A reply that takes a moment to say.']
    const stage = await r.connect({ playMs: 250 })
    await until(() => r.app.stage.hub.connected)
    r.bili.emit(danmaku('question number one', { uid: 1 }))
    await until(() => r.llm.requests.length === 1, 3000)
    r.bili.emit(danmaku('question number two', { uid: 2 }))
    await new Promise((res) => setTimeout(res, 120))
    expect(r.llm.requests).toHaveLength(1) // still speaking the first
    await until(() => r.llm.requests.length === 2, 5000, 'second model call')
    await until(() => stage.begins.length >= 2, 5000)
  })
})

describe('failures are loud, not silent, and not fatal', () => {
  it("the alarm for a model failure says why, in the provider's own words, not only which provider failed", async () => {
    const r = await rig()
    r.llm.reply = () => {
      const summary = new LlmError(
        'unavailable',
        'all LLM providers failed: primary=bad_request (HTTP 400)',
        { providerId: 'gateway' }
      )
      summary.attempts = [
        {
          providerId: 'primary',
          outcome: 'error',
          code: 'bad_request',
          status: 400,
          detail: 'Gemini HTTP 400 INVALID_ARGUMENT: Request contains an invalid argument.',
        },
      ]
      return [summary]
    }
    await r.connect()
    await until(() => r.app.stage.hub.connected)
    r.bili.emit(danmaku('anything at all'))
    await until(() => r.app.alarms.has('llm_failed'), 4000, 'llm alarm')
    const alarm = r.app.alarms.list().find((a) => a.code === 'llm_failed')
    expect(alarm?.message).toContain('primary=bad_request (HTTP 400)')
    expect(alarm?.message).toContain('Request contains an invalid argument')
  })

  it('a model failure raises an alarm, says nothing, and the next message works', async () => {
    const r = await rig()
    let calls = 0
    r.llm.reply = () =>
      ++calls === 1
        ? [new LlmError('unavailable', 'all providers failed', { providerId: 'x' })]
        : ['[neutral]Back again.']
    const stage = await r.connect()
    await until(() => r.app.stage.hub.connected)

    r.bili.emit(danmaku('first try please', { uid: 1 }))
    await until(() => r.app.alarms.has('llm_failed'), 4000, 'llm alarm')
    expect(stage.begins).toHaveLength(0)
    expect(
      r.app.runLog
        .recent(20)
        .some((e) => e.kind === 'llm' && e.text.includes('all providers failed'))
    ).toBe(true)

    r.bili.emit(danmaku('second try please', { uid: 2 }))
    await until(() => stage.begins.length >= 1, 5000)
    await until(() => !r.app.alarms.has('llm_failed'), 2000, 'alarm cleared')
  })

  it('a sentence the speech service cannot make is reported, and the rest of the reply is still spoken', async () => {
    const r = await rig()
    r.llm.reply = () => ['[happy]This one fails. ', '[sad]This one works.']
    let n = 0
    r.tts.synthesize = async (req) => {
      r.tts.requests.push(req)
      if (++n === 1) throw new Error('synthesis blew up') // the first sentence only
      return {
        sampleRate: 16000,
        chunks: (async function* () {
          yield tone()
        })(),
      }
    }
    const stage = await r.connect()
    await until(() => r.app.stage.hub.connected)
    r.bili.emit(danmaku('say something please'))
    await until(() => stage.begins.length >= 1, 6000)
    expect(stage.begins).toHaveLength(1)
    expect(
      r.app.runLog.recent(50).some((e) => e.kind === 'speech' && e.text.includes('could not speak'))
    ).toBe(true)
  })

  it('the stage page going away raises an alarm and coming back clears it', async () => {
    const r = await rig()
    const stage = await r.connect()
    await until(() => r.app.stage.hub.connected)
    expect(r.app.alarms.has('stage_disconnected')).toBe(false)
    stage.close()
    await until(() => r.app.alarms.has('stage_disconnected'), 3000, 'disconnect alarm')
    await r.connect()
    await until(() => !r.app.alarms.has('stage_disconnected'), 3000, 'alarm cleared')
  })

  it('without any model provider the operator is told, and nothing is sent to a model', async () => {
    const dir = await tempDir('nollm')
    const persona = path.join(dir, 'p')
    await mkdir(persona, { recursive: true })
    await writeFile(path.join(persona, 'persona.md'), 'p')
    const config = parseConfig(
      {
        servers: { stage_port: await getFreePort(), console_port: await getFreePort() },
        persona,
        paths: { data_dir: dir },
      },
      { root: dir }
    )
    const app = await App.create({
      config,
      secrets: new MemorySecretStore(),
      tts: new FakeTts(),
      noBrowser: true,
      pluginsDir: dir,
      logger: () => {},
    })
    await app.start()
    onCleanup(() => app.stop())
    expect(app.llmUsable).toBe(false)
    expect(app.alarms.has('llm_none')).toBe(true)
  })

  it('a provider whose key is not set is left out and flagged, not fatal', async () => {
    const dir = await tempDir('nokey')
    const persona = path.join(dir, 'p')
    await mkdir(persona, { recursive: true })
    await writeFile(path.join(persona, 'persona.md'), 'p')
    const config = parseConfig(
      {
        servers: { stage_port: await getFreePort(), console_port: await getFreePort() },
        persona,
        paths: { data_dir: dir },
        llm: {
          providers: [{ kind: 'gemini', id: 'primary', model: 'm', api_key: '${secret:gemini}' }],
        },
      },
      { root: dir }
    )
    const app = await App.create({
      config,
      secrets: new MemorySecretStore(),
      tts: new FakeTts(),
      noBrowser: true,
      pluginsDir: dir,
      logger: () => {},
    })
    await app.start()
    onCleanup(() => app.stop())
    expect(app.llmUsable).toBe(false)
    const alarm = app.alarms.list().find((a) => a.code === 'llm_provider_unavailable')
    expect(alarm?.subject).toBe('primary')
    expect(alarm?.message).toContain('secret "gemini" is not set')

    // the key arrives (through the console's key page, say) and the gateway is rebuilt
    await app.secrets.set('gemini', 'test-key-value-123')
    await app.reloadLlm()
    expect(app.llmUsable).toBe(true)
    expect(app.alarms.has('llm_provider_unavailable', 'primary')).toBe(false)
    expect(JSON.stringify(app.alarms.list())).not.toContain('test-key-value-123')
  })
})

describe('what the operator can do', () => {
  it('say speaks at once without the model and supersedes what is being said', async () => {
    const r = await rig()
    const stage = await r.connect()
    await until(() => r.app.stage.hub.connected)
    r.app.say({ text: 'Hello from the host', emotion: 'happy' })
    await until(() => stage.begins.length >= 1, 3000)
    expect(stage.begins[0]?.emotion).toBe('happy')
    expect(r.llm.requests).toHaveLength(0)
    expect(r.tts.requests[0]).toMatchObject({ text: 'Hello from the host', style: 'happy' })
  })

  it('stopSpeech cancels the reply in progress and tells the stage', async () => {
    const r = await rig()
    r.llm.reply = () => [
      '[neutral]A long first sentence to say. ',
      'And a second one after it. ',
      'And a third.',
    ]
    const stage = await r.connect({ playMs: 400 })
    await until(() => r.app.stage.hub.connected)
    r.bili.emit(danmaku('tell me a story'))
    await until(() => stage.begins.length >= 1, 5000)
    r.app.stopSpeech()
    await until(() => stage.cancels.length >= 1, 3000, 'cancel at the stage')
    await until(() => !r.app.director.speaking, 3000)
    expect(r.app.brain.processing).toBe(false)
  })

  it('inject puts a fake viewer through the same path, always as an untrusted viewer', async () => {
    const r = await rig()
    const stage = await r.connect()
    await until(() => r.app.stage.hub.connected)
    r.app.inject({ kind: 'danmaku', name: 'tester', text: 'is this thing on', count: 1 })
    await until(() => stage.begins.length >= 1, 5000)
    const line = r.app.runLog.recent(30).find((e) => e.text.includes('(injected)'))
    expect(line?.trust).toBe('untrusted')
    expect(r.llm.requests[0]?.messages.at(-1)?.content as string).toContain('is this thing on')
  })

  it('inject also covers gifts, guards and paid messages', async () => {
    const r = await rig({
      config: {
        inbox: {
          gift: { merge_window_sec: 0.05 },
          pacer: { idle_settle_sec: 0.05, min_interval_sec: 0.05 },
        },
      },
    })
    await r.connect()
    await until(() => r.app.stage.hub.connected)
    r.app.inject({ kind: 'gift', name: 'fan', text: '', gift: 'rocket', count: 2, price: 20 })
    await until(() => r.llm.requests.length >= 1, 5000)
    expect(r.llm.requests[0]?.messages.at(-1)?.content as string).toContain('rocket')
  })
})

describe('the stage gets its snapshots', () => {
  it('sends scene, library and look when a page connects', async () => {
    const r = await rig({
      config: { stage: { model: 'my model.vrm', camera: { fit: 'full_body' } } },
    })
    const stage = await r.connect()
    await until(() => stage.stage.jsonTypes().includes('look.set'), 3000)
    const scene = stage.stage.json().find((m) => m.type === 'scene.set') as Record<string, unknown>
    expect((scene.model as { url: string }).url).toBe('/asset/models/my%20model.vrm')
    expect((scene.camera as { fit: string }).fit).toBe('full_body')
    const library = stage.stage.json().find((m) => m.type === 'library.set') as Record<
      string,
      unknown
    >
    expect(library).toBeDefined()
  })

  it('an empty stage has no model', async () => {
    const r = await rig()
    expect(r.app.sceneMessage().model).toBeNull()
  })
})

describe('the chat source', () => {
  it('is started and stopped with the app, and its alarms reach the operator', async () => {
    const r = await rig()
    expect(r.bili.started).toBe(true)
    r.bili.emit({ type: 'alarm', code: 'guest_connection', message: 'connected as a guest' })
    expect(r.app.alarms.list().find((a) => a.code === 'bilibili_guest_connection')?.subject).toBe(
      'bilibili'
    )
    await r.app.stop()
    expect(r.bili.stopped).toBe(true)
  })

  it('is not started when the configuration does not enable it', async () => {
    const r = await rig({ config: { sources: { bilibili: { enabled: false, room_id: 5 } } } })
    expect(r.bili.started).toBe(false)
  })
})
