// What a notification says about a session: what a waiting request asks for, and what a finished
// turn's reply says and changed.

import path from 'node:path'
import {
  previewsCommand,
  type PendingPermission,
  type ThreadEntry,
  type ThreadState,
  type ToolEntry,
} from '@shared/thread'
import { t } from './i18n'

/** A path inside the project as relative to it; one elsewhere as it is. */
function shown(file: string, projectPath: string): string {
  const relative = path.relative(projectPath, file)
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file
}

/** A request's line under the session's title: what the agent wants to do. */
export function requestText(tool: ToolEntry | undefined, projectPath: string): string {
  if (!tool) return t('attention.permission')
  if (tool.question !== undefined) return t('attention.asks', { question: tool.question })
  const location = tool.locations[0]?.path
  const target = location ? shown(location, projectPath) : tool.title
  switch (tool.toolKind) {
    case 'execute':
      return t('attention.wantsToRun', { command: (tool.rawInput ?? tool.title).split('\n')[0] })
    case 'edit':
      return t('attention.wantsToEdit', { target })
    case 'delete':
      return t('attention.wantsToDelete', { target })
    case 'move':
      return t('attention.wantsToMove', { target })
    default:
      return t('attention.wantsToUse', { tool: tool.title })
  }
}

/**
 * The option a notification's Allow once gives: a request's one-time allowing, only where the
 * notification's line says all it allows. A question, a command of several steps or too long for
 * the line, and a plan, mode or other request want the session's card.
 */
export function allowOnceOption(
  tool: ToolEntry | undefined,
  options: PendingPermission['options'],
): string | null {
  if (!tool || tool.question !== undefined) return null
  switch (tool.toolKind) {
    case 'execute':
      if (previewsCommand(tool.rawInput ?? tool.title)) return null
      break
    case 'edit':
    case 'delete':
    case 'move':
      break
    default:
      return null
  }
  return options.find((option) => option.kind === 'allow_once')?.id ?? null
}

/**
 * The finished turn's entries, newest first: back to its message, or to the end of the turn before
 * for a turn the agent started with no message. Its own end comes first.
 */
function* finishedTurn(thread: ThreadState): Generator<ThreadEntry> {
  let ended = false
  for (let i = thread.order.length - 1; i >= 0; i--) {
    const entry = thread.byId[thread.order[i]!]
    if (!entry) continue
    if (entry.kind === 'user') return
    if (entry.kind === 'turn_end') {
      if (ended) return
      ended = true
      continue
    }
    yield entry
  }
}

/**
 * The finished turn's reply in a line or two, as plain text: its first paragraph past a heading,
 * without the Markdown around words. Null when the turn ended without one.
 */
export function replySummary(thread: ThreadState): string | null {
  for (const entry of finishedTurn(thread)) {
    if (entry.kind !== 'agent' || !entry.markdown.trim()) continue
    const paragraphs = entry.markdown
      .replace(/```[\s\S]*?(```|$)/g, '')
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .filter((part) => part !== '')
    // A heading names the reply; the paragraph under it says what happened.
    const paragraph = paragraphs.find((part) => !/^#{1,6}\s/.test(part)) ?? paragraphs[0] ?? ''
    const text = paragraph
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/gm, '')
      .replace(/(\*\*|\*|~~|`)(.+?)\1/g, '$2')
      // Underscores mark emphasis only at a word's edges, never inside snake_case names.
      .replace(/(?<!\w)(__|_)(?=\S)(.+?)(?<=\S)\1(?!\w)/g, '$2')
      .replace(/\s+/g, ' ')
      .trim()
    return text || null
  }
  return null
}

/** How many files the turn's finished edits changed, each counted once. */
export function changedFiles(thread: ThreadState): number {
  const paths = new Set<string>()
  for (const entry of finishedTurn(thread)) {
    if (entry.kind !== 'tool' || entry.status !== 'completed') continue
    for (const item of entry.content) if (item.type === 'diff') paths.add(item.path)
  }
  return paths.size
}
