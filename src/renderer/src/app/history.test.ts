import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'

vi.stubGlobal('window', { kettu: { perf: false, platform: 'darwin', client: 'desktop' } })

const { goToPlace, historyKey, historyPlaces, showHistory, toggleHistory, useHistoryDialog } =
  await import('./history')
const { useSessionsStore } = await import('@renderer/stores/sessions')
const { useViewStore, restoreLayout, openSession, openSettings, closeSettings, openUsage } =
  await import('@renderer/stores/view')
const { createLayout } = await import('@renderer/features/split/layout')

const summary = (id: string, archivedAt: number | null = null) =>
  ({ id, projectPath: '/repo', archivedAt }) as SessionSummary

const state = () => useViewStore.getState()

describe('the whole history', () => {
  it('opens with Mod+Y on macOS and Ctrl+H elsewhere, where Ctrl+Y redoes', () => {
    expect(historyKey('darwin')).toBe('y')
    expect(historyKey('win32')).toBe('h')
    expect(historyKey('linux')).toBe('h')
  })

  it('toggles, and opens over nothing else', () => {
    showHistory(false)
    toggleHistory(true)
    expect(useHistoryDialog.getState().open).toBe(false)
    toggleHistory(false)
    expect(useHistoryDialog.getState().open).toBe(true)
    toggleHistory(true)
    expect(useHistoryDialog.getState().open).toBe(false)
  })
})

describe('the places Back and Forward list', () => {
  beforeEach(() => {
    useSessionsStore.setState({
      byId: { s1: summary('s1'), s2: summary('s2', 1), s3: summary('s3'), s4: summary('s4') },
    })
    useViewStore.setState({ main: { kind: 'launch' } })
    restoreLayout(createLayout({ kind: 'session', sessionId: 's1', projectPath: '/repo' }))
    useViewStore.setState({ history: { back: [], forward: [] } })
    for (const id of ['s2', 's3']) openSession(id, '/repo')
    openUsage()
  })

  it('lists those that can still show, nearest first', () => {
    // s2 is archived, so it is left out.
    expect(historyPlaces(state().history, 'back').map((step) => step.place)).toEqual([
      { kind: 'session', sessionId: 's3' },
      { kind: 'session', sessionId: 's1' },
    ])
    expect(historyPlaces(state().history, 'forward')).toEqual([])
  })

  it.each([
    ['archived', { s4: summary('s4', 2) }],
    ['deleted', { s4: undefined }],
  ])('leaves out a step whose place was %s, though its pages can still show', (_, change) => {
    openSession('s4', '/repo')
    useViewStore.setState({ history: { back: [], forward: [] } })
    openSettings('general')
    closeSettings()
    const settings = { kind: 'settings', section: 'general', item: null }
    expect(historyPlaces(state().history, 'back').map((step) => step.place)).toEqual([
      settings,
      { kind: 'session', sessionId: 's4' },
    ])
    useSessionsStore.setState((s) => ({ byId: { ...s.byId, ...change } as typeof s.byId }))
    expect(historyPlaces(state().history, 'back').map((step) => step.place)).toEqual([settings])
  })

  it('goes to one of them in one step, passing over the others', () => {
    const [, s1] = historyPlaces(state().history, 'back')
    goToPlace('back', s1!)
    expect(state().main).toEqual({ kind: 'session', sessionId: 's1' })
    expect(historyPlaces(state().history, 'forward').map((step) => step.place)).toEqual([
      { kind: 'session', sessionId: 's3' },
      { kind: 'usage' },
    ])
  })
})
