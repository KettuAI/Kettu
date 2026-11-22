// Where an edit from a message cuts a Claude Code session: read from the session's own transcript,
// whose records keep the whole chain, the turns before the latest compaction included.

import type { RewindPoint } from '../connection'

/** The fields of a transcript record a cut reads. */
export interface TranscriptRecord {
  type?: unknown
  subtype?: unknown
  uuid?: unknown
  parentUuid?: unknown
  isSidechain?: unknown
  isMeta?: unknown
  promptSource?: unknown
  message?: unknown
  content?: unknown
  forkedFrom?: unknown
}

/** The records of a transcript, one JSON object per line; a line that does not parse is skipped. */
export function transcriptRecords(text: string): TranscriptRecord[] {
  const records: TranscriptRecord[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const value: unknown = JSON.parse(line)
      if (typeof value === 'object' && value !== null) records.push(value as TranscriptRecord)
    } catch {
      // A line cut off while it was written.
    }
  }
  return records
}

function textOf(record: TranscriptRecord): string {
  const message = record.message as { content?: unknown } | undefined
  const content = message?.content ?? record.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((block: { type?: unknown; text?: unknown }) =>
      block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [],
    )
    .join('\n')
}

/** A prompt of the main thread: neither a tool's result nor a note Claude Code added itself. */
function isPrompt(record: TranscriptRecord): boolean {
  if (record.type !== 'user' || record.isSidechain === true || record.isMeta === true) return false
  const content = (record.message as { content?: unknown } | undefined)?.content
  if (Array.isArray(content) && content.some((block) => block?.type === 'tool_result')) {
    return false
  }
  return !isLocalCommand(record)
}

/**
 * A local command's record, such as `/usage`'s: cut right after one, the next message would read
 * as its output, so a cut steps over it.
 */
function isLocalCommand(record: TranscriptRecord): boolean {
  if (record.type === 'system') return record.subtype === 'local_command'
  if (record.type !== 'user') return false
  const text = textOf(record).trimStart()
  return (
    text.startsWith('<command-name>') ||
    text.startsWith('<local-command-') ||
    (record.isMeta === true && text.startsWith('Caveat:'))
  )
}

/**
 * The uuid a fork of the session ends at for an edit from the prompt `point` names: the record
 * before the prompt, past any local command; null when nothing came before it. The prompt is the
 * one with the uuid Kettu sent, or one a fork copied from it, else the nth with its text.
 */
export function rewindCut(records: readonly TranscriptRecord[], point: RewindPoint): string | null {
  const byUuid = new Map<string, TranscriptRecord>()
  for (const record of records) {
    if (typeof record.uuid === 'string') byUuid.set(record.uuid, record)
  }
  const prompt = findPrompt(records, point)
  if (!prompt) throw new RewindPointMissing()
  let parent = typeof prompt.parentUuid === 'string' ? byUuid.get(prompt.parentUuid) : undefined
  while (parent && isLocalCommand(parent)) {
    parent = typeof parent.parentUuid === 'string' ? byUuid.get(parent.parentUuid) : undefined
  }
  return parent && typeof parent.uuid === 'string' ? parent.uuid : null
}

function findPrompt(
  records: readonly TranscriptRecord[],
  point: RewindPoint,
): TranscriptRecord | null {
  if (point.ref !== null) {
    const ref = point.ref
    const found = records.find(
      (record) =>
        record.uuid === ref ||
        (record.forkedFrom as { messageUuid?: unknown } | undefined)?.messageUuid === ref,
    )
    if (found) return found
  }
  const text = point.text.trim()
  if (!text) return null
  const same = records.filter((record) => isPrompt(record) && textOf(record).includes(text))
  return same[point.occurrence - 1] ?? null
}

/** A fork's uuids by the ones they were copied from, which `forkedFrom` names. */
export function forkedUuids(records: readonly TranscriptRecord[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const record of records) {
    const from = (record.forkedFrom as { messageUuid?: unknown } | undefined)?.messageUuid
    if (typeof from === 'string' && typeof record.uuid === 'string') out[from] = record.uuid
  }
  return out
}

/** The prompt an edit names is not in the session's transcript. */
export class RewindPointMissing extends Error {
  constructor() {
    super('The message is not in the session transcript')
    this.name = 'RewindPointMissing'
  }
}
