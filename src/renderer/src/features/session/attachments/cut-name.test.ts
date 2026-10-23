import { describe, expect, it } from 'vitest'
import { cutName } from './cut-name'

describe('cutName', () => {
  it('keeps the end of the stem with the extension, so a cut name still ends as it does', () => {
    expect(cutName('ci-failure-2026-10-23-1042.log')).toEqual([
      'ci-failure-2026-10-23',
      '-1042.log',
    ])
    expect(cutName('Makefile')).toEqual(['Make', 'file'])
    expect(cutName('a.md')).toEqual(['a', '.md'])
    expect(cutName('.env')).toEqual(['.e', 'nv'])
  })
})
