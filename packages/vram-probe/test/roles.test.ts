import { describe, expect, it } from 'vitest'
import { DEFAULT_ROLES, RoleClassifier, mergeRoles, parseRoleSpec } from '../src/roles.ts'

const tree = (c: RoleClassifier) => {
  // bat(50) -> python api_v2(100) -> worker(101)
  c.setProc({ pid: 50, ppid: 4, name: 'cmd.exe', cmd: 'cmd /c start_voice.bat' })
  c.setProc({ pid: 100, ppid: 50, name: 'python.exe', cmd: 'python.exe api_v2.py -a 127.0.0.1 -p 9880' })
  c.setProc({ pid: 101, ppid: 100, name: 'python.exe', cmd: 'python.exe -c "multiprocessing spawn"' })
  // chrome browser(299) -> gpu-process(300)
  c.setProc({ pid: 299, ppid: 4, name: 'chrome.exe', cmd: '"chrome.exe" --user-data-dir=X:\\animatus-stage\\profile --app=http://127.0.0.1:5810' })
  c.setProc({ pid: 300, ppid: 299, name: 'chrome.exe', cmd: '"chrome.exe" --type=gpu-process' })
  // an unrelated chrome
  c.setProc({ pid: 400, ppid: 4, name: 'chrome.exe', cmd: '"chrome.exe" --type=gpu-process --user-data-dir=X:\\personal' })
  c.setProc({ pid: 500, ppid: 4, name: 'llama-server.exe', cmd: 'llama-server.exe -m x.gguf' })
}

describe('RoleClassifier', () => {
  it('matches by command line and inherits from the nearest matching ancestor', () => {
    const c = new RoleClassifier(DEFAULT_ROLES)
    tree(c)
    expect(c.classify(100)).toBe('gpt-sovits')
    expect(c.classify(101)).toBe('gpt-sovits') // child worker inherits
    expect(c.classify(300)).toBe('stage') // gpu-process inherits from the browser that owns the profile
    expect(c.classify(500)).toBe('llm') // by image name
  })

  it('leaves unrelated and unknown processes as other', () => {
    const c = new RoleClassifier(DEFAULT_ROLES)
    tree(c)
    expect(c.classify(400)).toBe('other')
    expect(c.classify(50)).toBe('other')
    expect(c.classify(9999)).toBe('other')
  })

  it('re-classifies when the process table changes', () => {
    const c = new RoleClassifier(DEFAULT_ROLES)
    c.setProc({ pid: 700, ppid: 701, name: 'python.exe', cmd: 'python.exe x.py' })
    expect(c.classify(700)).toBe('other')
    c.setProc({ pid: 701, ppid: 4, name: 'cmd.exe', cmd: 'cmd /c gsvi_bridge.py' })
    expect(c.classify(700)).toBe('gpt-sovits')
  })

  it('supports name+cmd, regex and pid rules', () => {
    const roles = mergeRoles({}, [
      parseRoleSpec('a=name:chrome.exe;cmd:profile-a'),
      parseRoleSpec('b=cmd:/--port[= ]5810/'),
      parseRoleSpec('c=pid:777'),
    ])
    const c = new RoleClassifier(roles)
    c.setProc({ pid: 1, name: 'chrome.exe', cmd: 'chrome --user-data-dir=profile-a' })
    c.setProc({ pid: 2, name: 'firefox.exe', cmd: 'firefox profile-a' })
    c.setProc({ pid: 3, name: 'node.exe', cmd: 'node server --port 5810' })
    c.setProc({ pid: 4, name: 'node.exe', cmd: 'node server --port 5811' })
    c.setProc({ pid: 777, name: 'whatever.exe', cmd: '' })
    expect(c.classify(1)).toBe('a')
    expect(c.classify(2)).toBe('other') // name did not match
    expect(c.classify(3)).toBe('b')
    expect(c.classify(4)).toBe('other')
    expect(c.classify(777)).toBe('c')
  })

  it('an empty rule never matches everything', () => {
    const c = new RoleClassifier({ x: [{}] })
    c.setProc({ pid: 1, name: 'a.exe', cmd: 'a' })
    expect(c.classify(1)).toBe('other')
  })
})

describe('parseRoleSpec', () => {
  it('parses the documented forms', () => {
    expect(parseRoleSpec('forge=cmd:launch.py')).toEqual({ role: 'forge', rule: { cmd: 'launch.py' } })
    expect(parseRoleSpec('stage=name:chrome.exe;cmd:my profile')).toEqual({
      role: 'stage',
      rule: { name: 'chrome.exe', cmd: 'my profile' },
    })
    expect(parseRoleSpec('x=pid:12')).toEqual({ role: 'x', rule: { pid: 12 } })
  })
  it('rejects malformed specs', () => {
    expect(() => parseRoleSpec('nonsense')).toThrow()
    expect(() => parseRoleSpec('a=foo:bar')).toThrow(/unknown/)
    expect(() => parseRoleSpec('a=pid:abc')).toThrow(/pid/)
    expect(() => parseRoleSpec('a=cmd')).toThrow()
  })
  it('mergeRoles appends rules to a role without mutating the base', () => {
    const base = { forge: [{ cmd: 'x' }] }
    const merged = mergeRoles(base, [parseRoleSpec('forge=cmd:y'), parseRoleSpec('new=cmd:z')])
    expect(merged.forge).toEqual([{ cmd: 'x' }, { cmd: 'y' }])
    expect(merged.new).toEqual([{ cmd: 'z' }])
    expect(base.forge).toEqual([{ cmd: 'x' }])
  })
})
