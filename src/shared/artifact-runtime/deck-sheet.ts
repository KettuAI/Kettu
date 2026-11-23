// What the slides viewer and the window that holds it say to each other while a deck is shown one
// slide at a time in the artifact viewer. The window drives the viewer with one state: which slide,
// in which mode, and which elements to find on it; it hands it the notes typed under a slide and
// asks it to undo or retry a save. The viewer reports where those elements lie, an element picked
// to comment on and how a typed change is saving. What the viewer reports is the page's, untrusted:
// only the shapes below pass, each field capped, and it is only ever data.

import { RUNTIME_VERSION } from '../artifact-capabilities'

/** The most elements the window asks the viewer to find on a slide, and a layout reports. */
export const DECK_TRACKED = 100
/** The most characters of an element's words a report carries, and of notes the window hands. */
export const DECK_TEXT_CHARS = 120
export const DECK_NOTES_CHARS = 5000
/** The most slides a deck has, as its format caps them. */
export const DECK_MAX_SLIDE = 200

/** The most texts a failed save carries, and how deep in the deck one may lie. */
export const DECK_KEPT_TEXTS = 40
const KEPT_PATH_DEPTH = 8
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const MAX_PX = 100_000
const KEY = /^[A-Za-z0-9_-]{1,64}$/
const TAG = /^[a-z][a-z0-9-]{0,31}$/

/** Where an element lies on its slide, in the slide's own pixels from its top left. */
export interface DeckBox {
  x: number
  y: number
  width: number
  height: number
}

/** An element the window asks for, by its tag and the start of its words; `key` names it back. */
export interface DeckTrack {
  key: string
  tag: string
  text: string
}

/** Where a tracked element was found on the shown slide. */
export interface DeckPlace {
  key: string
  box: DeckBox
}

/** How a typed change is saving: the version it saved as, and whether Undo can take it back. */
/** A text typed on a slide that did not save: where it lies in the deck, and the text. */
export interface DeckKept {
  path: (string | number)[]
  text: string
}

export type DeckSaveState = 'editing' | 'saving' | 'saved' | 'failed' | 'conflict' | 'refused'

export type DeckReport =
  /** The slide shown, from 1, in the version shown, and where the tracked elements lie on it. */
  | { t: 'layout'; version: number; slide: number; places: DeckPlace[] }
  /** An element clicked in comment mode: its slide, its tag, the start of its words and place. */
  | { t: 'pick'; slide: number; tag: string; text: string; box: DeckBox }
  | {
      t: 'save'
      state: DeckSaveState
      version: number | null
      undo: boolean
      /**
       * The texts typed that did not save, for the window to hand back in a later frame; empty
       * once nothing waits. Older viewers leave it out.
       */
      kept?: DeckKept[]
    }

/** How the window wants the deck shown. */
export interface DeckState {
  /** The slide to show, from 1. */
  slide: number
  mode: 'view' | 'comment' | 'edit'
  /** The version to show, read through the content capability when it is not the one loaded. */
  version: number
  /** The elements to find on the shown slide. */
  track: DeckTrack[]
  /** The element a comment is being written on or a thread is open for, outlined; by its key. */
  focus: string | null
  /** What an earlier frame typed and could not save, to show again as typed. */
  kept?: DeckKept[]
}

export type DeckDrive =
  | { v: typeof RUNTIME_VERSION; kind: 'select-deck'; channel: string; state: DeckState }
  | { v: typeof RUNTIME_VERSION; kind: 'select-deck-do'; do: 'undo' | 'retry' }
  /** The speaker notes typed under a slide, to save as the deck's. */
  | { v: typeof RUNTIME_VERSION; kind: 'select-deck-notes'; slide: number; text: string }

/** The event the slides viewer dispatches on its window for the page script to report. */
export const DECK_REPORT_EVENT = 'kettu:deck-report'

type Fields = Record<string, unknown>

function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function px(value: unknown, signed = false): number | null {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value <= MAX_PX &&
    value >= (signed ? -MAX_PX : 0)
    ? Math.round(value * 100) / 100
    : null
}

function slide(value: unknown): number | null {
  return Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= DECK_MAX_SLIDE
    ? (value as number)
    : null
}

/** Text from the page on one line, capped; null when it is not text. */
function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const line = value.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim()
  return Array.from(line).slice(0, max).join('')
}

function box(value: unknown): DeckBox | null {
  if (!isRecord(value)) return null
  const x = px(value.x, true)
  const y = px(value.y, true)
  const width = px(value.width)
  const height = px(value.height)
  return x === null || y === null || width === null || height === null
    ? null
    : { x, y, width, height }
}

function place(value: unknown): DeckPlace | null {
  if (!isRecord(value)) return null
  const where = box(value.box)
  if (typeof value.key !== 'string' || !KEY.test(value.key) || !where) return null
  return { key: value.key, box: where }
}

/** The texts the page says it typed; one that is not a text of a deck is left out. */
export function parseDeckKept(value: unknown): DeckKept[] {
  if (!Array.isArray(value)) return []
  const out: DeckKept[] = []
  for (const item of value.slice(0, DECK_KEPT_TEXTS)) {
    if (!isRecord(item) || typeof item.text !== 'string' || !Array.isArray(item.path)) continue
    if (item.text.length > DECK_NOTES_CHARS) continue
    const path = item.path as unknown[]
    if (path.length === 0 || path.length > KEPT_PATH_DEPTH) continue
    const named = path.every(
      (step) =>
        (typeof step === 'string' && KEY.test(step) && !UNSAFE_KEYS.has(step)) ||
        (Number.isSafeInteger(step) && (step as number) >= 0 && (step as number) < 10_000),
    )
    if (named) out.push({ path: path as (string | number)[], text: item.text })
  }
  return out
}

const SAVE_STATES: readonly DeckSaveState[] = [
  'editing',
  'saving',
  'saved',
  'failed',
  'conflict',
  'refused',
]

/** A report of the slides viewer's, or null for anything else. */
export function parseDeckReport(value: unknown): DeckReport | null {
  if (!isRecord(value)) return null
  switch (value.t) {
    case 'layout': {
      const version = value.version
      const at = slide(value.slide)
      if (!Number.isSafeInteger(version) || (version as number) < 1 || at === null) return null
      if (!Array.isArray(value.places) || value.places.length > DECK_TRACKED) return null
      const places: DeckPlace[] = []
      for (const item of value.places) {
        const parsed = place(item)
        if (!parsed) return null
        places.push(parsed)
      }
      return { t: 'layout', version: version as number, slide: at, places }
    }
    case 'pick': {
      const at = slide(value.slide)
      const words = text(value.text, DECK_TEXT_CHARS)
      const where = box(value.box)
      if (at === null || words === null || !where) return null
      if (typeof value.tag !== 'string' || !TAG.test(value.tag)) return null
      return { t: 'pick', slide: at, tag: value.tag, text: words, box: where }
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
      return value.kept === undefined ? save : { ...save, kept: parseDeckKept(value.kept) }
    }
    default:
      return null
  }
}

/** A key the window names a tracked element by: letters, digits, `-` and `_`. */
export function isDeckKey(value: string): boolean {
  return KEY.test(value)
}
