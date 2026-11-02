import { EditorState, type TransactionSpec } from '@codemirror/state'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Layout, PaneView } from '@renderer/features/split/layout'
import { mentionLines, mentionText, selectedLines } from './mention-lines'

const mocks = vi.hoisted(() => ({
  attachMention: vi.fn<(draft: string, project: string, path: string, folder: boolean) => number>(
    () => 0,
  ),
  layout: null as unknown as Layout,
  view: null as unknown,
}))
vi.mock('@renderer/features/session/composer/attachments', () => ({
  attachMention: mocks.attachMention,
}))
vi.mock('@renderer/stores/view', () => ({
  useViewStore: { getState: () => ({ layout: mocks.layout }) },
}))
vi.mock('@codemirror/view', () => ({ EditorView: { findFromDOM: () => mocks.view } }))

describe('selectedLines', () => {
  it('orders the ends of a selection on the new file', () => {
    expect(selectedLines({ start: 9, end: 4, side: 'additions', endSide: 'additions' })).toEqual([
      4, 9,
    ])
    expect(selectedLines({ start: 3, end: 3 })).toEqual([3, 3])
  })

  it('offers nothing for removed lines, numbered in the old file', () => {
    expect(selectedLines({ start: 2, end: 2, side: 'deletions' })).toBeNull()
    expect(selectedLines({ start: 2, end: 5, side: 'additions', endSide: 'deletions' })).toBeNull()
    expect(selectedLines(null)).toBeNull()
  })
})

describe('mentionText', () => {
  it("writes the file's name with its line or lines", () => {
    expect(mentionText('src/usage/usage-store.ts', [4, 5])).toBe('@usage-store.ts#L4-5')
    expect(mentionText('README.md', [7, 7])).toBe('@README.md#L7')
  })
})

describe('mentionLines', () => {
  const focus = (view: PaneView): void => {
    mocks.layout = {
      columns: [{ id: 'c1', panes: [{ id: 'p1', view, share: 1 }], share: 1 }],
      focus: 'p1',
    }
  }
  const composer = (doc: string) => {
    const view = {
      state: EditorState.create({ doc, selection: { anchor: doc.length } }),
      dispatch: (...specs: TransactionSpec[]) => {
        view.state = view.state.update(...specs).state
      },
      focus: vi.fn(),
    }
    mocks.view = view
    return view
  }

  beforeEach(() => {
    vi.stubGlobal('document', { querySelector: () => ({}) })
    vi.stubGlobal('CSS', { escape: (value: string) => value })
    focus({ kind: 'session', sessionId: 's1', projectPath: '/repo' })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    mocks.attachMention.mockReset().mockReturnValue(0)
  })

  it("types the lines into the focused session's composer and attaches the file", () => {
    const view = composer('Look at')
    expect(mentionLines('/repo', 'src/usage-store.ts', [4, 5])).toBeNull()
    expect(mocks.attachMention).toHaveBeenCalledWith('s1', '/repo', 'src/usage-store.ts', false)
    expect(view.state.doc.toString()).toBe('Look at @usage-store.ts#L4-5 ')
    expect(view.focus).toHaveBeenCalled()
  })

  it('types nothing when the composer holds all the attachments it can', () => {
    const view = composer('Look at')
    mocks.attachMention.mockReturnValue(1)
    expect(mentionLines('/repo', 'src/usage-store.ts', [4, 5])).toBe('full')
    expect(view.state.doc.toString()).toBe('Look at')
    expect(view.focus).not.toHaveBeenCalled()
  })

  it('reaches no composer when the focused pane shows no session', () => {
    composer('')
    focus({ kind: 'new', agentId: null, projectPath: '/repo', noProject: false })
    expect(mentionLines('/repo', 'README.md', [7, 7])).toBe('no-composer')
    expect(mocks.attachMention).not.toHaveBeenCalled()
  })
})
