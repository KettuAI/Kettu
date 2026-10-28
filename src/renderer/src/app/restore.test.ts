import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'
import { allPanes, createLayout, saveLayout, splitAt } from '@renderer/features/split/layout'
import { launchTarget, savedLayout } from './restore'

const summary = (id: string, projectPath = '/repo') => ({ id, projectPath }) as SessionSummary
const byId = { s1: summary('s1'), s2: summary('s2', '/other') }
const launching = { kind: 'launch' } as const

const split = () => {
  const layout = createLayout({
    kind: 'session' as const,
    sessionId: 's1',
    projectPath: '/repo',
  })
  return splitAt(
    layout,
    layout.focus,
    'right',
    { kind: 'session', sessionId: 's2', projectPath: '/other' },
    { width: 1920, height: 1080 },
  )!
}

const launch = (extra: Record<string, unknown> = {}) => ({
  enabled: true,
  layout: undefined,
  lastSessionId: null as string | null,
  main: launching,
  byId,
  ...extra,
})

describe('launchTarget', () => {
  it('brings the saved split back with the setting on', () => {
    const layout = split()
    const target = launchTarget(launch({ layout }))
    expect(target?.kind).toBe('layout')
    if (target?.kind !== 'layout') return
    expect(allPanes(target.layout).map((pane) => pane.view)).toEqual([
      { kind: 'session', sessionId: 's1', projectPath: '/repo' },
      { kind: 'session', sessionId: 's2', projectPath: '/other' },
    ])
    expect(target.layout.focus).toBe(layout.focus)
  })

  it('leaves out the sessions that are gone, with the split around them', () => {
    const layout = split()
    const target = launchTarget(launch({ layout, byId: { s1: summary('s1') } }))
    expect(target?.kind).toBe('layout')
    if (target?.kind !== 'layout') return
    expect(allPanes(target.layout).map((pane) => pane.view)).toEqual([
      { kind: 'session', sessionId: 's1', projectPath: '/repo' },
    ])
    expect(target.layout.focus).toBe(allPanes(target.layout)[0]!.id)
  })

  it('opens New session alone when every session of the save is gone', () => {
    const layout = split()
    expect(launchTarget(launch({ layout, byId: {} }))).toEqual({ kind: 'new' })
  })

  it('opens New session with the setting off', () => {
    expect(launchTarget(launch({ layout: split(), enabled: false }))).toEqual({ kind: 'new' })
  })

  it('opens the one session a save made before the split view names', () => {
    expect(launchTarget(launch({ lastSessionId: 's1' }))).toEqual({
      kind: 'session',
      summary: byId.s1,
    })
    expect(launchTarget(launch({ lastSessionId: 'gone' }))).toEqual({ kind: 'new' })
  })

  it('does not take over once the user has opened something', () => {
    const main = { kind: 'session', sessionId: 's2' } as const
    expect(launchTarget(launch({ layout: split(), main }))).toBeNull()
    expect(launchTarget(launch({ main: { kind: 'usage' } }))).toBeNull()
  })
})

describe('savedLayout', () => {
  it('reads nothing from a save with no layout', () => {
    expect(savedLayout(undefined, byId)).toBeNull()
    expect(savedLayout({ columns: 'x' }, byId)).toBeNull()
  })

  it('keeps a New session pane as New session with its defaults', () => {
    const layout = createLayout({
      kind: 'new',
      agentId: 'codex',
      projectPath: '/repo',
      noProject: true,
      parentId: 'p1',
    })
    const restored = savedLayout(saveLayout(layout), byId)!
    expect(allPanes(restored)[0]!.view).toEqual({
      kind: 'new',
      agentId: null,
      projectPath: null,
      noProject: false,
    })
  })
})
