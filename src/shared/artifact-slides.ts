// The slides type's content: a deck in `slides.json`, each slide a layout and its text, with
// pictures under `images/`. Read alike by the host, which checks and exports it, and by the viewer.

import { isImagePath } from './artifact-document'

export const SLIDE_LAYOUTS = [
  'title',
  'section',
  'bullets',
  'two-column',
  'image',
  'quote',
  'stats',
  'table',
] as const

export type SlideLayout = (typeof SLIDE_LAYOUTS)[number]

export const DECK_THEMES = ['light', 'dark'] as const
export type DeckTheme = (typeof DECK_THEMES)[number]

export const DECK_ASPECTS = ['16:9', '4:3'] as const
export type DeckAspect = (typeof DECK_ASPECTS)[number]

/** A point, or one with points of its own under it. */
export type Bullet = string | { text: string; bullets: string[] }

export interface Column {
  heading?: string
  text?: string
  bullets?: Bullet[]
}

export interface Stat {
  value: string
  label?: string
}

interface SlideBase {
  /** What the presenter says, which only the export's notes carry. */
  notes?: string
}

export type Slide = SlideBase &
  (
    | { layout: 'title'; title: string; subtitle?: string }
    | { layout: 'section'; title: string; subtitle?: string }
    | { layout: 'bullets'; title: string; bullets: Bullet[]; image?: string; alt?: string }
    | { layout: 'two-column'; title?: string; left: Column; right: Column }
    | { layout: 'image'; title?: string; image: string; alt: string; caption?: string }
    | { layout: 'quote'; quote: string; attribution?: string }
    | { layout: 'stats'; title?: string; stats: Stat[] }
    | { layout: 'table'; title?: string; columns: string[]; rows: string[][] }
  )

export interface Deck {
  title?: string
  theme?: DeckTheme
  aspect?: DeckAspect
  slides: Slide[]
}

export const LIMITS = {
  slides: 200,
  title: 200,
  text: 1500,
  bullet: 500,
  bullets: 12,
  subBullets: 8,
  stats: 4,
  columns: 8,
  rows: 20,
  cell: 300,
  notes: 5000,
} as const

/** The fields each layout takes besides `layout` and `notes`, the required ones first. */
export const LAYOUT_FIELDS: Readonly<
  Record<SlideLayout, { required: readonly string[]; optional: readonly string[] }>
> = {
  title: { required: ['title'], optional: ['subtitle'] },
  section: { required: ['title'], optional: ['subtitle'] },
  bullets: { required: ['title', 'bullets'], optional: ['image', 'alt'] },
  'two-column': { required: ['left', 'right'], optional: ['title'] },
  image: { required: ['image', 'alt'], optional: ['title', 'caption'] },
  quote: { required: ['quote'], optional: ['attribution'] },
  stats: { required: ['stats'], optional: ['title'] },
  table: { required: ['columns', 'rows'], optional: ['title'] },
}

/**
 * The colors a deck is drawn in, the same in the viewer and the exports, so a slide looks as it
 * will in PowerPoint whatever the app's color mode.
 */
export const DECK_PALETTES: Readonly<
  Record<
    DeckTheme,
    {
      background: string
      text: string
      muted: string
      accent: string
      surface: string
      line: string
    }
  >
> = {
  light: {
    background: '#ffffff',
    text: '#1b1e23',
    muted: '#5d6672',
    accent: '#d9590f',
    surface: '#f3f4f6',
    line: '#dde0e5',
  },
  dark: {
    background: '#16181c',
    text: '#f2f3f5',
    muted: '#a4abb5',
    accent: '#ff8d4d',
    surface: '#22252b',
    line: '#363a41',
  },
}

/** A slide's size in CSS pixels, which the viewer lays it out at and scales. */
export function slideSize(aspect: DeckAspect | undefined): { width: number; height: number } {
  return aspect === '4:3' ? { width: 960, height: 720 } : { width: 1280, height: 720 }
}

type Problems = string[]
const MAX_PROBLEMS = 20

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function chars(text: string): number {
  return [...text].length
}

class Check {
  readonly problems: Problems = []

  add(problem: string): void {
    if (this.problems.length < MAX_PROBLEMS) this.problems.push(problem)
  }

  text(value: unknown, at: string, max: number, required: boolean): string | undefined {
    if (value === undefined) {
      if (required) this.add(`${at} is missing; give it as text.`)
      return undefined
    }
    if (typeof value !== 'string') {
      this.add(`${at} must be text.`)
      return undefined
    }
    if (required && value.trim() === '') this.add(`${at} must not be empty.`)
    if (chars(value) > max) this.add(`${at} is longer than ${max} characters; shorten it.`)
    return value
  }

  fields(value: Record<string, unknown>, at: string, allowed: readonly string[]): void {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        this.add(`${at} has an unknown field "${key}"; it takes ${allowed.join(', ')}.`)
      }
    }
  }

  image(value: unknown, at: string, images: ReadonlySet<string> | null): void {
    if (typeof value !== 'string')
      return void this.add(`${at} must be a path such as images/chart.png.`)
    if (!isImagePath(value)) {
      this.add(`${at} must be a PNG, JPEG or GIF file under images/, such as images/chart.png.`)
    } else if (images && !images.has(value)) {
      this.add(`${at} names ${value}, which is not a file of the artifact; add it in files.`)
    }
  }

  bullets(value: unknown, at: string, max: number, nested: boolean): void {
    if (!Array.isArray(value) || value.length === 0) {
      return void this.add(`${at} must be a list of 1 to ${max} points.`)
    }
    if (value.length > max)
      this.add(`${at} has ${value.length} points; a slide holds at most ${max}.`)
    value.forEach((item: unknown, i) => {
      const where = `${at}[${i}]`
      if (typeof item === 'string' || !nested) {
        this.text(item, where, LIMITS.bullet, true)
        return
      }
      if (!isObject(item)) return void this.add(`${where} must be text, or {text, bullets}.`)
      this.fields(item, where, ['text', 'bullets'])
      this.text(item.text, `${where}.text`, LIMITS.bullet, true)
      this.bullets(item.bullets, `${where}.bullets`, LIMITS.subBullets, false)
    })
  }
}

/**
 * The deck in `text`, or what is wrong with it, each problem naming where, as `slides[2].title`.
 * `images` is the set of the version's pictures, which a slide may name; null skips that check.
 */
export function parseDeck(
  text: string,
  images: ReadonlySet<string> | null = null,
): { deck: Deck } | { problems: Problems } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { problems: [`slides.json is not valid JSON: ${(error as Error).message}.`] }
  }
  const check = new Check()
  if (!isObject(value)) return { problems: ['slides.json must hold an object with a slides list.'] }
  check.fields(value, 'The deck', ['title', 'theme', 'aspect', 'slides'])
  check.text(value.title, 'title', LIMITS.title, false)
  if (value.theme !== undefined && !(DECK_THEMES as readonly unknown[]).includes(value.theme)) {
    check.add(`theme must be one of ${DECK_THEMES.join(', ')}.`)
  }
  if (value.aspect !== undefined && !(DECK_ASPECTS as readonly unknown[]).includes(value.aspect)) {
    check.add(`aspect must be one of ${DECK_ASPECTS.join(', ')}.`)
  }
  const slides = value.slides
  if (!Array.isArray(slides) || slides.length === 0) {
    check.add(`slides must be a list of 1 to ${LIMITS.slides} slides.`)
  } else {
    if (slides.length > LIMITS.slides) {
      check.add(`The deck has ${slides.length} slides; it holds at most ${LIMITS.slides}.`)
    }
    slides.forEach((slide: unknown, i) => checkSlide(check, slide, `slides[${i}]`, images))
  }
  return check.problems.length > 0
    ? { problems: check.problems }
    : { deck: value as unknown as Deck }
}

function checkSlide(
  check: Check,
  slide: unknown,
  at: string,
  images: ReadonlySet<string> | null,
): void {
  if (!isObject(slide)) return void check.add(`${at} must be an object with a layout.`)
  const layout = slide.layout
  if (!(SLIDE_LAYOUTS as readonly unknown[]).includes(layout)) {
    return void check.add(`${at}.layout must be one of ${SLIDE_LAYOUTS.join(', ')}.`)
  }
  const fields = LAYOUT_FIELDS[layout as SlideLayout]
  check.fields(slide, `${at} (${String(layout)})`, [
    'layout',
    ...fields.required,
    ...fields.optional,
    'notes',
  ])
  check.text(slide.notes, `${at}.notes`, LIMITS.notes, false)
  const text = (key: string, max: number = LIMITS.title) =>
    check.text(slide[key], `${at}.${key}`, max, fields.required.includes(key))
  switch (layout as SlideLayout) {
    case 'title':
    case 'section':
      text('title')
      text('subtitle', LIMITS.text)
      break
    case 'bullets':
      text('title')
      check.bullets(slide.bullets, `${at}.bullets`, LIMITS.bullets, true)
      if (slide.image !== undefined) check.image(slide.image, `${at}.image`, images)
      if (slide.alt !== undefined && slide.image === undefined) {
        check.add(`${at}.alt describes an image; give image too, or leave alt out.`)
      }
      text('alt', LIMITS.text)
      break
    case 'two-column':
      text('title')
      for (const side of ['left', 'right'] as const)
        checkColumn(check, slide[side], `${at}.${side}`)
      break
    case 'image':
      text('title')
      check.image(slide.image, `${at}.image`, images)
      text('alt', LIMITS.text)
      text('caption', LIMITS.text)
      break
    case 'quote':
      text('quote', LIMITS.text)
      text('attribution')
      break
    case 'stats': {
      text('title')
      const stats = slide.stats
      if (!Array.isArray(stats) || stats.length === 0 || stats.length > LIMITS.stats) {
        check.add(`${at}.stats must be a list of 1 to ${LIMITS.stats} figures.`)
        break
      }
      stats.forEach((stat: unknown, i) => {
        const where = `${at}.stats[${i}]`
        if (!isObject(stat)) return void check.add(`${where} must be {value, label}.`)
        check.fields(stat, where, ['value', 'label'])
        check.text(stat.value, `${where}.value`, LIMITS.cell, true)
        check.text(stat.label, `${where}.label`, LIMITS.cell, false)
      })
      break
    }
    case 'table': {
      text('title')
      const columns = slide.columns
      if (!Array.isArray(columns) || columns.length === 0 || columns.length > LIMITS.columns) {
        check.add(`${at}.columns must be a list of 1 to ${LIMITS.columns} headings.`)
        break
      }
      columns.forEach((column: unknown, i) =>
        check.text(column, `${at}.columns[${i}]`, LIMITS.cell, false),
      )
      const rows = slide.rows
      if (!Array.isArray(rows) || rows.length > LIMITS.rows) {
        check.add(`${at}.rows must be a list of at most ${LIMITS.rows} rows.`)
        break
      }
      rows.forEach((row: unknown, r) => {
        if (!Array.isArray(row) || row.length !== columns.length) {
          return void check.add(`${at}.rows[${r}] must be a list of ${columns.length} cells.`)
        }
        row.forEach((cell: unknown, c) =>
          check.text(cell, `${at}.rows[${r}][${c}]`, LIMITS.cell, false),
        )
      })
      break
    }
  }
}

function checkColumn(check: Check, column: unknown, at: string): void {
  if (!isObject(column))
    return void check.add(`${at} must be {heading, text} or {heading, bullets}.`)
  check.fields(column, at, ['heading', 'text', 'bullets'])
  check.text(column.heading, `${at}.heading`, LIMITS.title, false)
  check.text(column.text, `${at}.text`, LIMITS.text, false)
  if (column.bullets !== undefined)
    check.bullets(column.bullets, `${at}.bullets`, LIMITS.bullets, true)
  if (column.text === undefined && column.bullets === undefined) {
    check.add(`${at} needs text or bullets.`)
  }
}

/** The pictures a deck shows, by path. */
export function deckImages(deck: Deck): string[] {
  return deck.slides.flatMap((slide) =>
    (slide.layout === 'bullets' || slide.layout === 'image') && slide.image ? [slide.image] : [],
  )
}

/** A bullet's text and the points under it. */
export function bulletParts(bullet: Bullet): { text: string; bullets: string[] } {
  return typeof bullet === 'string' ? { text: bullet, bullets: [] } : bullet
}
