import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import {
  AnimatusEvent,
  ModeManifest,
  PluginManifest,
  ServiceHealth,
  decideTool,
  makeSource,
  serviceName,
  trustFor,
} from '../src/index.ts'

describe('mode manifest', () => {
  it('parses the draw-mode example from the design brief', () => {
    const yaml = `
id: draw
title: Draw
requires:
  services: [tts, motion, forge]
  vram_mb_est: 7500
exclusive_with: [sing, game, sleep, reaction]
prompt: prompts/draw.md
tools: [draw_image]
triggers:
  hotkey: ctrl+alt+p
  danmaku_prefix: ["draw", "/draw"]
stage:
  layout: frame
  background: drawing_frame
`
    const m = ModeManifest.parse(parseYaml(yaml))
    expect(m.requires.services).toEqual(['tts', 'motion', 'forge'])
    expect(m.requires.vram_mb_est).toBe(7500)
    expect(m.priority).toBe(50)
    expect(m.preempts).toBe(false)
    expect(m.triggers.danmaku_prefix).toEqual(['draw', '/draw'])
    expect(m.triggers.gift).toEqual([])
  })

  it('fills defaults for a bare manifest and rejects a bad id', () => {
    const m = ModeManifest.parse({ id: 'sleep', title: 'Sleep', preempts: true, priority: 100 })
    expect(m.requires.vram_mb_est).toBeNull()
    expect(m.exclusive_with).toEqual([])
    expect(ModeManifest.safeParse({ id: 'Sleep', title: 'x' }).success).toBe(false)
    expect(ModeManifest.safeParse({ id: 'ok', title: 'x', priority: 101 }).success).toBe(false)
  })
})

describe('plugin manifest', () => {
  const tts = `
id: gptsovits
title: GPT-SoVITS
kind: tts
service: tts
provides: [tts.stream]
runtime:
  type: process
  env: external
  command: ["{config.python}", "api_v2.py", "-a", "127.0.0.1", "-p", "{port}"]
  cwd: "{config.root}"
  port: auto
  env_vars:
    GPT_SOVITS_LOG: quiet
health:
  http:
    path: /health
  start_timeout_ms: 120000
resources:
  gpu: true
  vram_mb_est: null
secrets:
  - name: gemini
    env: GEMINI_API_KEY
`
  it('parses a process plugin and applies defaults', () => {
    const m = PluginManifest.parse(parseYaml(tts))
    expect(m.kind).toBe('tts')
    expect(serviceName(m)).toBe('tts')
    expect(m.runtime.type).toBe('process')
    if (m.runtime.type === 'process') {
      expect(m.runtime.guard).toBe(true)
      expect(m.runtime.stop.grace_ms).toBe(5000)
    }
    expect(m.health.http?.expect_status).toBe(200)
    expect(m.health.http?.ready_field).toBe('ready')
    expect(m.health.fail_threshold).toBe(3)
    expect(m.restart.policy).toBe('on-failure')
    expect(m.resources.vram_mb_est).toBeNull()
    expect(m.secrets[0]).toEqual({ name: 'gemini', env: 'GEMINI_API_KEY', required: false })
  })

  it('service name defaults to the id', () => {
    const m = PluginManifest.parse({
      id: 'forge',
      title: 'Forge',
      kind: 'image',
      runtime: { type: 'external', url: 'http://127.0.0.1:7870' },
      health: { http: {} },
    })
    expect(serviceName(m)).toBe('forge')
  })

  it('requires a health check, a valid id, and valid secret env names', () => {
    const base = parseYaml(tts)
    expect(PluginManifest.safeParse({ ...base, health: { start_timeout_ms: 5000 } }).success).toBe(false)
    expect(PluginManifest.safeParse({ ...base, id: 'Bad_Id' }).success).toBe(false)
    expect(
      PluginManifest.safeParse({ ...base, secrets: [{ name: 'k', env: 'lower_case' }] }).success
    ).toBe(false)
    expect(PluginManifest.safeParse({ ...base, health: { tcp: true } }).success).toBe(true)
  })
})

describe('service health contract', () => {
  it('parses ok and not-ready responses', () => {
    expect(ServiceHealth.parse({ ok: true, ready: true, service: 'forge', config: { max_long_side: 1024 } })).toBeTruthy()
    expect(ServiceHealth.parse({ ok: true, ready: false, service: 'tts' }).ready).toBe(false)
    expect(ServiceHealth.safeParse({ ok: true }).success).toBe(false)
  })
})

describe('events and trust', () => {
  it('derives trust from the kind', () => {
    expect(trustFor('viewer')).toBe('untrusted')
    expect(trustFor('web')).toBe('untrusted')
    expect(trustFor('agent')).toBe('untrusted')
    expect(trustFor('moderator')).toBe('trusted')
    expect(trustFor('host')).toBe('privileged')
    expect(trustFor('system')).toBe('privileged')
    expect(makeSource('viewer', { uid: '1', name: 'a' }).trust).toBe('untrusted')
  })

  it('parses a danmaku event', () => {
    const e = AnimatusEvent.parse({
      id: 'e1',
      ts: 1,
      type: 'danmaku',
      text: 'hello',
      source: makeSource('viewer', { platform: 'bilibili', uid: '42', name: 'x' }),
    })
    expect(e.type).toBe('danmaku')
  })
})

describe('tool tiers', () => {
  it('free tools run for any origin', () => {
    for (const t of ['untrusted', 'trusted', 'privileged'] as const) {
      expect(decideTool('free', t)).toEqual({ action: 'run' })
    }
  })
  it('approval tools can only be requested by trusted or privileged origins', () => {
    expect(decideTool('approval', 'untrusted')).toEqual({ action: 'reject', reason: 'untrusted_origin' })
    expect(decideTool('approval', 'trusted')).toEqual({ action: 'queue_approval' })
    expect(decideTool('approval', 'privileged')).toEqual({ action: 'queue_approval' })
  })
  it('disabled and unknown tools never run', () => {
    expect(decideTool('disabled', 'privileged')).toEqual({ action: 'reject', reason: 'disabled' })
    expect(decideTool(undefined, 'privileged')).toEqual({ action: 'reject', reason: 'unknown_tool' })
  })
})
