// The page runtime's wire format, version 1: what a client posts into an artifact's frame to drive
// it, what the page sends back, and the checks a client makes of it. Everything a page sends is
// untrusted: only the shapes below pass, each field capped.

import { artifactPathProblem, isHtmlPath } from '../artifact-files'

export const RUNTIME_VERSION = 1

/** Where a desktop page posts its messages, on its own origin. */
export const RUNTIME_PATH = '/_kettu/v1'

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
}

/** The page's report of a pick, or of the pick cleared. */
export interface SelectMessage {
  v: typeof RUNTIME_VERSION
  id: string
  kind: 'select'
  /** The frame's, as its client gave it with select mode. */
  channel: string
  selection: PageSelection | null
}

/** A numbered pin on an element, or on the page when `src` is null or the element is gone. */
export interface Pin {
  n: number
  src: number | null
  /** The thread has an answer, so the pin goes grey. */
  answered: boolean
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
    }
  | { v: typeof RUNTIME_VERSION; kind: 'select-point'; x: number; y: number }
  | { v: typeof RUNTIME_VERSION; kind: 'select-leave' }
  | { v: typeof RUNTIME_VERSION; kind: 'select-pick'; x: number; y: number }
  | { v: typeof RUNTIME_VERSION; kind: 'select-source'; src: number | null }
  | { v: typeof RUNTIME_VERSION; kind: 'select-pins'; pins: Pin[] }
  | { v: typeof RUNTIME_VERSION; kind: 'preview-style'; style: PreviewStyle }
  | { v: typeof RUNTIME_VERSION; kind: 'preview-text'; text: string }
  | { v: typeof RUNTIME_VERSION; kind: 'preview-reset' }
  | { v: typeof RUNTIME_VERSION; kind: 'transport' }

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
export function snippet(value: unknown): string {
  if (typeof value !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  const line = value.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim()
  return Array.from(line).slice(0, SNIPPET_CHARS).join('')
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
  return {
    path,
    src: src as number | null,
    tag,
    text: snippet(value.text),
    textOnly: textOnly === true,
    style: style(value.style),
  }
}

/** A page's `select` message, or null for anything else. */
export function parseSelectMessage(value: unknown): SelectMessage | null {
  if (!isRecord(value) || value.v !== RUNTIME_VERSION || value.kind !== 'select') return null
  const { id, channel } = value
  if (typeof id !== 'string' || id.length === 0 || id.length > ID_CHARS) return null
  if (typeof channel !== 'string' || !CHANNEL.test(channel)) return null
  const picked = selection(value.selection)
  if (picked === undefined) return null
  return { v: RUNTIME_VERSION, id, kind: 'select', channel, selection: picked }
}

/** The answer to a message, as a page reads it. */
export type RuntimeAnswer =
  | { v: typeof RUNTIME_VERSION; id: string; ok: true; value: unknown }
  | { v: typeof RUNTIME_VERSION; id: string; ok: false; error: { code: string; message: string } }

/** A page's message by its kind: phase-owned `select` and `preview` ones, or a capability's. */
export type PageMessage =
  | { kind: 'select'; message: SelectMessage }
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
