import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImportableSession } from '@shared/agent-host'
import { i18n } from '@renderer/lib/i18n'
import {
  allSelected,
  type AgentList,
  importableKeys,
  importInOrder,
  importKey,
  listed,
  markImported,
  selectedSessions,
  sessionAgo,
  shownAgent,
  withKeys,
} from './import-sessions-model'

const session = (id: string, imported = false): ImportableSession => ({
  acpSessionId: id,
  title: id,
  updatedAt: null,
  imported,
})

const list = (sessions: ImportableSession[], extra: Partial<AgentList> = {}): AgentList => ({
  sessions,
  nextCursor: null,
  loading: false,
  error: null,
  ...extra,
})

afterEach(() => i18n.changeLanguage('en'))

describe('listed', () => {
  it('knows a list once its first page came, and not while it loads or after it failed', () => {
    expect(listed(undefined)).toBe(false)
    expect(listed(list([], { loading: true }))).toBe(false)
    expect(listed(list([], { error: 'No' }))).toBe(false)
    expect(listed(list([]))).toBe(true)
    // Loading a further page keeps the first one's count.
    expect(listed(list([session('a')], { loading: true }))).toBe(true)
  })
})

describe('shownAgent', () => {
  const agents = ['claude-code', 'codex', 'opencode'] as const

  it('keeps the tab chosen', () => {
    expect(shownAgent(agents, {}, 'codex')).toBe('codex')
  })

  it('starts on the first agent whose list is not known to be empty', () => {
    expect(shownAgent(agents, {}, null)).toBe('claude-code')
    expect(shownAgent(agents, { 'claude-code': list([]) }, null)).toBe('codex')
    // A list still loading or failed keeps its place.
    expect(shownAgent(agents, { 'claude-code': list([], { loading: true }) }, null)).toBe(
      'claude-code',
    )
    expect(shownAgent(agents, { 'claude-code': list([], { error: 'No' }) }, null)).toBe(
      'claude-code',
    )
  })

  it('falls back to the first agent when every list is empty', () => {
    const empty = { 'claude-code': list([]), codex: list([]), opencode: list([]) }
    expect(shownAgent(agents, empty, null)).toBe('claude-code')
    expect(shownAgent([], {}, null)).toBeNull()
  })

  it('ignores a choice that is no longer listed', () => {
    expect(shownAgent(['codex'], {}, 'claude-code')).toBe('codex')
  })
})

describe('selection', () => {
  const lists = {
    'claude-code': list([session('a'), session('b', true), session('c')]),
    codex: list([session('a')]),
  }

  it('selects only sessions not imported yet', () => {
    expect(importableKeys('claude-code', lists['claude-code'])).toEqual([
      importKey('claude-code', 'a'),
      importKey('claude-code', 'c'),
    ])
    expect(importableKeys('codex', undefined)).toEqual([])
  })

  it('tells all selected from some, and none to select from all', () => {
    const keys = importableKeys('claude-code', lists['claude-code'])
    expect(allSelected(keys, new Set(keys))).toBe(true)
    expect(allSelected(keys, new Set([keys[0]!]))).toBe(false)
    expect(allSelected([], new Set())).toBe(false)
  })

  it('selects all of one tab without touching another', () => {
    const codex = importKey('codex', 'a')
    const keys = importableKeys('claude-code', lists['claude-code'])
    const on = withKeys(new Set([codex]), keys, true)
    expect([...on].sort()).toEqual([...keys, codex].sort())
    expect([...withKeys(on, keys, false)]).toEqual([codex])
  })

  it('lists what to import across tabs, in order, without the imported', () => {
    const selected = new Set([
      importKey('codex', 'a'),
      importKey('claude-code', 'c'),
      importKey('claude-code', 'b'),
      importKey('claude-code', 'a'),
    ])
    expect(selectedSessions(['claude-code', 'codex'], lists, selected)).toEqual([
      { agentId: 'claude-code', acpSessionId: 'a' },
      { agentId: 'claude-code', acpSessionId: 'c' },
      { agentId: 'codex', acpSessionId: 'a' },
    ])
  })

  it('marks one session imported in its own agent only', () => {
    const next = markImported(lists, 'codex', 'a')
    expect(next.codex?.sessions[0]?.imported).toBe(true)
    expect(next['claude-code']?.sessions[0]?.imported).toBe(false)
    expect(markImported(lists, 'opencode', 'a')).toBe(lists)
  })
})

describe('importInOrder', () => {
  it('imports one at a time and returns the ones that failed', async () => {
    const order: string[] = []
    let running = 0
    const failed = await importInOrder(
      ['a', 'b', 'c'],
      async (item) => {
        running += 1
        expect(running).toBe(1)
        await Promise.resolve()
        order.push(item)
        running -= 1
        return item !== 'b'
      },
      () => true,
    )
    expect(order).toEqual(['a', 'b', 'c'])
    expect(failed).toEqual(['b'])
  })

  it('stops before the next once the dialog closed', async () => {
    let open = true
    const run = vi.fn(async (item: string) => {
      if (item === 'a') open = false
      return true
    })
    await importInOrder(['a', 'b'], run, () => open)
    expect(run.mock.calls.map(([item]) => item)).toEqual(['a'])
  })
})

describe('sessionAgo', () => {
  const NOW = Date.UTC(2026, 9, 21, 12)
  const MINUTE = 60_000
  const DAY = 24 * 60 * MINUTE

  it('counts minutes, hours, days and weeks, then gives the date', () => {
    expect(sessionAgo(NOW - 20_000, NOW)).toBe('just now')
    expect(sessionAgo(NOW - 5 * MINUTE, NOW)).toBe('5 m ago')
    expect(sessionAgo(NOW - 3 * 60 * MINUTE, NOW)).toBe('3 h ago')
    expect(sessionAgo(NOW - 3 * DAY, NOW)).toBe('3 d ago')
    expect(sessionAgo(NOW - 15 * DAY, NOW)).toBe('2 w ago')
    expect(sessionAgo(NOW - 40 * DAY, NOW)).toBe('Sep 11')
    // A clock ahead of this one reads as now.
    expect(sessionAgo(NOW + MINUTE, NOW)).toBe('just now')
  })

  it('speaks Chinese', async () => {
    await i18n.changeLanguage('zh-CN')
    expect(sessionAgo(NOW - 3 * DAY, NOW)).toBe('3 天前')
  })
})
