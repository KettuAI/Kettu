// What a notification says about a session: what a waiting request asks for, and what a finished
// turn's reply says.

import path from 'node:path'
import type { PendingPermission, ThreadState, ToolEntry } from '@shared/thread'
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
 * The option a notification's Allow once gives: a request's one-time allowing, never a question's
 * answer, which wants the session's card.
 */
export function allowOnceOption(
  tool: ToolEntry | undefined,
  options: PendingPermission['options'],
): string | null {
  if (!tool || tool.question !== undefined) return null
  return options.find((option) => option.kind === 'allow_once')?.id ?? null
}

/**
 * The finished turn's reply in a line or two, as plain text: its first paragraph past a heading,
 * without the Markdown around words. Null when the turn ended without one.
 */
export function replySummary(thread: ThreadState): string | null {
  for (let i = thread.order.length - 1; i >= 0; i--) {
    const entry = thread.byId[thread.order[i]!]
    if (entry?.kind === 'user') return null
    if (entry?.kind !== 'agent' || !entry.markdown.trim()) continue
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
      .replace(/(\*\*|__|\*|_|~~|`)(.+?)\1/g, '$2')
      .replace(/\s+/g, ' ')
      .trim()
    return text || null
  }
  return null
}
