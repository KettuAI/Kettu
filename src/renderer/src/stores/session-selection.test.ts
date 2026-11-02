import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'
import {
  clearSelection,
  selectionFor,
  selectRange,
  toggleSelected,
  useSessionSelection,
} from './session-selection'
import { useSessionsStore } from './sessions'
import { useViewStore } from './view'

const ids = () => useSessionSelection.getState().ids
const session = (id: string, extra: Partial<SessionSummary> = {}) =>
  ({ id, projectPath: '/repo', parentId: null, archivedAt: null, ...extra }) as SessionSummary

describe('session selection', () => {
  beforeEach(() => {
    clearSelection()
    useSessionsStore.setState({ byId: {} })
    useViewStore.setState({ main: { kind: 'launch' } })
  })

  it('adds and removes rows with Mod-click, leaving out the session in front', () => {
    toggleSelected('b')
    toggleSelected('c')
    expect(ids()).toEqual(['b', 'c'])
    toggleSelected('b')
    expect(ids()).toEqual(['c'])
  })

  it('picks a Shift-click range in sidebar order, from the last pick', () => {
    const order = ['a', 'b', 'c', 'd', 'e']
    selectRange('c', 'a', order)
    expect(ids()).toEqual(['a', 'b', 'c'])
    toggleSelected('e')
    selectRange('d', 'a', order)
    expect(ids()).toEqual(['d', 'e'])
  })

  it('acts on the selection only from a row inside it with two or more picked', () => {
    expect(selectionFor('a', ['a'])).toBeNull()
    expect(selectionFor('c', ['a', 'b'])).toBeNull()
    expect(selectionFor('a', ['a', 'b'])).toEqual(['a', 'b'])
  })

  it('drops a picked session once it is archived or removed', () => {
    useSessionsStore.setState({ byId: { a: session('a'), b: session('b'), c: session('c') } })
    toggleSelected('b')
    toggleSelected('c')
    useSessionsStore.getState().upsert(session('c', { archivedAt: 1 }))
    expect(ids()).toEqual(['b'])
    expect(useSessionSelection.getState().anchor).toBeNull()
    useSessionsStore.getState().remove('b')
    expect(ids()).toEqual([])
  })

  // The host marks only the top-level session archived; its sub-sessions hide with it.
  it('drops a picked sub-session once its parent is archived', () => {
    useSessionsStore.setState({
      byId: { p: session('p'), s: session('s', { parentId: 'p' }), x: session('x') },
    })
    toggleSelected('s')
    toggleSelected('x')
    useSessionsStore.getState().upsert(session('p', { archivedAt: 1 }))
    expect(ids()).toEqual(['x'])
  })

  it('keeps the picked rows when the same session comes back from a page', () => {
    useViewStore.setState({ main: { kind: 'session', sessionId: 'a' } })
    toggleSelected('b')
    toggleSelected('c')
    useViewStore.setState({ main: { kind: 'usage' } })
    useViewStore.setState({ main: { kind: 'session', sessionId: 'a' } })
    expect(ids()).toEqual(['b', 'c'])
  })

  it('lets go of the picked rows when another session comes to the front', () => {
    useViewStore.setState({ main: { kind: 'session', sessionId: 'a' } })
    toggleSelected('b')
    toggleSelected('c')
    useViewStore.setState({ main: { kind: 'session', sessionId: 'a' } })
    expect(ids()).toEqual(['b', 'c'])
    useViewStore.setState({ main: { kind: 'session', sessionId: 'd' } })
    expect(ids()).toEqual([])
  })
})
