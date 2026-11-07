// A canvas artifact's document: its canvases, the sections and pages on them and the notes drawn
// over them. It is the entry of a canvas, stored as `canvas.json` in each version; pages are HTML
// files of the same version. Clients and agents change it through operations, which the agent
// host applies in arrival order, the last one winning per property.

export const CANVAS_FILE = 'canvas.json'
export const CANVAS_FORMAT = 1

/** The most of each kind of object a document holds. */
export const CANVAS_LIMITS = {
  canvases: 50,
  sections: 500,
  pages: 500,
  notes: 5000,
  /** Numbers in one pen stroke: x, y and pressure for each point. */
  penNumbers: 30_000,
  /** The document as JSON, in UTF-16 units. */
  chars: 5 * 1024 * 1024,
  ops: 2000,
} as const

export const NAME_CHARS = 120
export const NOTE_TEXT_CHARS = 4000
export const PAGE_MIN = 64
export const PAGE_MAX = 8000
export const DEFAULT_PAGE = { width: 1280, height: 800 }
/** Far enough for any layout, near enough that a coordinate never loses precision. */
const COORD_MAX = 1_000_000

/** Between pages in a row, and around the pages of a section. */
export const PAGE_GAP = 48
export const SECTION_PAD = 40
/** The band at a section's top that holds its title. */
export const SECTION_HEAD = 56
/** Between a section and what is placed below it. */
export const SECTION_GAP = 160

const ID = /^[A-Za-z0-9_-]{1,64}$/

export type NoteKind = 'text' | 'sticky' | 'pen' | 'rect' | 'ellipse' | 'line' | 'arrow'
export const NOTE_KINDS: readonly NoteKind[] = [
  'text',
  'sticky',
  'pen',
  'rect',
  'ellipse',
  'line',
  'arrow',
]

/** Colors a note may take: names the interface maps to its palette, so both themes read them. */
export const NOTE_COLORS = ['ink', 'red', 'orange', 'yellow', 'green', 'blue', 'violet'] as const
export type NoteColor = (typeof NOTE_COLORS)[number]

export interface CanvasSheet {
  id: string
  name: string
}

export interface CanvasSection {
  id: string
  canvas: string
  title: string
}

export interface CanvasPage {
  id: string
  canvas: string
  section: string | null
  name: string
  /** The page's HTML file in the artifact. */
  file: string
  x: number
  y: number
  width: number
  height: number
  locked: boolean
}

interface NoteBase {
  id: string
  canvas: string
  color: NoteColor
  locked: boolean
  /** Who drew it: a session id, or null for the user. */
  by: string | null
}

export interface TextNote extends NoteBase {
  kind: 'text'
  x: number
  y: number
  text: string
  size: number
}

export interface StickyNote extends NoteBase {
  kind: 'sticky'
  x: number
  y: number
  width: number
  text: string
  /** An agent or the user marked it handled. */
  done: boolean
}

export interface PenNote extends NoteBase {
  kind: 'pen'
  /** x, y and pressure (0 to 1) of each point, in canvas pixels. */
  points: number[]
  width: number
  marker: boolean
}

export interface ShapeNote extends NoteBase {
  kind: 'rect' | 'ellipse' | 'line' | 'arrow'
  /** A rectangle or an ellipse fills the box from (x1, y1) to (x2, y2); a line runs along it. */
  x1: number
  y1: number
  x2: number
  y2: number
  width: number
  /** A line or arrow joined to a page's edge follows the page; its own point is kept for when it leaves. */
  from: string | null
  to: string | null
}

export type CanvasNote = TextNote | StickyNote | PenNote | ShapeNote

export interface CanvasDoc {
  format: typeof CANVAS_FORMAT
  canvases: CanvasSheet[]
  sections: CanvasSection[]
  /** In paint order, first at the back. */
  pages: CanvasPage[]
  /** In paint order, over the pages. */
  notes: CanvasNote[]
}

export type CanvasObject =
  | ({ type: 'canvas' } & CanvasSheet)
  | ({ type: 'section' } & CanvasSection)
  | ({ type: 'page' } & CanvasPage)
  | ({ type: 'note' } & CanvasNote)

/**
 * A change to a document: add an object, set one property of one, remove one with what hangs
 * off it, or move one in its list's paint order.
 */
export type CanvasOp =
  | { op: 'add'; object: CanvasObject }
  | { op: 'set'; id: string; key: string; value: unknown }
  | { op: 'remove'; id: string }
  | { op: 'order'; id: string; index: number }

export class CanvasError extends Error {}

function fail(message: string): never {
  throw new CanvasError(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, what: string, max: number, empty = false): string {
  if (typeof value !== 'string') fail(`${what} must be a string`)
  const trimmed = value.trim()
  if (!empty && trimmed === '') fail(`${what} must not be empty`)
  if ([...value].length > max) fail(`${what} is longer than ${max} characters`)
  return trimmed
}

function id(value: unknown, what: string): string {
  if (typeof value !== 'string' || !ID.test(value)) {
    fail(`${what} must be 1 to 64 letters, digits, "-" or "_"`)
  }
  return value
}

function coord(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > COORD_MAX) {
    fail(`${what} must be a number between -${COORD_MAX} and ${COORD_MAX}`)
  }
  return Math.round(value * 100) / 100
}

function size(value: unknown, what: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < PAGE_MIN ||
    value > PAGE_MAX
  ) {
    fail(`${what} must be a number from ${PAGE_MIN} to ${PAGE_MAX}`)
  }
  return Math.round(value)
}

function bool(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') fail(`${what} must be true or false`)
  return value
}

function stroke(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.5 || value > 64) {
    fail(`${what} must be a number from 0.5 to 64`)
  }
  return Math.round(value * 10) / 10
}

function color(value: unknown, what: string): NoteColor {
  if (typeof value !== 'string' || !(NOTE_COLORS as readonly string[]).includes(value)) {
    fail(`${what} must be one of ${NOTE_COLORS.join(', ')}`)
  }
  return value as NoteColor
}

function ref(value: unknown, what: string): string | null {
  return value === null || value === undefined ? null : id(value, what)
}

function author(value: unknown, what: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || value.length === 0 || value.length > 200)
    fail(`${what} is not valid`)
  return value
}

/** A file path a page may name: relative, inside the artifact, an HTML file. */
function pageFile(value: unknown, what: string): string {
  const path = text(value, what, 512)
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..') ||
    path.startsWith('_kettu') ||
    !/\.html?$/i.test(path)
  ) {
    fail(`${what} must be a relative path to an .html file of the artifact`)
  }
  return path
}

function only(record: Record<string, unknown>, keys: readonly string[], what: string): void {
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) fail(`${what} has an unknown property "${key}"`)
  }
}

const SHEET_KEYS = ['id', 'name'] as const
const SECTION_KEYS = ['id', 'canvas', 'title'] as const
const PAGE_KEYS = [
  'id',
  'canvas',
  'section',
  'name',
  'file',
  'x',
  'y',
  'width',
  'height',
  'locked',
] as const
const NOTE_KEYS: Record<NoteKind, readonly string[]> = {
  text: ['id', 'canvas', 'kind', 'color', 'locked', 'by', 'x', 'y', 'text', 'size'],
  sticky: ['id', 'canvas', 'kind', 'color', 'locked', 'by', 'x', 'y', 'width', 'text', 'done'],
  pen: ['id', 'canvas', 'kind', 'color', 'locked', 'by', 'points', 'width', 'marker'],
  rect: [
    'id',
    'canvas',
    'kind',
    'color',
    'locked',
    'by',
    'x1',
    'y1',
    'x2',
    'y2',
    'width',
    'from',
    'to',
  ],
  ellipse: [
    'id',
    'canvas',
    'kind',
    'color',
    'locked',
    'by',
    'x1',
    'y1',
    'x2',
    'y2',
    'width',
    'from',
    'to',
  ],
  line: [
    'id',
    'canvas',
    'kind',
    'color',
    'locked',
    'by',
    'x1',
    'y1',
    'x2',
    'y2',
    'width',
    'from',
    'to',
  ],
  arrow: [
    'id',
    'canvas',
    'kind',
    'color',
    'locked',
    'by',
    'x1',
    'y1',
    'x2',
    'y2',
    'width',
    'from',
    'to',
  ],
}

function sheetOf(value: unknown, what: string): CanvasSheet {
  if (!isRecord(value)) fail(`${what} must be an object`)
  only(value, SHEET_KEYS, what)
  return { id: id(value.id, `${what}.id`), name: text(value.name, `${what}.name`, NAME_CHARS) }
}

function sectionOf(value: unknown, what: string): CanvasSection {
  if (!isRecord(value)) fail(`${what} must be an object`)
  only(value, SECTION_KEYS, what)
  return {
    id: id(value.id, `${what}.id`),
    canvas: id(value.canvas, `${what}.canvas`),
    title: text(value.title, `${what}.title`, NAME_CHARS),
  }
}

/** A page as written; its place may be missing, for `placePages` to fill in. */
type LoosePage = Omit<CanvasPage, 'x' | 'y'> & { x: number | null; y: number | null }

function pageOf(value: unknown, what: string): LoosePage {
  if (!isRecord(value)) fail(`${what} must be an object`)
  only(value, PAGE_KEYS, what)
  return {
    id: id(value.id, `${what}.id`),
    canvas: id(value.canvas, `${what}.canvas`),
    section: ref(value.section, `${what}.section`),
    name: text(value.name, `${what}.name`, NAME_CHARS),
    file: pageFile(value.file, `${what}.file`),
    x: value.x === undefined || value.x === null ? null : coord(value.x, `${what}.x`),
    y: value.y === undefined || value.y === null ? null : coord(value.y, `${what}.y`),
    width: value.width === undefined ? DEFAULT_PAGE.width : size(value.width, `${what}.width`),
    height: value.height === undefined ? DEFAULT_PAGE.height : size(value.height, `${what}.height`),
    locked: value.locked === undefined ? false : bool(value.locked, `${what}.locked`),
  }
}

function noteOf(value: unknown, what: string): CanvasNote {
  if (!isRecord(value)) fail(`${what} must be an object`)
  const kind = value.kind
  if (typeof kind !== 'string' || !(NOTE_KINDS as readonly string[]).includes(kind)) {
    fail(`${what}.kind must be one of ${NOTE_KINDS.join(', ')}`)
  }
  only(value, NOTE_KEYS[kind as NoteKind], what)
  const base = {
    id: id(value.id, `${what}.id`),
    canvas: id(value.canvas, `${what}.canvas`),
    color:
      value.color === undefined
        ? kind === 'sticky'
          ? 'yellow'
          : 'ink'
        : color(value.color, `${what}.color`),
    locked: value.locked === undefined ? false : bool(value.locked, `${what}.locked`),
    by: author(value.by, `${what}.by`),
  }
  switch (kind) {
    case 'text':
      return {
        ...base,
        kind,
        x: coord(value.x, `${what}.x`),
        y: coord(value.y, `${what}.y`),
        text: text(value.text, `${what}.text`, NOTE_TEXT_CHARS),
        size:
          value.size === undefined
            ? 24
            : Math.round(Math.min(400, Math.max(8, coord(value.size, `${what}.size`)))),
      }
    case 'sticky':
      return {
        ...base,
        kind,
        x: coord(value.x, `${what}.x`),
        y: coord(value.y, `${what}.y`),
        width:
          value.width === undefined
            ? 240
            : Math.min(2000, Math.max(80, coord(value.width, `${what}.width`))),
        text: text(value.text, `${what}.text`, NOTE_TEXT_CHARS, true),
        done: value.done === undefined ? false : bool(value.done, `${what}.done`),
      }
    case 'pen': {
      const points = value.points
      if (!Array.isArray(points) || points.length < 3 || points.length % 3 !== 0) {
        fail(`${what}.points must hold x, y and pressure for each of at least one point`)
      }
      if (points.length > CANVAS_LIMITS.penNumbers) fail(`${what}.points has too many points`)
      const out = points.map((n, i) =>
        i % 3 === 2
          ? typeof n === 'number' && n >= 0 && n <= 1
            ? Math.round(n * 100) / 100
            : fail(`${what}.points has a pressure outside 0 to 1`)
          : coord(n, `${what}.points`),
      )
      return {
        ...base,
        kind,
        points: out,
        width: value.width === undefined ? 4 : stroke(value.width, `${what}.width`),
        marker: value.marker === undefined ? false : bool(value.marker, `${what}.marker`),
      }
    }
    default:
      return {
        ...base,
        kind: kind as ShapeNote['kind'],
        x1: coord(value.x1, `${what}.x1`),
        y1: coord(value.y1, `${what}.y1`),
        x2: coord(value.x2, `${what}.x2`),
        y2: coord(value.y2, `${what}.y2`),
        width: value.width === undefined ? 3 : stroke(value.width, `${what}.width`),
        from: ref(value.from, `${what}.from`),
        to: ref(value.to, `${what}.to`),
      }
  }
}

function list(value: unknown, what: string, max: number): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail(`${what} must be a list`)
  if (value.length > max) fail(`${what} has more than ${max} entries`)
  return value
}

/** Every reference points at an object of the right kind, and every id is used once. */
function checkLinks(doc: {
  canvases: CanvasSheet[]
  sections: CanvasSection[]
  pages: LoosePage[]
  notes: CanvasNote[]
}): void {
  const kinds = new Map<string, 'canvas' | 'section' | 'page' | 'note'>()
  const claim = (key: string, kind: 'canvas' | 'section' | 'page' | 'note'): void => {
    if (kinds.has(key)) fail(`the id "${key}" is used more than once`)
    kinds.set(key, kind)
  }
  doc.canvases.forEach((c) => claim(c.id, 'canvas'))
  doc.sections.forEach((s) => claim(s.id, 'section'))
  doc.pages.forEach((p) => claim(p.id, 'page'))
  doc.notes.forEach((n) => claim(n.id, 'note'))
  const canvasOf = (key: string, what: string): void => {
    if (kinds.get(key) !== 'canvas') fail(`${what} names no canvas "${key}"`)
  }
  for (const s of doc.sections) canvasOf(s.canvas, `section "${s.id}"`)
  for (const p of doc.pages) {
    canvasOf(p.canvas, `page "${p.id}"`)
    if (p.section !== null) {
      if (kinds.get(p.section) !== 'section') fail(`page "${p.id}" names no section "${p.section}"`)
      const section = doc.sections.find((s) => s.id === p.section)!
      if (section.canvas !== p.canvas) fail(`page "${p.id}" is on another canvas than its section`)
    }
  }
  for (const n of doc.notes) {
    canvasOf(n.canvas, `note "${n.id}"`)
    if (n.kind === 'rect' || n.kind === 'ellipse' || n.kind === 'line' || n.kind === 'arrow') {
      for (const end of [n.from, n.to]) {
        if (end !== null && kinds.get(end) !== 'page') fail(`note "${n.id}" joins no page "${end}"`)
      }
    }
  }
}

/**
 * A document from what an agent or a stored version wrote. Pages and notes may leave out their
 * canvas when there is only one, a document may leave out its canvases altogether (it gets one),
 * and pages may leave out their place, which `placePages` fills in.
 */
export function parseCanvasDoc(json: string): CanvasDoc {
  if (json.length > CANVAS_LIMITS.chars) fail('the canvas document is too large')
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (error) {
    fail(`the canvas document is not valid JSON: ${(error as Error).message}`)
  }
  if (!isRecord(raw)) fail('the canvas document must be a JSON object')
  only(raw, ['format', 'canvases', 'sections', 'pages', 'notes'], 'the canvas document')
  if (raw.format !== undefined && raw.format !== CANVAS_FORMAT) {
    fail(`the canvas document's format must be ${CANVAS_FORMAT}`)
  }
  let canvases = list(raw.canvases, 'canvases', CANVAS_LIMITS.canvases).map((c, i) =>
    sheetOf(c, `canvases[${i}]`),
  )
  if (canvases.length === 0) canvases = [{ id: 'canvas-1', name: 'Canvas 1' }]
  const only1 = canvases.length === 1 ? canvases[0]!.id : null
  const withCanvas = (value: unknown): unknown =>
    isRecord(value) && value.canvas === undefined && only1 !== null
      ? { ...value, canvas: only1 }
      : value
  const sections = list(raw.sections, 'sections', CANVAS_LIMITS.sections).map((s, i) =>
    sectionOf(withCanvas(s), `sections[${i}]`),
  )
  const pages = list(raw.pages, 'pages', CANVAS_LIMITS.pages).map((p, i) =>
    pageOf(withCanvas(p), `pages[${i}]`),
  )
  const notes = list(raw.notes, 'notes', CANVAS_LIMITS.notes).map((n, i) =>
    noteOf(withCanvas(n), `notes[${i}]`),
  )
  const loose = { canvases, sections, pages, notes }
  checkLinks(loose)
  return placePages(loose)
}

/** The document as stored: stable key order, two-space indents, so versions diff well. */
export function stringifyCanvasDoc(doc: CanvasDoc): string {
  return JSON.stringify(doc, null, 2) + '\n'
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

function boundsOf(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const b of boxes) {
    left = Math.min(left, b.x)
    top = Math.min(top, b.y)
    right = Math.max(right, b.x + b.width)
    bottom = Math.max(bottom, b.y + b.height)
  }
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** A section's frame on its canvas: around its pages with room for its title; null when empty. */
export function sectionBox(doc: Pick<CanvasDoc, 'pages'>, section: string): Box | null {
  const inner = boundsOf(doc.pages.filter((p) => p.section === section))
  if (!inner) return null
  return {
    x: inner.x - SECTION_PAD,
    y: inner.y - SECTION_HEAD,
    width: inner.width + 2 * SECTION_PAD,
    height: inner.height + SECTION_HEAD + SECTION_PAD,
  }
}

/** Gives each page written without a place one after the pages already placed. */
function placePages(doc: {
  canvases: CanvasSheet[]
  sections: CanvasSection[]
  pages: LoosePage[]
  notes: CanvasNote[]
}): CanvasDoc {
  const placed: CanvasPage[] = []
  const pending: LoosePage[] = []
  for (const p of doc.pages) {
    if (p.x !== null && p.y !== null) placed.push(p as CanvasPage)
    else pending.push(p)
  }
  const done = new Map<string, CanvasPage>(placed.map((p) => [p.id, p]))
  for (const p of pending) {
    const onCanvas = [...done.values()].filter((q) => q.canvas === p.canvas)
    const all = boundsOf(onCanvas)
    let x: number
    let y: number
    const mates = p.section === null ? [] : onCanvas.filter((q) => q.section === p.section)
    if (mates.length > 0) {
      const right = Math.max(...mates.map((q) => q.x + q.width))
      x = right + PAGE_GAP
      y = Math.min(...mates.map((q) => q.y))
    } else if (p.section !== null) {
      // A section's first page starts a new band below everything on its canvas.
      x = 0
      y = all ? all.y + all.height + SECTION_GAP + SECTION_HEAD : 0
    } else {
      x = all ? all.x + all.width + PAGE_GAP : 0
      y = all ? all.y : 0
    }
    done.set(p.id, { ...p, x, y })
  }
  return {
    format: CANVAS_FORMAT,
    canvases: doc.canvases,
    sections: doc.sections,
    pages: doc.pages.map((p) => done.get(p.id)!),
    notes: doc.notes,
  }
}

/** The files a document's pages name that the version does not hold. */
export function missingPageFiles(doc: CanvasDoc, has: (path: string) => boolean): string[] {
  return [...new Set(doc.pages.map((p) => p.file))].filter((f) => !has(f))
}

const SETTABLE: Record<CanvasObject['type'], readonly string[]> = {
  canvas: ['name'],
  section: ['title'],
  page: ['section', 'name', 'file', 'x', 'y', 'width', 'height', 'locked'],
  note: [
    'color',
    'locked',
    'x',
    'y',
    'text',
    'size',
    'width',
    'done',
    'points',
    'marker',
    'x1',
    'y1',
    'x2',
    'y2',
    'from',
    'to',
  ],
}

function find(doc: CanvasDoc, key: string): { type: CanvasObject['type']; index: number } | null {
  let index = doc.canvases.findIndex((c) => c.id === key)
  if (index >= 0) return { type: 'canvas', index }
  index = doc.sections.findIndex((s) => s.id === key)
  if (index >= 0) return { type: 'section', index }
  index = doc.pages.findIndex((p) => p.id === key)
  if (index >= 0) return { type: 'page', index }
  index = doc.notes.findIndex((n) => n.id === key)
  if (index >= 0) return { type: 'note', index }
  return null
}

/** The operations as they were sent: each one well formed, before it meets a document. */
export function parseCanvasOps(value: unknown): CanvasOp[] {
  if (!Array.isArray(value)) fail('the canvas operations must be a list')
  if (value.length > CANVAS_LIMITS.ops)
    fail(`at most ${CANVAS_LIMITS.ops} canvas operations at once`)
  return value.map((op, i) => {
    const what = `canvas operation ${i + 1}`
    if (!isRecord(op)) fail(`${what} must be an object`)
    switch (op.op) {
      case 'add': {
        only(op, ['op', 'object'], what)
        if (!isRecord(op.object)) fail(`${what}.object must be an object`)
        const type = op.object.type
        if (type !== 'canvas' && type !== 'section' && type !== 'page' && type !== 'note') {
          fail(`${what}.object.type must be canvas, section, page or note`)
        }
        return { op: 'add', object: op.object as unknown as CanvasObject }
      }
      case 'set':
        only(op, ['op', 'id', 'key', 'value'], what)
        if (typeof op.key !== 'string') fail(`${what}.key must be a string`)
        return { op: 'set', id: id(op.id, `${what}.id`), key: op.key, value: op.value }
      case 'remove':
        only(op, ['op', 'id'], what)
        return { op: 'remove', id: id(op.id, `${what}.id`) }
      case 'order':
        only(op, ['op', 'id', 'index'], what)
        if (typeof op.index !== 'number' || !Number.isSafeInteger(op.index) || op.index < 0) {
          fail(`${what}.index must be a whole number from 0`)
        }
        return { op: 'order', id: id(op.id, `${what}.id`), index: op.index }
      default:
        fail(`${what}.op must be add, set, remove or order`)
    }
  })
}

function checkCounts(doc: CanvasDoc): void {
  if (doc.canvases.length === 0) fail('a canvas document keeps at least one canvas')
  if (doc.canvases.length > CANVAS_LIMITS.canvases)
    fail(`at most ${CANVAS_LIMITS.canvases} canvases`)
  if (doc.sections.length > CANVAS_LIMITS.sections)
    fail(`at most ${CANVAS_LIMITS.sections} sections`)
  if (doc.pages.length > CANVAS_LIMITS.pages) fail(`at most ${CANVAS_LIMITS.pages} pages`)
  if (doc.notes.length > CANVAS_LIMITS.notes) fail(`at most ${CANVAS_LIMITS.notes} notes`)
}

/** Removes an object and what cannot stand without it: a canvas's contents, a section's membership, a page's joins. */
function removeFrom(doc: CanvasDoc, key: string): CanvasDoc {
  const found = find(doc, key)
  if (!found) return doc
  switch (found.type) {
    case 'canvas':
      return {
        ...doc,
        canvases: doc.canvases.filter((c) => c.id !== key),
        sections: doc.sections.filter((s) => s.canvas !== key),
        pages: doc.pages.filter((p) => p.canvas !== key),
        notes: doc.notes.filter((n) => n.canvas !== key),
      }
    case 'section':
      return {
        ...doc,
        sections: doc.sections.filter((s) => s.id !== key),
        pages: doc.pages.map((p) => (p.section === key ? { ...p, section: null } : p)),
      }
    case 'page':
      return {
        ...doc,
        pages: doc.pages.filter((p) => p.id !== key),
        notes: doc.notes.map((n) =>
          'from' in n && (n.from === key || n.to === key)
            ? { ...n, from: n.from === key ? null : n.from, to: n.to === key ? null : n.to }
            : n,
        ),
      }
    case 'note':
      return { ...doc, notes: doc.notes.filter((n) => n.id !== key) }
  }
}

/**
 * The document after the operations, in order. An operation on an object that is gone is
 * skipped, since another client may have removed it first; one that would leave the document
 * invalid throws, and none of them applies.
 */
export function applyCanvasOps(start: CanvasDoc, ops: readonly CanvasOp[]): CanvasDoc {
  let doc = start
  for (const [i, op] of ops.entries()) {
    const what = `canvas operation ${i + 1}`
    switch (op.op) {
      case 'add': {
        const { type, ...given } = op.object
        // As in a written document, an object may leave out its canvas when there is only one.
        const rest =
          type !== 'canvas' &&
          (given as { canvas?: unknown }).canvas === undefined &&
          doc.canvases.length === 1
            ? { ...given, canvas: doc.canvases[0]!.id }
            : given
        if (find(doc, (rest as { id?: unknown }).id as string))
          fail(`${what} adds an id that is already used`)
        if (type === 'canvas')
          doc = { ...doc, canvases: [...doc.canvases, sheetOf(rest, `${what}.object`)] }
        else if (type === 'section')
          doc = { ...doc, sections: [...doc.sections, sectionOf(rest, `${what}.object`)] }
        else if (type === 'page') {
          const loose = pageOf(rest, `${what}.object`)
          doc = placePages({ ...doc, pages: [...doc.pages, loose] })
        } else doc = { ...doc, notes: [...doc.notes, noteOf(rest, `${what}.object`)] }
        break
      }
      case 'set': {
        const found = find(doc, op.id)
        if (!found) continue
        if (!SETTABLE[found.type].includes(op.key))
          fail(`${what} cannot set "${op.key}" on a ${found.type}`)
        const list = (found.type === 'canvas'
          ? doc.canvases
          : found.type === 'section'
            ? doc.sections
            : found.type === 'page'
              ? doc.pages
              : doc.notes) as unknown as Record<string, unknown>[]
        const current = list[found.index]!
        const next = { ...current, [op.key]: op.value }
        const checked =
          found.type === 'canvas'
            ? sheetOf(next, what)
            : found.type === 'section'
              ? sectionOf(next, what)
              : found.type === 'page'
                ? (pageOf(next, what) as CanvasPage)
                : noteOf(next, what)
        if (
          found.type === 'page' &&
          ((checked as LoosePage).x === null || (checked as LoosePage).y === null)
        ) {
          fail(`${what} cannot clear a page's place`)
        }
        const replaced = list.map((o, j) => (j === found.index ? checked : o))
        doc =
          found.type === 'canvas'
            ? { ...doc, canvases: replaced as unknown as CanvasSheet[] }
            : found.type === 'section'
              ? { ...doc, sections: replaced as unknown as CanvasSection[] }
              : found.type === 'page'
                ? { ...doc, pages: replaced as unknown as CanvasPage[] }
                : { ...doc, notes: replaced as unknown as CanvasNote[] }
        break
      }
      case 'remove':
        doc = removeFrom(doc, op.id)
        break
      case 'order': {
        const found = find(doc, op.id)
        if (!found || (found.type !== 'page' && found.type !== 'note')) continue
        const key = found.type === 'page' ? 'pages' : 'notes'
        const items = [...(doc[key] as { id: string }[])]
        const [item] = items.splice(found.index, 1)
        items.splice(Math.min(op.index, items.length), 0, item!)
        doc = { ...doc, [key]: items }
        break
      }
    }
  }
  checkCounts(doc)
  checkLinks(doc)
  return doc
}

/** The number of pages, which the artifact's summary reports. */
export function canvasPageCount(doc: CanvasDoc): number {
  return doc.pages.length
}

/** A fresh id for an object a client adds: a letter, then random letters and digits. */
export function canvasId(prefix: 'c' | 's' | 'p' | 'n'): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10))
  return prefix + Array.from(bytes, (b) => (b % 36).toString(36)).join('')
}
