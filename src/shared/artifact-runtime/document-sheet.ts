// What the document viewer and the window that holds it say to each other while the document is
// shown as a sheet in the artifact viewer. The window drives the viewer with one state, which says
// how to lay the document out and what to mark; the viewer reports its layout, a block picked to
// comment on, the words selected and how a typed change is saving. What the viewer reports is the
// page's, untrusted: only the shapes below pass, each field capped, and it is only ever data.

import { RUNTIME_VERSION } from '../artifact-capabilities'
import type { ChangedPassage } from '../artifact-changes'

/**
 * The most headings a layout report carries, and the most tracked blocks; the viewer drops the
 * last ones when a report would pass MESSAGE_BYTES.
 */
export const DOC_HEADINGS = 300
export const DOC_PLACES = 400
/** The most offsets the window asks the viewer to track. */
export const DOC_TRACKED = 400
/** The most characters of a heading's text and of selected words a report carries. */
export const DOC_TEXT_CHARS = 120
export const DOC_QUOTE_CHARS = 300

/** The most characters of a block a failed save carries, as it was and as typed. */
export const DOC_KEPT_CHARS = 8000

const MAX_OFFSET = 64 * 1024 * 1024
const MAX_PX = 1_000_000
const SLUG = /^[\p{L}\p{N}_-]{1,80}$/u
const TAG = /^[a-z][a-z0-9-]{0,31}$/

/** Where something lies in the viewer's document, in CSS pixels from its top left. */
export interface DocBox {
  x: number
  y: number
  width: number
  height: number
}

/** A heading of the shown version: where it starts in the Markdown, its section's slug and place. */
export interface DocHeading {
  at: number
  level: number
  slug: string
  text: string
  y: number
}

/** Where a block the window asked for lies, by where it starts in the Markdown. */
export interface DocPlace {
  at: number
  y: number
  height: number
}

/** A block typed in that did not save: where it starts, its Markdown as it was and as typed. */
export interface DocKept {
  at: number
  was: string
  now: string
}

/** How a typed change is saving: the version it saved as, and whether Undo can take it back. */
export type DocSaveState = 'editing' | 'saving' | 'saved' | 'failed' | 'conflict' | 'refused'

export type DocReport =
  | {
      t: 'layout'
      /** The version laid out. */
      version: number
      height: number
      headings: DocHeading[]
      places: DocPlace[]
    }
  /** A block clicked in comment mode: where it starts, its element and the start of its words. */
  | { t: 'pick'; at: number; tag: string; text: string; box: DocBox }
  /** Words selected in one block, or the selection gone when `at` is null. */
  | { t: 'select'; at: number; tag: string; text: string; quote: string; box: DocBox }
  | { t: 'select'; at: null }
  | {
      t: 'save'
      state: DocSaveState
      version: number | null
      undo: boolean
      /**
       * What was typed and did not save, for the window to hand back in a later frame; null once
       * nothing waits. Older viewers leave it out.
       */
      kept?: DocKept | null
    }

/** How the window wants the document shown. */
export interface DocState {
  /** The window scrolls the sheet and the viewer lays the whole document out at its height. */
  embed: boolean
  /** The room on either side of the text, in pixels. */
  pad: number
  /** The type size, in percent. */
  size: number
  theme: 'light' | 'dark'
  mode: 'view' | 'comment' | 'edit'
  /** The version to show, read through the content capability when it is not the one loaded. */
  version: number
  /** The blocks whose places the layout reports, by where they start in the Markdown. */
  track: number[]
  /**
   * What the shown version changed from `from`, to mark; null for nothing. `sections` is the
   * version that last changed each section, by its slug, when it is not the shown one.
   */
  marks: {
    from: number
    passages: ChangedPassage[]
    sections?: Readonly<Record<string, number>>
  } | null
  /** Show the earlier words beside the new ones in the text. */
  changes: boolean
  /** The block being visited, a changed passage or a heading landed on, by where it starts. */
  step: number | null
  /** The block a comment is being written on or a thread is open under, outlined. */
  focus: number | null
  /** Motion is reduced: nothing flashes. Older windows leave it out. */
  still?: boolean
  /**
   * An agent writing the document, by the section's slug, or null for all of it, with the words
   * of its tag; left out or null when no agent writes. Older windows leave it out.
   */
  writing?: { section: string | null; tag: string } | null
  /** What an earlier frame typed and could not save, to show again as typed. */
  kept?: DocKept | null
}

export type DocDrive =
  | { v: typeof RUNTIME_VERSION; kind: 'select-doc'; channel: string; state: DocState }
  | { v: typeof RUNTIME_VERSION; kind: 'select-doc-do'; do: 'undo' | 'retry' }

/** The event the document viewer dispatches on its window for the page script to report. */
export const DOC_REPORT_EVENT = 'kettu:document-report'

type Fields = Record<string, unknown>

function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function offset(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_OFFSET
    ? (value as number)
    : null
}

function px(value: unknown, signed = false): number | null {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value <= MAX_PX &&
    value >= (signed ? -MAX_PX : 0)
    ? Math.round(value * 100) / 100
    : null
}

/** Text from the page on one line, capped; null when it is not text. */
function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const line = value.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim()
  return Array.from(line).slice(0, max).join('')
}

function box(value: unknown): DocBox | null {
  if (!isRecord(value)) return null
  const x = px(value.x, true)
  const y = px(value.y, true)
  const width = px(value.width)
  const height = px(value.height)
  return x === null || y === null || width === null || height === null
    ? null
    : { x, y, width, height }
}

/** What the page says it typed, or null when it is not that or too long to keep. */
export function parseDocKept(value: unknown): DocKept | null {
  if (!isRecord(value)) return null
  const at = offset(value.at)
  const { was, now } = value
  if (at === null || typeof was !== 'string' || typeof now !== 'string') return null
  if (was.length > DOC_KEPT_CHARS || now.length > DOC_KEPT_CHARS) return null
  return { at, was, now }
}

function heading(value: unknown): DocHeading | null {
  if (!isRecord(value)) return null
  const at = offset(value.at)
  const y = px(value.y)
  const words = text(value.text, DOC_TEXT_CHARS)
  const { level, slug } = value
  if (at === null || y === null || words === null) return null
  if (!Number.isInteger(level) || (level as number) < 1 || (level as number) > 6) return null
  if (typeof slug !== 'string' || !SLUG.test(slug)) return null
  return { at, level: level as number, slug, text: words, y }
}

function place(value: unknown): DocPlace | null {
  if (!isRecord(value)) return null
  const at = offset(value.at)
  const y = px(value.y)
  const height = px(value.height)
  return at === null || y === null || height === null ? null : { at, y, height }
}

function list<T>(value: unknown, max: number, each: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value) || value.length > max) return null
  const out: T[] = []
  for (const item of value) {
    const parsed = each(item)
    if (parsed === null) return null
    out.push(parsed)
  }
  return out
}

const SAVE_STATES: readonly DocSaveState[] = [
  'editing',
  'saving',
  'saved',
  'failed',
  'conflict',
  'refused',
]

/** A report of the document viewer's, or null for anything else. */
export function parseDocReport(value: unknown): DocReport | null {
  if (!isRecord(value)) return null
  switch (value.t) {
    case 'layout': {
      const version = value.version
      const height = px(value.height)
      const headings = list(value.headings, DOC_HEADINGS, heading)
      const places = list(value.places, DOC_PLACES, place)
      if (!Number.isSafeInteger(version) || (version as number) < 1) return null
      if (height === null || !headings || !places) return null
      return { t: 'layout', version: version as number, height, headings, places }
    }
    case 'pick': {
      const at = offset(value.at)
      const words = text(value.text, DOC_TEXT_CHARS)
      const where = box(value.box)
      if (at === null || words === null || !where) return null
      if (typeof value.tag !== 'string' || !TAG.test(value.tag)) return null
      return { t: 'pick', at, tag: value.tag, text: words, box: where }
    }
    case 'select': {
      if (value.at === null) return { t: 'select', at: null }
      const at = offset(value.at)
      const words = text(value.text, DOC_TEXT_CHARS)
      const quote = text(value.quote, DOC_QUOTE_CHARS)
      const where = box(value.box)
      if (at === null || words === null || !quote || !where) return null
      if (typeof value.tag !== 'string' || !TAG.test(value.tag)) return null
      return { t: 'select', at, tag: value.tag, text: words, quote, box: where }
    }
    case 'save': {
      const state = SAVE_STATES.find((s) => s === value.state)
      const version = value.version
      if (!state || typeof value.undo !== 'boolean') return null
      if (version !== null && (!Number.isSafeInteger(version) || (version as number) < 1)) {
        return null
      }
      const save = {
        t: 'save',
        state,
        version: version as number | null,
        undo: value.undo,
      } as const
      if (value.kept === undefined) return save
      return { ...save, kept: value.kept === null ? null : parseDocKept(value.kept) }
    }
    default:
      return null
  }
}

/** The headings the outline lists: a lone top heading is the document's title, not a section. */
export function outlineHeadings(headings: readonly DocHeading[]): readonly DocHeading[] {
  const first = headings[0]
  if (!first || first.level !== 1) return headings
  return headings.some((h, i) => i > 0 && h.level === 1) ? headings : headings.slice(1)
}
