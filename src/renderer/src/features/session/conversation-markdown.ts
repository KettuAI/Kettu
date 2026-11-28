// A session's conversation as a Markdown file: the messages and replies as written, each tool call
// as one line the way the thread names it, and attachments by their names. Tool output, thoughts
// and Kettu's own records stay out.

import type { ContentRef, SessionView, ThreadEntry, ToolEntry, UserContent } from '@shared/thread'
import type { ToolLabel } from './entries/helpers'

/** The words the file is written in, in the interface language. */
export interface ExportWords {
  you: string
  kettu: string
  from: (title: string) => string
  fromParent: string
  attachments: string
  image: (number: number) => string
  audio: string
  video: string
  subagent: string
  startedSession: (title: string | null) => string
  failed: string
  cancelled: string
  /** Between a tool's name and what it acts on, as the thread writes it. */
  separator: string
}

export interface ExportContext {
  /** A finished call's label, as the thread names it. */
  toolLabel: (entry: ToolEntry) => ToolLabel
  /** A session's title by its id, null where the window does not know it. */
  sessionTitle: (id: string) => string | null
  words: ExportWords
}

/**
 * One piece of the conversation: a message with a heading of its own, or the agent's reply text
 * or step, which go under the agent's heading.
 */
export type ExportItem =
  | { kind: 'message'; heading: string; body: string }
  | { kind: 'reply'; text: string }
  | { kind: 'step'; text: string }

const MAX_STEP_CHARS = 200

/** The model the session runs on, by the name its menu shows; null where it reports none. */
export function modelName(session: Pick<SessionView, 'config'> | undefined): string | null {
  const option = session?.config.find((o) => o.category === 'model' && o.type === 'select')
  if (!option) return null
  return option.choices?.find((choice) => choice.value === option.value)?.name ?? null
}

/** Text as an inline code span, whatever backticks it holds. */
function code(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(longest + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(line)
  return chars.length > MAX_STEP_CHARS ? `${chars.slice(0, MAX_STEP_CHARS - 1).join('')}…` : line
}

function refName(ref: ContentRef, images: () => number, words: ExportWords): string {
  switch (ref.kind) {
    case 'image':
      return words.image(images())
    case 'audio':
      return ref.name ?? words.audio
    case 'video':
      return ref.name ?? words.video
    case 'link':
      return ref.name || ref.uri
    case 'attachment':
      return ref.attachment.name
    case 'terminal':
    case 'page':
    case 'device':
    case 'plugin':
      return ref.name
    case 'unsupported':
      return ref.label
  }
}

/** A message's text as written, then its attachments by name on a line of their own. */
function body(text: string[], refs: ContentRef[], words: ExportWords): string {
  let image = 0
  const names = refs.map((ref) => code(oneLine(refName(ref, () => ++image, words))))
  const parts = text.map((part) => part.trim()).filter((part) => part !== '')
  if (names.length > 0) parts.push(`${words.attachments}: ${names.join(', ')}`)
  return parts.join('\n\n')
}

function userBody(content: UserContent[], words: ExportWords): string {
  const text: string[] = []
  const refs: ContentRef[] = []
  for (const part of content) {
    if (part.type === 'text') text.push(part.text)
    else refs.push(part.ref)
  }
  return body(text, refs, words)
}

function stepText(entry: ToolEntry, context: ExportContext): string {
  const { words } = context
  const label = context.toolLabel(entry)
  // A path or a command is code; a title or a tool's argument reads as the thread writes it.
  const target =
    label.target === null
      ? null
      : label.kind === 'path' || label.kind === 'command'
        ? code(oneLine(label.target))
        : oneLine(label.target)
  const name =
    label.verb && target
      ? `${label.verb}${label.kind === 'tool' ? words.separator : ' '}${target}`
      : (label.verb ?? target ?? '')
  const status =
    entry.status === 'failed'
      ? ` (${words.failed})`
      : entry.status === 'cancelled'
        ? ` (${words.cancelled})`
        : ''
  return `${name}${status}`
}

/** The items of entries in thread order; a page at a time keeps a long thread out of memory. */
export function exportItems(entries: readonly ThreadEntry[], context: ExportContext): ExportItem[] {
  const { words } = context
  const items: ExportItem[] = []
  for (const entry of entries) {
    switch (entry.kind) {
      case 'user': {
        // A card's answer and a report of another session's turn are the thread's own records.
        if (entry.approval || entry.from?.ended) break
        const heading = entry.kettu
          ? words.kettu
          : entry.from
            ? words.from(entry.from.title)
            : words.you
        items.push({ kind: 'message', heading, body: userBody(entry.content, words) })
        break
      }
      case 'session_message': {
        const sender = entry.senderId ? context.sessionTitle(entry.senderId) : null
        const heading = sender ? words.from(sender) : words.fromParent
        items.push({ kind: 'message', heading, body: userBody(entry.content, words) })
        break
      }
      case 'agent': {
        const text = body([entry.markdown], entry.attachments, words)
        if (text) items.push({ kind: 'reply', text })
        break
      }
      case 'tool':
        items.push({ kind: 'step', text: stepText(entry, context) })
        break
      case 'subagent': {
        const title = context.sessionTitle(entry.sessionId)
        const text = title ? `${words.subagent}${words.separator}${title}` : words.subagent
        items.push({ kind: 'step', text })
        break
      }
      case 'session_started':
        items.push({
          kind: 'step',
          text: words.startedSession(context.sessionTitle(entry.sessionId)),
        })
        break
      case 'remote_delegation': {
        const title = context.sessionTitle(entry.targetSessionId) ?? entry.targetTitle
        const place = entry.targetProjectName
          ? `${entry.targetHostName} / ${entry.targetProjectName}`
          : entry.targetHostName
        if (entry.phase === 'started') {
          items.push({
            kind: 'step',
            text: `${words.startedSession(title)} (${place})`,
          })
        } else {
          const status =
            entry.outcome === 'failed'
              ? ` (${words.failed})`
              : entry.outcome === 'stopped'
                ? ` (${words.cancelled})`
                : ''
          const detail = entry.error ?? entry.summary
          items.push({
            kind: 'step',
            text: detail
              ? `${title} (${place})${status}: ${oneLine(detail)}`
              : `${title} (${place})${status}`,
          })
        }
        break
      }
    }
  }
  return items
}

/**
 * The whole file: the title, the facts about the session as a list, then each message under its
 * heading and the agent's replies under `agent`, its steps as a list between them.
 */
export function conversationMarkdown(
  head: { title: string; facts: readonly string[]; agent: string },
  items: readonly ExportItem[],
): string {
  const blocks = [`# ${oneLine(head.title)}`]
  if (head.facts.length > 0) blocks.push(head.facts.map((fact) => `- ${fact}`).join('\n'))
  blocks.push('---')
  let inReply = false
  let steps: string[] = []
  const endSteps = () => {
    if (steps.length > 0) blocks.push(steps.map((step) => `- ${step}`).join('\n'))
    steps = []
  }
  for (const item of items) {
    if (item.kind === 'message') {
      endSteps()
      blocks.push(`## ${oneLine(item.heading)}`)
      if (item.body) blocks.push(item.body)
      inReply = false
      continue
    }
    if (!inReply) {
      blocks.push(`## ${oneLine(head.agent)}`)
      inReply = true
    }
    if (item.kind === 'step') steps.push(item.text)
    else {
      endSteps()
      blocks.push(item.text)
    }
  }
  endSteps()
  return `${blocks.join('\n\n')}\n`
}
