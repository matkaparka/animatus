import { describe, expect, it } from 'vitest'
import { judge, readNpmLock, readPythonMetadata, summarise } from './rules.mjs'

const cls = (s) => judge(s).class

describe('judge', () => {
  it('takes the permissive licences, whatever the case or the spelling', () => {
    for (const l of [
      '3-Clause BSD License',
      'MIT-CMU',
      'PSF',
      'MIT',
      'mit',
      'ISC',
      'BSD-3-Clause',
      'BSD',
      'Apache-2.0',
      'Apache 2.0',
      '0BSD',
      'Unlicense',
      'CC0-1.0',
      'BlueOak-1.0.0',
      'Python-2.0',
      'MIT License',
      'BSD License',
    ])
      expect(cls(l), l).toBe('permissive')
  })

  it('weak copyleft is fine to depend on but is called what it is', () => {
    for (const l of [
      'MPL-2.0',
      'LGPL-3.0-or-later',
      'LGPL-2.1',
      'Mozilla Public License 2.0 (MPL 2.0)',
      'GNU Lesser General Public License v3 (LGPLv3)',
    ])
      expect(cls(l), l).toBe('weak-copyleft')
  })

  it('copyleft, network copyleft, non-commercial, source-available, proprietary and nothing at all need a person', () => {
    for (const l of [
      'GPL-3.0',
      'GPL-2.0-only',
      'AGPL-3.0',
      'GNU General Public License v3 (GPLv3)',
      'SSPL-1.0',
      'CC-BY-NC-4.0',
      'CC-BY-NC-SA-4.0',
      'PolyForm-Noncommercial-1.0.0',
      'Commons Clause',
      'Proprietary',
      'UNLICENSED',
      'UNKNOWN',
      '',
      'SEE LICENSE IN LICENSE.txt',
    ]) {
      expect(cls(l), l).toBe('review')
    }
    expect(judge('AGPL-3.0').why).toBe('network copyleft')
    expect(judge('CC-BY-NC-4.0').why).toBe('non-commercial')
    expect(judge('').why).toBe('no licence stated')
    expect(judge('SEE LICENSE IN LICENSE.txt').why).toContain('does not know')
  })

  it('OR takes the most permissive way out, AND the strictest', () => {
    expect(cls('MIT OR GPL-3.0')).toBe('permissive')
    expect(cls('(MIT OR Apache-2.0)')).toBe('permissive')
    expect(cls('GPL-3.0 OR LGPL-3.0')).toBe('weak-copyleft')
    expect(cls('MIT AND GPL-3.0')).toBe('review')
    expect(cls('MIT AND MPL-2.0')).toBe('weak-copyleft')
    expect(cls('(BSD-3-Clause AND MIT)')).toBe('permissive')
  })

  it('a licence field that is a whole text is not guessed at', () => {
    expect(cls('x'.repeat(500))).toBe('review')
  })
})

describe('readNpmLock', () => {
  const lock = {
    packages: {
      '': { name: 'root' },
      'packages/orchestrator': { name: '@animatus/orchestrator' },
      'node_modules/zod': { version: '4.0.0', license: 'MIT' },
      'node_modules/@animatus/protocol': { resolved: 'packages/protocol', link: true },
      'node_modules/@types/node': { version: '24.0.0', license: 'MIT', dev: true },
      'node_modules/vite/node_modules/esbuild': {
        version: '0.25.0',
        license: 'MIT',
        devOptional: true,
      },
      'node_modules/odd': { version: '1.0.0', license: { type: 'ISC', url: 'x' } },
      'node_modules/two': { version: '1.0.0', license: ['MIT', 'Apache-2.0'] },
      'node_modules/none': { version: '1.0.0' },
    },
  }
  it('lists what is installed, with its licence, and whether it is only for development', () => {
    const list = readNpmLock(lock)
    expect(list.map((p) => [p.name, p.license, p.dev])).toEqual([
      ['@types/node', 'MIT', true],
      ['esbuild', 'MIT', true],
      ['none', '', false],
      ['odd', 'ISC', false],
      ['two', 'MIT OR Apache-2.0', false],
      ['zod', 'MIT', false],
    ])
  })
})

describe('readPythonMetadata', () => {
  it('reads the PEP 639 expression, then the older field, then the classifiers', () => {
    expect(
      readPythonMetadata(
        'Name: a\nVersion: 1.0\nLicense-Expression: MIT\nLicense: whatever\n\nbody'
      )
    ).toEqual({ name: 'a', version: '1.0', license: 'MIT' })
    expect(readPythonMetadata('Name: b\nVersion: 2\nLicense: Apache-2.0\n\nbody').license).toBe(
      'Apache-2.0'
    )
    expect(
      readPythonMetadata(
        'Name: c\nVersion: 3\nLicense: UNKNOWN\nClassifier: License :: OSI Approved :: MIT License\n\nbody'
      ).license
    ).toBe('MIT')
    expect(
      readPythonMetadata(
        'Name: d\nVersion: 3\nClassifier: License :: OSI Approved :: BSD License\nClassifier: License :: OSI Approved :: Apache Software License\n\nbody'
      ).license
    ).toBe('BSD OR Apache Software')
    expect(
      readPythonMetadata(
        'Name: e\nVersion: 1\n\nLicense: MIT (this is in the body, not the header)'
      ).license
    ).toBe('')
  })
})

describe('summarise', () => {
  it('counts by licence, names a few, and lists what needs a look', () => {
    const s = summarise([
      { name: 'a', version: '1', license: 'MIT', dev: false },
      { name: 'b', version: '1', license: 'MIT', dev: false },
      { name: 'c', version: '1', license: 'GPL-3.0', dev: false },
      { name: 'd', version: '1', license: 'MPL-2.0', dev: false },
      { name: 'e', version: '1', license: '', dev: false },
    ])
    expect(s.total).toBe(5)
    expect(s.review.map((r) => r.name)).toEqual(['c', 'e'])
    expect(s.weak.map((r) => r.name)).toEqual(['d'])
    expect(s.licenses[0]).toMatchObject({ license: 'MIT', count: 2, class: 'permissive' })
    expect(s.licenses.map((l) => l.license)).toContain('(none stated)')
  })
})
