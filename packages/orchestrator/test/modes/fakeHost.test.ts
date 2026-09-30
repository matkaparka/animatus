import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fakeHost } from './fakeHost.ts'

describe('fakeHost', () => {
  it('records what a controller does and answers like the real host', async () => {
    const f = await fakeHost({
      config: { modes: { dance: { enabled: true, config: { cooldown_sec: 5 } } } },
      services: { forge: 'http://127.0.0.1:7860' },
      modeStates: { sleep: 'ACTIVE' },
    })
    const h = f.host
    h.event('mode', 'hello')
    h.alarm('a', 'warn', 'm', 's')
    h.alarm('b', 'error', 'n')
    h.clearAlarm('a', 's')
    h.holdSpeech('x', true)
    h.say({ text: 'hi' })
    h.songLine('a song')
    await h.tellBrain('told', { images: [] })
    await h.enterMode('dance', { replace: true })
    await h.exitMode('dance', 'done')
    expect(f.events).toEqual(['hello'])
    expect(f.alarms.map((a) => a.code)).toEqual(['b'])
    expect(f.held).toEqual([['x', true]])
    expect(f.said).toEqual([{ text: 'hi' }])
    expect(f.songLines).toEqual(['a song'])
    expect(f.told[0]).toMatchObject({ text: 'told' })
    expect(f.entered).toEqual([{ id: 'dance', opts: { replace: true } }])
    expect(f.exited).toEqual([{ id: 'dance', reason: 'done' }])
    expect(h.serviceUrl('forge')).toBe('http://127.0.0.1:7860')
    expect(h.serviceUrl('tts')).toBeNull()
    expect(h.modeState('sleep')).toBe('ACTIVE')
    expect(h.modeState('sing')).toBe('IDLE')
    expect(h.config.modes.dance?.config).toEqual({ cooldown_sec: 5 })
  })

  it('has an llm you can script, prompts with variables, libraries and a stage you can play', async () => {
    const f = await fakeHost()
    f.llm.answer = ['one', 'two']
    expect(await f.host.llmText({ tag: 't', user: 'q' })).toBe('one')
    expect(await f.host.llmText({ tag: 't', user: 'q' })).toBe('two')
    expect(await f.host.llmText({ tag: 't', user: 'q' })).toBe('two')
    f.llm.answer = (req) => `echo ${req.user as string}`
    expect(await f.host.llmText({ tag: 't', user: 'hey' })).toBe('echo hey')
    f.prompts['sleep/outro'] = 'Goodnight {{name}}.'
    expect(f.host.prompt('sleep', 'outro', { name: 'ann' })).toBe('Goodnight ann.')
    expect(f.host.prompt('sleep', 'nope')).toBeNull()
    await mkdir(f.host.libraryDir('generated') as string, { recursive: true })
    expect(f.host.libraryDir('generated')).toBe(path.join(f.dataDir, 'generated'))
    expect(f.host.assetUrl('songs', 'a b.mp3')).toBe('/asset/songs/a%20b.mp3')
    const seen: unknown[] = []
    f.hub.on('sing.state', (m) => seen.push(m))
    f.stage('sing.state', { song_id: 's', phase: 'playing' })
    expect(seen).toEqual([{ type: 'sing.state', song_id: 's', phase: 'playing' }])
    f.host.hub.send({ type: 'sing.stop', fade_s: 0.5 })
    expect(f.hub.sent).toEqual([{ type: 'sing.stop', fade_s: 0.5 }])
  })
})
