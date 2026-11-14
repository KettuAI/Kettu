import { describe, expect, it } from 'vitest'
import { listTabs, MAX_LIVE_TABS, TabStrip, tabsText, tabsToRelease } from './tabs'

function strip(...ids: string[]): TabStrip {
  const tabs = new TabStrip()
  for (const id of ids) tabs.add(id, { select: false, agent: false })
  return tabs
}

describe('TabStrip', () => {
  it('selects the first tab of an empty strip, and a new one only when asked', () => {
    const tabs = strip('a', 'b')
    expect(tabs.selected).toBe('a')
    tabs.add('c', { select: true, agent: false })
    expect(tabs.tabs.map((tab) => tab.id)).toEqual(['a', 'b', 'c'])
    expect(tabs.selected).toBe('c')
  })

  it('puts a popup right after its opener and keeps the opener', () => {
    const tabs = strip('a', 'b', 'c')
    tabs.add('p', { after: 'a', opener: 'a', select: true, agent: false })
    expect(tabs.tabs.map((tab) => tab.id)).toEqual(['a', 'p', 'b', 'c'])
    expect(tabs.opener('p')).toBe('a')
  })

  it('drops an opener that is no longer open', () => {
    const tabs = strip('a')
    tabs.add('p', { opener: 'gone', select: false, agent: false })
    expect(tabs.opener('p')).toBeNull()
  })

  it('goes back to the opener when a popup closes, for the pane and the agent', () => {
    const tabs = strip('a', 'b')
    tabs.setAgent('b')
    tabs.add('p', { after: 'b', opener: 'b', select: true, agent: true })
    tabs.select('a')
    tabs.select('p')
    tabs.remove('p')
    expect(tabs.selected).toBe('b')
    expect(tabs.agent).toBe('b')
  })

  it('selects the left neighbour, else the right, when a tab without an opener closes', () => {
    const tabs = strip('a', 'b', 'c')
    tabs.select('b')
    tabs.remove('b')
    expect(tabs.selected).toBe('a')
    tabs.remove('a')
    expect(tabs.selected).toBe('c')
    tabs.remove('c')
    expect(tabs.selected).toBeNull()
  })

  it('forgets an opener that closes before its popup', () => {
    const tabs = strip('a')
    tabs.add('p', { after: 'a', opener: 'a', select: true, agent: false })
    tabs.remove('a')
    expect(tabs.opener('p')).toBeNull()
    expect(tabs.selected).toBe('p')
  })

  it('keeps the agent’s tab when the user selects another', () => {
    const tabs = strip('a', 'b')
    tabs.setAgent('a')
    tabs.select('b')
    expect(tabs.agent).toBe('a')
    expect(tabs.agentTarget()).toBe('a')
  })

  it('gives the agent the selected tab until it has its own, then keeps it', () => {
    const tabs = strip('a', 'b')
    tabs.select('b')
    expect(tabs.agent).toBeNull()
    expect(tabs.agentTarget()).toBe('b')
    tabs.select('a')
    expect(tabs.agentTarget()).toBe('b')
  })

  it('makes a tab the agent opens its current tab, and one the user opens not', () => {
    const tabs = strip('a')
    tabs.setAgent('a')
    tabs.add('u', { select: true, agent: false })
    expect(tabs.agent).toBe('a')
    tabs.add('n', { select: false, agent: true })
    expect(tabs.agent).toBe('n')
    expect(tabs.selected).toBe('u')
  })

  it('leaves the agent without a tab when its own closes', () => {
    const tabs = strip('a', 'b')
    tabs.setAgent('b')
    tabs.remove('b')
    expect(tabs.agent).toBeNull()
    expect(tabs.agentTarget()).toBe('a')
  })

  it('refuses a tab id twice and a selection of a closed tab', () => {
    const tabs = strip('a')
    expect(() => tabs.add('a', { select: false, agent: false })).toThrow()
    expect(tabs.select('x')).toBe(false)
    tabs.setAgent('x')
    expect(tabs.agent).toBeNull()
  })

  it('finds tabs by index only for whole numbers in range', () => {
    const tabs = strip('a', 'b')
    expect(tabs.at(1)?.id).toBe('b')
    expect(tabs.at(2)).toBeNull()
    expect(tabs.at(0.5)).toBeNull()
    expect(tabs.at(-1)).toBeNull()
  })
})

describe('tabsToRelease', () => {
  const live = (id: string, lastShown: number, keep = false) => ({
    id,
    live: true,
    lastShown,
    keep,
  })

  it('releases nothing while one more page fits', () => {
    const tabs = Array.from({ length: MAX_LIVE_TABS - 1 }, (_, i) => live(`t${i}`, i))
    expect(tabsToRelease(tabs)).toEqual([])
  })

  it('releases the least recently shown page that nothing keeps', () => {
    const tabs = Array.from({ length: MAX_LIVE_TABS }, (_, i) => live(`t${i}`, 100 + i))
    tabs[0] = live('t0', 100, true)
    expect(tabsToRelease(tabs)).toEqual(['t1'])
  })

  it('counts only live pages', () => {
    const tabs = [
      ...Array.from({ length: MAX_LIVE_TABS - 1 }, (_, i) => live(`t${i}`, i)),
      { id: 'released', live: false, lastShown: 0, keep: false },
    ]
    expect(tabsToRelease(tabs)).toEqual([])
  })

  it('releases fewer when the kept pages alone fill the limit', () => {
    const tabs = Array.from({ length: 3 }, (_, i) => live(`t${i}`, i, true))
    expect(tabsToRelease(tabs, 2)).toEqual([])
    expect(tabsToRelease([...tabs, live('x', 9)], 2)).toEqual(['x'])
  })

  it('releases as many as it takes, oldest first', () => {
    const tabs = [live('a', 30), live('b', 10), live('c', 20), live('d', 40)]
    expect(tabsToRelease(tabs, 2)).toEqual(['b', 'c', 'a'])
  })
})

describe('the tab list an agent reads', () => {
  it('numbers the tabs in order and marks the current and released ones', () => {
    const listed = listTabs(
      [
        { id: 'a', url: 'http://localhost:5173/', title: 'App', released: false },
        { id: 'b', url: null, title: null, released: false },
        { id: 'c', url: 'https://example.com/', title: 'Example', released: true },
      ],
      'b',
    )
    expect(listed).toEqual([
      { index: 0, url: 'http://localhost:5173/', title: 'App', current: false, released: false },
      { index: 1, url: 'about:blank', title: '', current: true, released: false },
      { index: 2, url: 'https://example.com/', title: 'Example', current: false, released: true },
    ])
    expect(tabsText(listed)).toBe(
      [
        '- 0: "App" http://localhost:5173/',
        '- 1: (current) about:blank',
        '- 2: (released) "Example" https://example.com/',
      ].join('\n'),
    )
  })

  it('says when there are no tabs', () => {
    expect(tabsText([])).toMatch(/no tabs/)
  })
})
