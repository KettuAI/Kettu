// The bookkeeping of a session's tabs, apart from the pages in them: their order, the tab the
// pane shows, the tab the agent works in, which page opened which, and which pages are released
// to stay within the live limit.

/** Live pages across every session at once; the least recently shown idle one is released. */
export const MAX_LIVE_TABS = 8

export interface StripTab {
  id: string
  /** The tab whose page opened this one with `window.open`, while that tab is open. */
  opener: string | null
}

export interface AddTab {
  /** Puts the tab right after this one; at the end by default. */
  after?: string | null
  opener?: string | null
  /** The pane shows it. */
  select: boolean
  /** It becomes the agent's current tab. */
  agent: boolean
}

/**
 * One session's strip. The user selects what the pane shows; the agent has its own current tab,
 * which the user's selecting never changes. A popup sits right after its opener, and when it
 * closes the opener takes its place for the pane and for the agent.
 */
export class TabStrip {
  private list: StripTab[] = []
  private chosen: string | null = null
  private agentTab: string | null = null

  get tabs(): readonly StripTab[] {
    return this.list
  }

  get selected(): string | null {
    return this.chosen
  }

  /** The tab the agent's own calls opened or used last; null until it uses one. */
  get agent(): string | null {
    return this.agentTab
  }

  get size(): number {
    return this.list.length
  }

  has(id: string): boolean {
    return this.list.some((tab) => tab.id === id)
  }

  indexOf(id: string): number {
    return this.list.findIndex((tab) => tab.id === id)
  }

  at(index: number): StripTab | null {
    return Number.isInteger(index) ? (this.list[index] ?? null) : null
  }

  opener(id: string): string | null {
    return this.list.find((tab) => tab.id === id)?.opener ?? null
  }

  add(id: string, how: AddTab): void {
    if (this.has(id)) throw new Error(`Tab ${id} is already open`)
    const opener = how.opener && this.has(how.opener) ? how.opener : null
    const after = how.after ? this.indexOf(how.after) : -1
    const tab: StripTab = { id, opener }
    if (after === -1) this.list.push(tab)
    else this.list.splice(after + 1, 0, tab)
    if (how.select || this.chosen === null) this.chosen = id
    if (how.agent) this.agentTab = id
  }

  select(id: string): boolean {
    if (!this.has(id) || this.chosen === id) return false
    this.chosen = id
    return true
  }

  setAgent(id: string | null): void {
    if (id === null || this.has(id)) this.agentTab = id
  }

  /**
   * The tab the agent's calls act on: its own, else the one the pane shows, which it then keeps
   * as its own so the user's next selection does not move it.
   */
  agentTarget(): string | null {
    if (this.agentTab === null && this.chosen !== null) this.agentTab = this.chosen
    return this.agentTab
  }

  /**
   * Closes a tab. The pane then shows the tab's opener when it is still open, else its neighbour
   * on the left, else on the right; the agent goes back to the opener, or has no tab.
   */
  remove(id: string): void {
    const index = this.indexOf(id)
    if (index === -1) return
    const { opener } = this.list[index]
    this.list.splice(index, 1)
    for (const tab of this.list) if (tab.opener === id) tab.opener = null
    if (this.agentTab === id) this.agentTab = opener
    if (this.chosen !== id) return
    this.chosen = opener ?? this.list[index - 1]?.id ?? this.list[index]?.id ?? null
  }

  clear(): void {
    this.list = []
    this.chosen = null
    this.agentTab = null
  }
}

export interface LiveTab {
  id: string
  /** It has a page now. */
  live: boolean
  /** When the pane last showed it, in ms since the epoch. */
  lastShown: number
  /** On screen, the agent's in a turn that uses it, or the one being made: never released. */
  keep: boolean
}

/**
 * The tabs to release so that one more page fits under `max`: the least recently shown live ones
 * that nothing keeps, oldest first. Fewer when the kept ones alone fill the limit.
 */
export function tabsToRelease(tabs: Iterable<LiveTab>, max = MAX_LIVE_TABS): string[] {
  const live = [...tabs].filter((tab) => tab.live)
  const over = live.length - (max - 1)
  if (over <= 0) return []
  return live
    .filter((tab) => !tab.keep)
    .sort((a, b) => a.lastShown - b.lastShown)
    .slice(0, over)
    .map((tab) => tab.id)
}

/** A tab as `browser_tabs` answers it. */
export interface ListedTab {
  index: number
  url: string
  title: string
  /** The agent's current tab, which its other tools act on. */
  current: boolean
  /** Released to save memory: selecting it loads it again. */
  released: boolean
}

export function listTabs(
  tabs: readonly { id: string; url: string | null; title: string | null; released: boolean }[],
  current: string | null,
): ListedTab[] {
  return tabs.map((tab, index) => ({
    index,
    url: tab.url ?? 'about:blank',
    title: tab.title ?? '',
    current: tab.id === current,
    released: tab.released,
  }))
}

/** The tabs as lines an agent reads, one per tab, the current one marked. */
export function tabsText(tabs: readonly ListedTab[]): string {
  if (tabs.length === 0) return 'The browser has no tabs. Open one with browser_navigate.'
  return tabs
    .map((tab) => {
      const marks = [tab.current ? '(current)' : '', tab.released ? '(released)' : '']
        .filter(Boolean)
        .join(' ')
      const title = tab.title ? ` "${tab.title}"` : ''
      return `- ${tab.index}:${marks ? ` ${marks}` : ''}${title} ${tab.url}`
    })
    .join('\n')
}
