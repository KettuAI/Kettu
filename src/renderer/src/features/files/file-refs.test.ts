import { describe, expect, it } from 'vitest'
import { parseFileRef } from './file-refs'

const root = '/work/app'

describe('parseFileRef', () => {
  it('reads a relative path with an optional line', () => {
    expect(parseFileRef('src/x.ts', root)).toEqual({ path: 'src/x.ts', line: null })
    expect(parseFileRef('./src/x.ts:12', root)).toEqual({ path: 'src/x.ts', line: 12 })
    expect(parseFileRef('src/x.ts:12:5', root)).toEqual({ path: 'src/x.ts', line: 12 })
    expect(parseFileRef('src/x.ts#L7-L9', root)).toEqual({ path: 'src/x.ts', line: 7 })
    expect(parseFileRef('docs/a%20b.md', root)).toEqual({ path: 'docs/a b.md', line: null })
  })

  it('takes an absolute path inside the project, and nothing outside it', () => {
    expect(parseFileRef('/work/app/src/x.ts:3', root)).toEqual({ path: 'src/x.ts', line: 3 })
    expect(parseFileRef('/etc/hosts', root)).toBeNull()
    expect(parseFileRef('../other/x.ts', root)).toBeNull()
  })

  it('leaves URLs, anchors and prose alone', () => {
    expect(parseFileRef('https://example.com/x.ts', root)).toBeNull()
    expect(parseFileRef('#section', root)).toBeNull()
    expect(parseFileRef('npm run build', root)).toBeNull()
    expect(parseFileRef('', root)).toBeNull()
  })

  it('reads Windows paths inside a Windows project', () => {
    expect(parseFileRef('C:\\work\\app\\src\\x.ts:4', 'C:\\work\\app')).toEqual({
      path: 'src/x.ts',
      line: 4,
    })
  })
})
