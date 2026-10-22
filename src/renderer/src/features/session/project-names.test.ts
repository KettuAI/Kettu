import { describe, expect, it } from 'vitest'
import { nameHints } from './project-names'

describe('nameHints', () => {
  it('leaves names no other project shares alone', () => {
    expect(nameHints(['/Users/me/dev/bucky', '/Users/me/dev/kite'])).toEqual(new Map())
  })

  it('names the parent folder of projects that share a name', () => {
    const hints = nameHints(['/Users/me/work/api', '/Users/me/dev/api', '/Users/me/dev/kite'])
    expect(hints).toEqual(
      new Map([
        ['/Users/me/work/api', 'work'],
        ['/Users/me/dev/api', 'dev'],
      ]),
    )
  })

  it('goes up until the parents differ', () => {
    const hints = nameHints(['/a/client/src/api', '/b/client/src/api'])
    expect(hints.get('/a/client/src/api')).toBe('a/client/src')
    expect(hints.get('/b/client/src/api')).toBe('b/client/src')
  })

  it('reads Windows paths and trailing separators', () => {
    const hints = nameHints(['C:\\work\\api\\', 'D:\\dev\\api'])
    expect(hints.get('C:\\work\\api\\')).toBe('work')
    expect(hints.get('D:\\dev\\api')).toBe('dev')
  })

  it('gives a project at the top of the disk no hint', () => {
    const hints = nameHints(['/api', '/srv/api'])
    expect(hints.has('/api')).toBe(false)
    expect(hints.get('/srv/api')).toBe('srv')
  })
})
