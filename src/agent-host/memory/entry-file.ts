// A memory entry's file: Markdown after a frontmatter of its fields. Kettu writes every field, but
// reads leniently, since the user may edit the files by hand.

import { randomBytes } from 'node:crypto'
import { isAgentId } from '@shared/agents'
import type { MemoryEntry } from '@shared/memory'
import { frontmatter } from '../marketplace/frontmatter'

/** The frontmatter's top-level scalars and the text after it; the whole text when it has none. */
export function splitFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const clean = text.replace(/^\uFEFF/, '')
  const lines = clean.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { fields: {}, body: clean }
  const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line))
  if (end === -1) return { fields: {}, body: clean }
  return { fields: frontmatter(clean), body: lines.slice(end + 1).join('\n') }
}

/** Text on one line, control characters and runs of white space made single spaces. */
export function oneLine(text: string): string {
  return text.replace(/[\s\p{Cc}]+/gu, ' ').trim()
}

/** A body without leading blank lines or trailing white space, with Unix line breaks. */
export function normalizeBody(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/^(?:[ \t]*\n)+/, '')
    .trimEnd()
}

/** At most `max` characters, the last one an ellipsis when it was cut. */
export function cut(text: string, max: number): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  return `${chars
    .slice(0, max - 1)
    .join('')
    .trimEnd()}\u2026`
}

/** `run-tests-with-pnpm` as `Run tests with pnpm`. */
export function humanize(slug: string): string {
  const words = slug.replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Room left after the base of an id for a `-<n>` that makes it unique. */
const SLUG_CHARS = 56

/** The title as an id's ASCII slug; empty when nothing of it is ASCII letters or digits. */
export function slugOf(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug.length <= SLUG_CHARS) return slug
  const short = slug.slice(0, SLUG_CHARS)
  const dash = short.lastIndexOf('-')
  return (dash > SLUG_CHARS / 2 ? short.slice(0, dash) : short).replace(/-+$/, '')
}

/** An id for a new entry: the title's slug, else `m-<8 hex>`, unique among `taken`. */
export function newId(title: string, taken: ReadonlySet<string>): string {
  const base = slugOf(title)
  if (base === '') {
    for (;;) {
      const id = `m-${randomBytes(4).toString('hex')}`
      if (!taken.has(id)) return id
    }
  }
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`
    if (!taken.has(id)) return id
  }
}

function quoted(value: string | null): string {
  return value === null ? 'null' : JSON.stringify(value)
}

/** The entry as its file holds it. */
export function formatEntry(entry: MemoryEntry): string {
  const lines = [
    '---',
    `title: ${quoted(entry.title)}`,
    `description: ${quoted(entry.description)}`,
    `created: ${new Date(entry.createdAt).toISOString()}`,
    `updated: ${new Date(entry.updatedAt).toISOString()}`,
    `agent: ${quoted(entry.source.agentId)}`,
    `session: ${quoted(entry.source.sessionId)}`,
    '---',
  ]
  return `${lines.join('\n')}\n\n${entry.body}\n`
}

function time(value: string | undefined): number | null {
  if (value === undefined) return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

function nullable(value: string | undefined): string | null {
  const text = oneLine(value ?? '')
  return text === '' || text === 'null' || text === '~' ? null : text
}

/** An entry as its file gives it; the times are null where the file has none that parse. */
export interface ParsedEntry {
  entry: Omit<MemoryEntry, 'createdAt' | 'updatedAt'>
  created: number | null
  updated: number | null
}

/** Reads what a file holds, filling what it lacks: a file without frontmatter is all body. */
export function parseEntry(id: string, text: string): ParsedEntry {
  const { fields, body } = splitFrontmatter(text)
  const content = normalizeBody(body)
  const heading = /^#{1,6}\s+(.+)$/m.exec(content)?.[1]
  const title = oneLine(fields.title ?? '') || oneLine(heading ?? '') || humanize(id)
  const agent = nullable(fields.agent)
  const session = nullable(fields.session)
  const created = time(fields.created)
  return {
    entry: {
      id,
      title,
      description: oneLine(fields.description ?? ''),
      body: content,
      source: { agentId: isAgentId(agent) ? agent : null, sessionId: session },
    },
    created,
    updated: time(fields.updated) ?? created,
  }
}
