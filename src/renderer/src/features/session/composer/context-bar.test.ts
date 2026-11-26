import { describe, expect, it } from 'vitest'
import type { ContextBreakdown, ContextReport } from '@shared/context'
import {
  barSegments,
  breakdownView,
  contextRows,
  contextSegments,
  contextSummary,
  formatPartShare,
  partFill,
  showContextEstimates,
  shownUsage,
} from './context-bar'

const SAMPLE_CATEGORIES: ContextBreakdown['categories'] = [
  { name: 'System prompt', tokens: 5_200, share: 2.6 },
  { name: 'System tools', tokens: 18_600, share: 9.3 },
  { name: 'MCP tools', tokens: 14_800, share: 7.4 },
  { name: 'Memory files', tokens: 12_400, share: 6.2 },
  { name: 'Skills', tokens: 2_800, share: 1.4 },
  { name: 'Messages', tokens: 74_200, share: 37.1 },
  { name: 'Autocompact buffer', tokens: 16_000, share: 8.0 },
  { name: 'Free space', tokens: 56_000, share: 28.0 },
]

describe('context-bar', () => {
  it('orders breakdown categories with primary colors, grays, buffer, and free space', () => {
    const rows = contextRows(SAMPLE_CATEGORIES)
    expect(rows.map((r) => [r.name, r.part])).toEqual([
      ['Messages', { kind: 'source', color: 1 }],
      ['Memory files', { kind: 'source', color: 2 }],
      ['System tools', { kind: 'source', color: 3 }],
      ['MCP tools', { kind: 'source', color: 4 }],
      ['System prompt', { kind: 'source', color: 5 }],
      ['Skills', { kind: 'source', color: 6 }],
      ['Autocompact buffer', { kind: 'buffer' }],
      ['Free space', { kind: 'free' }],
    ])
  })

  it('computes compact summary totals excluding reserved buffer from used tokens', () => {
    const rows = contextRows(SAMPLE_CATEGORIES)
    const summary = contextSummary({ used: 128_000, size: 200_000 }, rows)
    expect(summary).toEqual({
      used: 128_000,
      reserved: 16_000,
      cap: 200_000,
      free: 56_000,
      over: 0,
      share: 0.64,
      percent: 64,
      level: 'ok',
    })
  })

  it('computes summary warning and full thresholds without breakdown rows', () => {
    expect(contextSummary({ used: 396_300, size: 1_048_576 }, null)).toMatchObject({
      used: 396_300,
      reserved: 0,
      cap: 1_048_576,
      free: 652_276,
      over: 0,
      percent: 38,
      level: 'ok',
    })

    expect(contextSummary({ used: 160_000, size: 200_000 }, null)).toMatchObject({
      percent: 80,
      free: 40_000,
      level: 'warn',
    })

    expect(contextSummary({ used: 206_000, size: 200_000 }, null)).toMatchObject({
      percent: 103,
      free: 0,
      over: 6_000,
      level: 'full',
    })

    expect(contextSummary({ used: 0, size: 0 }, null)).toEqual({
      used: 0,
      reserved: 0,
      cap: 0,
      free: 0,
      over: 0,
      share: 0,
      percent: 0,
      level: 'ok',
    })
  })

  it('builds single-segment and multi-segment progress bar widths within 100%', () => {
    expect(barSegments(null, 0, 200_000)).toEqual([])
    expect(barSegments(null, 128_000, 200_000)).toEqual([
      { key: 'used', part: { kind: 'used' }, tokens: 128_000, widthPercent: 64 },
    ])
    // Clamps overflow to 100% in summary-only mode.
    expect(barSegments(null, 240_000, 200_000)).toEqual([
      { key: 'used', part: { kind: 'used' }, tokens: 240_000, widthPercent: 100 },
    ])

    const rows = contextRows(SAMPLE_CATEGORIES)
    const segments = barSegments(rows, 128_000, 200_000)
    // Excludes Free space while keeping source parts and Autocompact buffer.
    expect(segments.map((s) => s.key)).toEqual([
      'Messages',
      'Memory files',
      'System tools',
      'MCP tools',
      'System prompt',
      'Skills',
      'Autocompact buffer',
    ])
    const totalWidth = segments.reduce((sum, s) => sum + s.widthPercent, 0)
    expect(totalWidth).toBeCloseTo(72, 5)

    // Scales down proportionally when occupied tokens exceed the window limit.
    const overflowRows = contextRows([
      { name: 'Messages', tokens: 180_000, share: 90 },
      { name: 'System tools', tokens: 60_000, share: 30 },
    ])
    const scaled = barSegments(overflowRows, 240_000, 200_000)
    expect(scaled.map((s) => s.widthPercent)).toEqual([75, 25])
  })

  it('formats per-part share labels compactly', () => {
    expect(formatPartShare(0, 200_000)).toBe('0%')
    expect(formatPartShare(500, 200_000)).toBe('<1%')
    expect(formatPartShare(2_800, 200_000)).toBe('1%')
    expect(formatPartShare(74_200, 200_000)).toBe('37%')
    expect(formatPartShare(10_000, 0)).toBe('0%')
  })

  it('keeps shownUsage, partFill, contextSegments, and breakdownView behavior intact', () => {
    const breakdown: ContextBreakdown = {
      model: 'Claude Opus 4.6',
      used: 128_000,
      size: 200_000,
      categories: SAMPLE_CATEGORIES,
      lists: [],
      observedAt: 1_000,
    }
    expect(shownUsage({ used: 0, size: 0, tokens: null, cost: null }, breakdown)).toMatchObject({
      used: 128_000,
      size: 200_000,
    })
    expect(partFill({ kind: 'source', color: 1 })).toBe('bg-context-1')
    expect(partFill({ kind: 'buffer' })).toBe('bg-(image:--context-hatch)')
    expect(contextSegments(null, 50_000, 200_000)).toHaveLength(2)

    const report: ContextReport = {
      key: '128000/200000',
      breakdown,
      loading: false,
      error: null,
    }
    expect(
      breakdownView(report, '128000/200000', { reports: true, idle: true, live: false }).kind,
    ).toBe('rows')
    expect(
      breakdownView(undefined, '128000/200000', { reports: false, idle: true, live: false }),
    ).toEqual({
      kind: 'none',
    })
  })

  it('returns none on idle when a finished read has no breakdown, and shows estimates only as fallback', () => {
    const emptyDone: ContextReport = {
      key: '10000/512000',
      breakdown: null,
      loading: false,
      error: null,
    }
    const emptyView = breakdownView(emptyDone, '10000/512000', {
      reports: true,
      idle: true,
      live: false,
    })
    expect(emptyView).toEqual({ kind: 'none' })
    expect(showContextEstimates(true, emptyView)).toBe(true)

    // 另一组 key 尚未读取完时仍应处于 loading，且不提前闪现估算区块。
    const staleEmpty = breakdownView(emptyDone, '20000/512000', {
      reports: true,
      idle: true,
      live: false,
    })
    expect(staleEmpty).toEqual({ kind: 'loading' })
    expect(showContextEstimates(true, staleEmpty)).toBe(false)

    // 已有精确上下文明细时隐藏估算区块，避免重复展示。
    const rowsView = breakdownView(
      {
        key: '128000/200000',
        breakdown: {
          model: 'Gemini 4 Neon',
          used: 128_000,
          size: 200_000,
          categories: SAMPLE_CATEGORIES,
          lists: [],
          observedAt: 1_000,
        },
        loading: false,
        error: null,
      },
      '128000/200000',
      { reports: true, idle: true, live: false },
    )
    expect(rowsView.kind).toBe('rows')
    expect(showContextEstimates(true, rowsView)).toBe(false)

    // 仅不支持精确拆分的智能体（如 Codex）或读取失败时显示估算；未开启 estimates 时一律隐藏。
    expect(showContextEstimates(true, { kind: 'error', error: 'timeout' })).toBe(true)
    expect(showContextEstimates(true, { kind: 'betweenTurns' })).toBe(false)
    expect(showContextEstimates(false, { kind: 'none' })).toBe(false)
    expect(showContextEstimates(undefined, { kind: 'none' })).toBe(false)
  })
})
