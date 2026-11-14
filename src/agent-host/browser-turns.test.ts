import { describe, expect, it } from 'vitest'
import { BrowserTurns } from './browser-turns'

const MAIN = { kind: 'main' } as const
const APP = { kind: 'device', portId: 'port-1' } as const

describe('BrowserTurns', () => {
  it('ends a page with the turn that used it', () => {
    const turns = new BrowserTurns()
    turns.used('s1', 's1', MAIN)
    turns.used('s1', 's1', MAIN)
    expect(turns.turnEnded('s2')).toEqual([])
    expect(turns.turnEnded('s1')).toEqual([{ page: 's1', target: MAIN }])
    // Told once: a later end of the same session's turn has no page left.
    expect(turns.turnEnded('s1')).toEqual([])
  })

  it("keeps a page while a subagent's turn still uses it", () => {
    const turns = new BrowserTurns()
    turns.used('parent', 'parent', MAIN)
    turns.used('sub', 'parent', MAIN)
    expect(turns.turnEnded('sub')).toEqual([])
    expect(turns.targetOf('parent')).toEqual(MAIN)
    expect(turns.turnEnded('parent')).toEqual([{ page: 'parent', target: MAIN }])
  })

  it("tells the app a page's calls left that its page has no turn", () => {
    const turns = new BrowserTurns()
    expect(turns.used('s1', 's1', APP)).toBeNull()
    expect(turns.used('s1', 's1', MAIN)).toEqual(APP)
    expect(turns.turnEnded('s1')).toEqual([{ page: 's1', target: MAIN }])
  })

  it("forgets an app's pages when its port closes", () => {
    const turns = new BrowserTurns()
    turns.used('s1', 's1', APP)
    turns.used('s2', 's2', MAIN)
    turns.portClosed('port-1')
    expect(turns.turnEnded('s1')).toEqual([])
    expect(turns.turnEnded('s2')).toEqual([{ page: 's2', target: MAIN }])
  })
})
