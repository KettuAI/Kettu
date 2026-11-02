// Mentions lines picked in the Files pane's diff in the composer of the session the pane serves,
// as typing `@name#L4-5` would, with the file attached as a chosen mention attaches it.

import { EditorView } from '@codemirror/view'
import type { SelectedLineRange } from '@pierre/diffs'
import { attachMention } from '@renderer/features/session/composer/attachments'
import { focusedPane } from '@renderer/features/split/layout'
import { useViewStore } from '@renderer/stores/view'
import { nameOf } from './paths'

/** The new file's lines a selection covers, or null when it holds only removed lines. */
export function selectedLines(range: SelectedLineRange | null): [number, number] | null {
  if (!range) return null
  // Removed lines are numbered in the old file, which the agent no longer sees.
  if (range.side === 'deletions' || range.endSide === 'deletions') return null
  return range.start <= range.end ? [range.start, range.end] : [range.end, range.start]
}

/** `@name#L4-5`, or `@name#L4` for one line: the form agents read as lines of a mentioned file. */
export function mentionText(path: string, [start, end]: [number, number]): string {
  return `@${nameOf(path)}#L${start}${end > start ? `-${end}` : ''}`
}

/** Why lines were not mentioned: no session in the focused pane, or its attachments are full. */
export type MentionMiss = 'no-composer' | 'full'

/** Puts the mention in the focused pane's composer; null once it is there. */
export function mentionLines(
  projectPath: string,
  path: string,
  lines: [number, number],
): MentionMiss | null {
  const { layout } = useViewStore.getState()
  const pane = focusedPane(layout)
  if (pane.view.kind !== 'session') return 'no-composer'
  const editor = document.querySelector<HTMLElement>(
    `[data-split-pane="${CSS.escape(pane.id)}"] .cm-editor`,
  )
  const view = editor ? EditorView.findFromDOM(editor) : null
  if (!view) return 'no-composer'
  if (attachMention(pane.view.sessionId, projectPath, path, false) > 0) return 'full'
  const { from } = view.state.selection.main
  const before = from > 0 ? view.state.sliceDoc(from - 1, from) : ''
  const text = `${before && !/\s/.test(before) ? ' ' : ''}${mentionText(path, lines)} `
  view.dispatch(view.state.replaceSelection(text), {
    userEvent: 'input.type',
    scrollIntoView: true,
  })
  view.focus()
  return null
}
