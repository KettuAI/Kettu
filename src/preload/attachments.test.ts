import { describe, expect, it } from 'vitest'
import { filePaths } from './attachments'

describe('filePaths', () => {
  const pathOf = (file: File) => (file.name === 'pasted' ? '' : `/drop/${file.name}`)

  it('reads the path of each file, in order', () => {
    const files = [new File(['a'], 'a.md'), new File(['b'], 'pasted')]
    expect(filePaths(files, pathOf)).toEqual(['/drop/a.md', ''])
  })

  it('takes nothing but a list of files, so a page cannot name a path itself', () => {
    const forged = { map: () => ['/Users/me/.ssh/id_rsa'] }
    expect(() => filePaths(forged, pathOf)).toThrow()
    expect(() => filePaths(['/Users/me/.ssh/id_rsa'], pathOf)).toThrow()
    expect(() => filePaths([{ name: 'a.md' }], pathOf)).toThrow()
    expect(() =>
      filePaths(
        Array.from({ length: 21 }, () => new File([], 'a')),
        pathOf,
      ),
    ).toThrow()
  })
})
