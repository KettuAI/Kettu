import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'
import type { SessionNode } from '@renderer/stores/sessions'
import { keepInSight, limitRows, ROWS_SHOWN } from './row-limit'

const node = (id: string, extra: Partial<SessionNode> = {}): SessionNode => ({
  summary: { id } as SessionSummary,
  children: [],
  subagents: [],
  permissionCount: 0,
  running: false,
  own: { permissionCount: 0, running: false },
  ...extra,
})

const tree = Array.from({ length: ROWS_SHOWN + 4 }, (_, i) => node(`s${i}`))

describe('limitRows', () => {
  it('shows the first few and counts the rest', () => {
    const { rows, hidden } = limitRows(tree, false, () => false)
    expect(rows.map((n) => n.summary.id)).toEqual(['s0', 's1', 's2', 's3', 's4'])
    expect(hidden).toBe(4)
  })

  it('keeps a row past them in sight when it must stay', () => {
    const { rows, hidden } = limitRows(tree, false, (n) => n.summary.id === 's7')
    expect(rows.map((n) => n.summary.id)).toContain('s7')
    expect(hidden).toBe(3)
  })

  it('shows every row when asked, and a short list whole', () => {
    expect(limitRows(tree, true, () => false)).toEqual({ rows: tree, hidden: 0 })
    expect(limitRows(tree.slice(0, 3), false, () => false).hidden).toBe(0)
  })
})

describe('keepInSight', () => {
  it('keeps what waits, runs or is in front, a sub-session in front included', () => {
    expect(keepInSight(node('a', { permissionCount: 1 }), null)).toBe(true)
    expect(keepInSight(node('a', { running: true }), null)).toBe(true)
    expect(keepInSight(node('a'), 'a')).toBe(true)
    expect(keepInSight(node('a', { children: [node('b')] }), 'b')).toBe(true)
    expect(keepInSight(node('a'), 'b')).toBe(false)
  })
})
