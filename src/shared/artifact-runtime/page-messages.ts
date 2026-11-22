// The page runtime's wire format, version 1: what a client posts into an artifact's frame to drive
// it, what the page sends back, and the checks a client makes of it. Everything a page sends is
// untrusted: only the shapes below pass, each field capped.

import { RUNTIME_PATH, RUNTIME_VERSION, type RuntimeAnswer } from '../artifact-capabilities'
import { artifactPathProblem, isHtmlPath } from '../artifact-files'
import { parseDeckReport, type DeckDrive, type DeckReport } from './deck-sheet'
import { parseDocReport, type DocDrive, type DocReport } from './document-sheet'

export { RUNTIME_PATH, RUNTIME_VERSION, type RuntimeAnswer }

/** The most a page's message may be, as UTF-8 bytes. */
export const MESSAGE_BYTES = 64 * 1024

export const SNIPPET_CHARS = 120
const TAG = /^[a-z][a-z0-9-]{0,31}$/
const CHANNEL = /^[A-Za-z0-9_-]{8,64}$/
const ID_CHARS = 64
const MAX_OFFSET = 64 * 1024 * 1024
const MAX_PX = 10_000
const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/
export const TEXT_ALIGNS = ['left', 'center', 'right', 'justify'] as const
export type TextAlign = (typeof TEXT_ALIGNS)[number]

/** What the server tells the runtime it adds to a page. */
export interface RuntimeConfig {
  v: typeof RUNTIME_VERSION
  /** `fetch` posts to RUNTIME_PATH on the page's origin; `port` waits for the client's port. */
  transport: 'fetch' | 'port'
  /** The served file's path in its version. */
  path: string
  /** What the file's start tags are marked with, before their offsets, in this response. */
  mark: string
}

/** An element's look as the page computes it, for the edit panel to start from. */
export interface ElementStyle {
  color: string | null
  background: string | null
  fontSize: number | null
  fontWeight: number | null
  textAlign: TextAlign | null
  /** Top, right, bottom, left. */
  padding: [number, number, number, number] | null
  radius: number | null
}

/** What a page reports of the element picked in it. */
export interface PageSelection {
  /** The served file the element is in. */
  path: string
  /** Its start tag's offset in that file, or null for an element a script made. */
  src: number | null
  tag: string
  /** The start of its text. */
  text: string
  /** It holds text and no elements, so its text can be edited. */
  textOnly: boolean
  style: ElementStyle
  /** The tags of the elements it lies in, outermost first, up to the body; absent from older pages. */
  ancestors?: string[]
}

/** Where an element lies in its page, in CSS pixels from the document's top left. */
export interface PageBox {
  x: number
  y: number
  width: number
  height: number
}

/** The page's report of a pick, or of the pick cleared. */
export interface SelectMessage {
  v: typeof RUNTIME_VERSION
  id: string
  kind: 'select'
  /** The frame's, as its client gave it with select mode. */
  channel: string
  selection: PageSelection | null
  /** An answer to `select-locate` instead of a pick: where the element at `src` lies, if anywhere. */
  located?: { src: number; box: PageBox | null }
  /** A key pressed in the page, outside its text fields, instead of a pick, after `select-keys`. */
  key?: PageKey
  /** What a document's viewer reports instead of a pick, after `select-doc`. */
  doc?: DocReport
  /** What a deck's viewer reports instead of a pick, after `select-deck`. */
  deck?: DeckReport
  /** A pick that landed on a comment pin, by its number, instead of on an element. */
  pin?: number
  /** The picked element's text as typed in place after `text-edit`; `done` once typing ends. */
  typed?: { text: string; done: boolean }
}

/**
 * The keys a page passes on while asked to, so the viewer around it keeps stepping through frames
 * once the user clicked into one.
 */
export const PAGE_KEYS = ['ArrowLeft', 'ArrowRight', 'Escape', 'g'] as const
export type PageKey = (typeof PAGE_KEYS)[number]

/** A numbered pin on an element, or on the page when `src` is null or the element is gone. */
export interface Pin {
  n: number
  src: number | null
  /** The thread has an answer, so the pin goes grey. */
  answered: boolean
  /** `lost`: its element is gone, so it waits dashed on the page; `done`: resolved, a hollow check. */
  kind?: 'lost' | 'done'
  /** Its thread is open beside it. */
  active?: boolean
}

/** CSS colors a page draws comment pins in: the badge and its number, the ground under a lost or
 * resolved pin, and a resolved pin's check. The open thread's pin takes the accent. */
export interface PinColors {
  ink: string
  text: string
  ground: string
  done: string
}

/** What a client posts into a frame. The page only receives these. */
export type DriveMessage =
  | {
      v: typeof RUNTIME_VERSION
      kind: 'select-mode'
      mode: 'select' | 'comment' | null
      channel: string
      /** The outline's color, a CSS color from the app's theme. */
      accent: string
      /** The pins' colors from the app's theme; an older client sends none. */
      pinColors?: PinColors
    }
  | { v: typeof RUNTIME_VERSION; kind: 'select-point'; x: number; y: number }
  | { v: typeof RUNTIME_VERSION; kind: 'select-leave' }
  | { v: typeof RUNTIME_VERSION; kind: 'select-pick'; x: number; y: number }
  | {
      v: typeof RUNTIME_VERSION
      kind: 'select-source'
      src: number | null
      /** Report the element picked, as a pick by pointer does; the page then shows it edited. */
      tell?: boolean
    }
  | { v: typeof RUNTIME_VERSION; kind: 'select-pins'; pins: Pin[] }
  | { v: typeof RUNTIME_VERSION; kind: 'preview-style'; style: PreviewStyle }
  | { v: typeof RUNTIME_VERSION; kind: 'preview-text'; text: string }
  | { v: typeof RUNTIME_VERSION; kind: 'preview-reset' }
  | { v: typeof RUNTIME_VERSION; kind: 'transport' }
  // Where the element whose start tag lies at `src` is, answered as a select message's `located`.
  | { v: typeof RUNTIME_VERSION; kind: 'select-locate'; src: number; channel: string }
  // Values for the parameters the page declares, shown at once and kept until the page reloads.
  | { v: typeof RUNTIME_VERSION; kind: 'params'; values: Record<string, string | number | boolean> }
  // The frame loads the next version of this page now, which comes back where this one is scrolled.
  | { v: typeof RUNTIME_VERSION; kind: 'keep-scroll' }
  // Pass PAGE_KEYS on as select messages with `key`, or stop.
  | { v: typeof RUNTIME_VERSION; kind: 'select-keys'; on: boolean; channel: string }
  // How a document's viewer shows its document, and what it does once.
  | DocDrive
  // Which slide a deck's viewer shows and how, and what it does once.
  | DeckDrive
  // Scrolls the element whose start tag lies at `src` into view, as a thread's card asks.
  | { v: typeof RUNTIME_VERSION; kind: 'select-reveal'; src: number }
  // Scrolls the page while a pick layer over it takes the wheel.
  | { v: typeof RUNTIME_VERSION; kind: 'select-scroll'; dx: number; dy: number }
  // Picks the element around the picked one, reported as a pick.
  | { v: typeof RUNTIME_VERSION; kind: 'select-up'; levels: number }
  // Lets the user type the picked element's text in place, reported as `typed`, or stops.
  | { v: typeof RUNTIME_VERSION; kind: 'text-edit'; on: boolean }

/** The properties a direct edit may write into a start tag's `style`, by their CSS names. */
export const EDITABLE_PROPERTIES = [
  'color',
  'background-color',
  'font-size',
  'font-weight',
  'text-align',
  'padding',
  'border-radius',
] as const
export type EditableProperty = (typeof EDITABLE_PROPERTIES)[number]
export type PreviewStyle = Partial<Record<EditableProperty, string>>

export const EDIT_TEXT_CHARS = 10_000

const PX = /^(0|[1-9][0-9]{0,3})(\.[0-9]{1,2})?px$/
const VALUE_CHECKS: Readonly<Record<EditableProperty, (value: string) => boolean>> = {
  color: (v) => HEX.test(v),
  'background-color': (v) => HEX.test(v),
  'font-size': (v) => PX.test(v) && parseFloat(v) >= 1,
  'font-weight': (v) => /^[1-9]00$/.test(v),
  'text-align': (v) => (TEXT_ALIGNS as readonly string[]).includes(v),
  padding: (v) => {
    const parts = v.split(' ')
    return parts.length >= 1 && parts.length <= 4 && parts.every((part) => PX.test(part))
  },
  'border-radius': (v) => PX.test(v),
}

/**
 * Whether `value` may be written as `property` in a start tag's style: a hex color, pixels, a
 * weight or an alignment, so nothing in it can end the declaration or the attribute.
 */
export function isEditableValue(property: string, value: unknown): boolean {
  return (
    typeof value === 'string' &&
    Object.hasOwn(VALUE_CHECKS, property) &&
    VALUE_CHECKS[property as EditableProperty](value)
  )
}

/** A style for the preview and the edit: each property checked, the rest dropped. */
export function checkedStyle(value: unknown): PreviewStyle | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const style: PreviewStyle = {}
  for (const [property, v] of Object.entries(value)) {
    if (!isEditableValue(property, v)) return null
    style[property as EditableProperty] = v as string
  }
  return style
}

type Fields = Record<string, unknown>

function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function px(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_PX
    ? Math.round(value * 100) / 100
    : null
}

function style(value: unknown): ElementStyle {
  const o = isRecord(value) ? value : {}
  const color = (v: unknown): string | null =>
    typeof v === 'string' && HEX.test(v.toLowerCase()) ? v.toLowerCase() : null
  const weight = o.fontWeight
  const padding = o.padding
  return {
    color: color(o.color),
    background: color(o.background),
    fontSize: px(o.fontSize),
    fontWeight:
      typeof weight === 'number' && Number.isInteger(weight) && weight >= 1 && weight <= 1000
        ? weight
        : null,
    textAlign: (TEXT_ALIGNS as readonly unknown[]).includes(o.textAlign)
      ? (o.textAlign as TextAlign)
      : null,
    padding:
      Array.isArray(padding) && padding.length === 4 && padding.every((p) => px(p) !== null)
        ? (padding.map((p) => px(p)!) as [number, number, number, number])
        : null,
    radius: px(o.radius),
  }
}

/** Text from a page as one line, capped; it is only ever shown as plain text. */
export function snippet(value: unknown, max = SNIPPET_CHARS): string {
  if (typeof value !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  const line = value.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim()
  return Array.from(line).slice(0, max).join('')
}

function selection(value: unknown): PageSelection | null | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  const { path, src, tag, textOnly } = value
  if (typeof path !== 'string' || artifactPathProblem(path) !== null || !isHtmlPath(path)) {
    return undefined
  }
  if (
    src !== null &&
    !(Number.isSafeInteger(src) && (src as number) >= 0 && (src as number) <= MAX_OFFSET)
  ) {
    return undefined
  }
  if (typeof tag !== 'string' || !TAG.test(tag)) return undefined
  const picked: PageSelection = {
    path,
    src: src as number | null,
    tag,
    text: snippet(value.text),
    textOnly: textOnly === true,
    style: style(value.style),
  }
  const { ancestors } = value
  if (Array.isArray(ancestors)) {
    picked.ancestors = ancestors
      .slice(-ANCESTORS)
      .filter((a): a is string => typeof a === 'string' && TAG.test(a))
  }
  return picked
}

/** The most ancestors a pick names. */
export const ANCESTORS = 8

/** A page's `select` message, or null for anything else. */
export function parseSelectMessage(value: unknown): SelectMessage | null {
  if (!isRecord(value) || value.v !== RUNTIME_VERSION || value.kind !== 'select') return null
  const { id, channel } = value
  if (typeof id !== 'string' || id.length === 0 || id.length > ID_CHARS) return null
  if (typeof channel !== 'string' || !CHANNEL.test(channel)) return null
  const picked = selection(value.selection)
  if (picked === undefined) return null
  const message: SelectMessage = {
    v: RUNTIME_VERSION,
    id,
    kind: 'select',
    channel,
    selection: picked,
  }
  if (value.located !== undefined) {
    const located = locatedOf(value.located)
    if (!located || picked !== null) return null
    message.located = located
  }
  if (value.key !== undefined) {
    const key = PAGE_KEYS.find((k) => k === value.key)
    if (!key || picked !== null || message.located) return null
    message.key = key
  }
  if (value.doc !== undefined) {
    const doc = parseDocReport(value.doc)
    if (!doc || picked !== null || message.located || message.key) return null
    message.doc = doc
  }
  if (value.deck !== undefined) {
    const deck = parseDeckReport(value.deck)
    if (!deck || picked !== null || message.located || message.key || message.doc) return null
    message.deck = deck
  }
  if (value.pin !== undefined) {
    const pin = value.pin
    if (!Number.isSafeInteger(pin) || (pin as number) < 1 || (pin as number) > MAX_PINS) return null
    if (picked !== null || message.located || message.key || message.doc || message.deck) {
      return null
    }
    message.pin = pin as number
  }
  if (value.typed !== undefined) {
    const typed = value.typed
    if (!isRecord(typed) || typeof typed.text !== 'string' || typeof typed.done !== 'boolean') {
      return null
    }
    if (typed.text.length > EDIT_TEXT_CHARS || picked !== null || message.located || message.key) {
      return null
    }
    if (message.pin !== undefined || message.doc || message.deck) return null
    message.typed = { text: typed.text, done: typed.done }
  }
  return message
}

/** The most pins a page draws. */
export const MAX_PINS = 1_000

function locatedOf(value: unknown): { src: number; box: PageBox | null } | null {
  if (!isRecord(value)) return null
  const { src, box } = value
  if (!Number.isSafeInteger(src) || (src as number) < 0 || (src as number) > MAX_OFFSET) return null
  if (box === null) return { src: src as number, box: null }
  if (!isRecord(box)) return null
  const n = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e6
  if (
    !n(box.x) ||
    !n(box.y) ||
    !n(box.width) ||
    !n(box.height) ||
    box.width < 0 ||
    box.height < 0
  ) {
    return null
  }
  return { src: src as number, box: { x: box.x, y: box.y, width: box.width, height: box.height } }
}

/** The most uncaught errors a page reports in one load; the runtime sends no more. */
export const PAGE_ERRORS = 20
export const ERROR_MESSAGE_CHARS = 300
const SOURCE_CHARS = 200
const MAX_LINE = 10_000_000
const LOAD = /^[A-Za-z0-9_-]{8,32}$/

/**
 * An uncaught error or unhandled rejection in a page's own script, as the page said it: only ever
 * shown as plain text and handed to an agent as data.
 */
export interface PageError {
  kind: 'error' | 'rejection'
  message: string
  /** The script's path on the artifact's origin, where the page named one. */
  source: string | null
  line: number | null
  column: number | null
}

/** A page's report of one error: the served file it is in and the page load it happened in. */
export interface PageErrorMessage {
  v: typeof RUNTIME_VERSION
  id: string
  kind: 'page-error'
  path: string
  /** The page's own random name for the load, which a reload replaces. */
  load: string
  error: PageError
}

function position(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_LINE
    ? (value as number)
    : null
}

/** A page's `page-error` message, its fields capped, or null for anything else. */
export function parsePageError(value: unknown): PageErrorMessage | null {
  if (!isRecord(value) || value.v !== RUNTIME_VERSION || value.kind !== 'page-error') return null
  const { id, path, load, error } = value
  if (typeof id !== 'string' || id.length === 0 || id.length > ID_CHARS) return null
  if (typeof path !== 'string' || artifactPathProblem(path) !== null || !isHtmlPath(path)) {
    return null
  }
  if (typeof load !== 'string' || !LOAD.test(load) || !isRecord(error)) return null
  const message = snippet(error.message, ERROR_MESSAGE_CHARS)
  const source = snippet(error.source, SOURCE_CHARS)
  return {
    v: RUNTIME_VERSION,
    id,
    kind: 'page-error',
    path,
    load,
    error: {
      kind: error.kind === 'rejection' ? 'rejection' : 'error',
      message: message === '' ? 'Error' : message,
      source: source === '' ? null : source,
      line: position(error.line),
      column: position(error.column),
    },
  }
}

/** A page's message by its kind: phase-owned `select` and `preview` ones, or a capability's. */
export type PageMessage =
  | { kind: 'select'; message: SelectMessage }
  | { kind: 'error'; message: PageErrorMessage }
  | { kind: 'capability'; message: Fields & { v: 1; id: string; kind: string } }

/** A message's text from a page, parsed and sorted, or null when it is not a version 1 message. */
export function parsePageMessage(value: unknown): PageMessage | null {
  if (!isRecord(value) || value.v !== RUNTIME_VERSION) return null
  const { id, kind } = value
  if (typeof id !== 'string' || id.length === 0 || id.length > ID_CHARS) return null
  if (typeof kind !== 'string' || kind.length > 32) return null
  if (kind.startsWith('select') || kind.startsWith('preview')) {
    const message = parseSelectMessage(value)
    return message ? { kind: 'select', message } : null
  }
  if (kind === 'page-error') {
    const message = parsePageError(value)
    return message ? { kind: 'error', message } : null
  }
  return { kind: 'capability', message: value as Fields & { v: 1; id: string; kind: string } }
}

/**
 * What a client answers a capability message with while it has no capabilities to offer: `use`
 * finds none, and anything else is unsupported.
 */
export function noCapability(message: { id: string; kind: string }): RuntimeAnswer {
  if (message.kind === 'use') return { v: RUNTIME_VERSION, id: message.id, ok: true, value: null }
  return {
    v: RUNTIME_VERSION,
    id: message.id,
    ok: false,
    error: { code: 'unsupported', message: 'Kettu offers no such capability here' },
  }
}

/** The answer to a message a client took but has nothing to return for. */
export function received(id: string): RuntimeAnswer {
  return { v: RUNTIME_VERSION, id, ok: true, value: null }
}

/** A channel for a frame's reports, which routes them to the frame that asked; not a secret. */
export function isChannel(value: unknown): value is string {
  return typeof value === 'string' && CHANNEL.test(value)
}
