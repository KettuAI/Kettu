import { describe, expect, it } from 'vitest'
import { PAGE_ERRORS_PER_SECOND, PageErrorLog } from './page-errors'
import { PAGE_ERRORS, type PageErrorMessage } from './page-messages'

const report = (load: string, n: number, path = 'index.html'): PageErrorMessage => ({
  v: 1,
  id: `k${n}`,
  kind: 'page-error',
  path,
  load,
  error: { kind: 'error', message: `Error ${n}`, source: null, line: n, column: 1 },
})

describe("the log of a page's errors", () => {
  it('keeps a few of the latest load, counts the rest and ignores a load it replaced', () => {
    let now = 0
    const log = new PageErrorLog(() => now)
    for (let n = 0; n < PAGE_ERRORS + 5; n++) {
      now += 1000
      log.add('o', report('loadAAAA1', n))
    }
    const [page] = log.of('o')
    expect(page!.errors).toHaveLength(PAGE_ERRORS)
    expect(page!.dropped).toBe(5)
    log.add('o', report('loadBBBB2', 0))
    expect(log.of('o')[0]!.errors).toHaveLength(1)
    // A late report of the load the page left changes nothing.
    expect(log.add('o', report('loadAAAA1', 99))).toBe(false)
    expect(log.of('o')[0]!.load).toBe('loadBBBB2')
  })

  it('takes only so many reports a second from one page', () => {
    const log = new PageErrorLog(() => 5000)
    for (let n = 0; n < PAGE_ERRORS_PER_SECOND + 3; n++) log.add('o', report('loadAAAA1', n))
    const [page] = log.of('o')
    expect(page!.errors).toHaveLength(PAGE_ERRORS_PER_SECOND)
    expect(page!.dropped).toBe(3)
  })

  it('keeps each page apart, and forgets one or every page of an origin', () => {
    const log = new PageErrorLog(() => 0)
    log.add('o', report('loadAAAA1', 1, 'a.html'))
    log.add('o', report('loadAAAA1', 1, 'b.html'))
    log.add('p', report('loadAAAA1', 1))
    expect(log.of('o').map((p) => p.path)).toEqual(['a.html', 'b.html'])
    log.clear('o', 'a.html')
    expect(log.of('o').map((p) => p.path)).toEqual(['b.html'])
    log.clear('o')
    expect(log.of('o')).toEqual([])
    expect(log.of('p')).toHaveLength(1)
  })
})
