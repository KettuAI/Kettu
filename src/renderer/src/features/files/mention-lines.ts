// Mentions lines picked in the Files pane's diff in the composer of the session the pane serves,
// as typing `@name#L4-5` would, with the file attached as a chosen mention attaches it; and
// quotes a passage selected in an open file there.

import { EditorView } from '@codemirror/view'
import type { SelectedLineRange } from '@pierre/diffs'
import { attachMention } from '@renderer/features/session/composer/attachments'
import { allPanes, focusedPane } from '@renderer/features/split/layout'
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

/** The composer's editor of the pane that shows the session, or null when none shows it. */
function composerOf(sessionId: string): EditorView | null {
  const { layout } = useViewStore.getState()
  const pane = allPanes(layout).find(
    (candidate) => candidate.view.kind === 'session' && candidate.view.sessionId === sessionId,
  )
  if (!pane) return null
  const editor = document.querySelector<HTMLElement>(
    `[data-split-pane="${CSS.escape(pane.id)}"] .cm-editor`,
  )
  return editor ? EditorView.findFromDOM(editor) : null
}

/** Types `text` at the caret, after a space when a word ends there, and focuses the composer. */
function typeMention(view: EditorView, text: string): void {
  const { from } = view.state.selection.main
  const before = from > 0 ? view.state.sliceDoc(from - 1, from) : ''
  view.dispatch(view.state.replaceSelection(`${before && !/\s/.test(before) ? ' ' : ''}${text} `), {
    userEvent: 'input.type',
    scrollIntoView: true,
  })
  view.focus()
}

/**
 * Puts `quote` in the composer of the session `sessionId` as a block of its own at the caret, with
 * the caret on a line after it, which an empty line keeps out of a Markdown quote; null once it is
 * there.
 */
export function quoteInComposer(sessionId: string, quote: string): MentionMiss | null {
  const view = composerOf(sessionId)
  if (!view) return 'no-composer'
  const { from, to } = view.state.selection.main
  const before = view.state.sliceDoc(0, from)
  const gap = !before.trim() || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
  const insert = `${gap}${quote}\n\n`
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
    userEvent: 'input',
    scrollIntoView: true,
  })
  view.focus()
  return null
}

/**
 * Mentions files and folders of the project in the composer of the session `sessionId`, each
 * attached as a chosen mention attaches it; null once they are there.
 */
export function mentionPaths(
  sessionId: string,
  projectPath: string,
  entries: readonly { path: string; folder: boolean }[],
): MentionMiss | null {
  const view = composerOf(sessionId)
  if (!view) return 'no-composer'
  const names: string[] = []
  for (const { path, folder } of entries) {
    if (attachMention(sessionId, projectPath, path, folder) > 0) break
    names.push(`@${nameOf(path)}${folder ? '/' : ''}`)
  }
  if (names.length > 0) typeMention(view, names.join(' '))
  return names.length < entries.length ? 'full' : null
}

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
  typeMention(view, mentionText(path, lines))
  return null
}
