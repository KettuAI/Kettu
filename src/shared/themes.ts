// Themes: the file format, the tokens a theme may set, and the checks every file passes before
// anything of it reaches a page.

import contrastPairs from './contrast-pairs.json'

/** The format this version reads; a file with a higher number needs a newer Kettu. */
export const THEME_FORMAT = 1
export const BUILTIN_THEME_ID = 'kettu'
export const THEME_MAX_BYTES = 256 * 1024
export const THEME_MODES = ['light', 'dark'] as const
export type ThemeMode = (typeof THEME_MODES)[number]

/** The color tokens of tokens.css a theme may set, without their `--`. */
export const THEME_TOKENS = [
  'bg-app',
  'bg-sidebar',
  'bg-surface',
  'bg-subtle',
  'bg-code-inline',
  'bg-code-block',
  'bg-hover',
  'bg-selected',
  'queue-back',
  'border-default',
  'border-subtle',
  'border-strong',
  'text-primary',
  'text-secondary',
  'text-tertiary',
  'text-placeholder',
  'text-disabled',
  'icon-default',
  'attention',
  'attention-dot',
  'danger',
  'success',
  'merged',
  'info',
  'warning',
  'link',
  'link-hover',
  'danger-tint',
  'danger-border',
  'success-tint',
  'info-tint',
  'warning-tint',
  'info-tint-hover',
  'focus',
  'selection',
  'edit-ring',
  'edit-selection',
  'primary-from',
  'primary-to',
  'primary-hover-from',
  'primary-hover-to',
  'primary-ring',
  'primary-highlight',
  'primary-foreground',
  'scrollbar-thumb',
  'scrim',
  'viewer-scrim',
  'mark',
  'checker',
  'agent-opencode',
  'agent-pi',
  'agent-other',
  'heat-hue',
  'heat-0',
  'context-1',
  'context-2',
  'context-3',
  'context-4',
  'context-5',
  'context-6',
  'context-7',
  'terminal-background',
  'terminal-foreground',
  'terminal-cursor',
  'terminal-selection',
  'ansi-black',
  'ansi-red',
  'ansi-green',
  'ansi-yellow',
  'ansi-blue',
  'ansi-magenta',
  'ansi-cyan',
  'ansi-white',
  'ansi-bright-black',
  'ansi-bright-red',
  'ansi-bright-green',
  'ansi-bright-yellow',
  'ansi-bright-blue',
  'ansi-bright-magenta',
  'ansi-bright-cyan',
  'ansi-bright-white',
] as const
export type ThemeToken = (typeof THEME_TOKENS)[number]

const TOKENS: ReadonlySet<string> = new Set(THEME_TOKENS)

export const isThemeToken = (name: string): name is ThemeToken => TOKENS.has(name)

/** The tokens a theme's tile draws, which the catalog's index carries for each theme. */
export const PREVIEW_TOKENS = [
  'bg-app',
  'bg-sidebar',
  'bg-surface',
  'bg-subtle',
  'bg-selected',
  'border-default',
  'border-subtle',
  'border-strong',
  'primary-from',
  'primary-to',
] as const satisfies readonly ThemeToken[]

export type ThemeColors = Partial<Record<ThemeToken, string>>

export interface ThemeVariant {
  colors: ThemeColors
  /** A bundled Shiki theme for code; the renderer keeps its default when it is not one. */
  code?: string
}

export interface Theme {
  name: string
  author?: string
  version?: string
  light: ThemeVariant
  dark: ThemeVariant
}

export type ThemeFileError =
  | { code: 'too-large' }
  | { code: 'not-json' }
  | { code: 'not-theme' }
  | { code: 'newer-format' }
  | { code: 'reserved-name' }
  | { code: 'missing-variant'; variant: ThemeMode }
  // `path` names the field, such as `version` or `dark.code`.
  | { code: 'invalid-field'; path: string }
  | { code: 'invalid-color'; path: string }

export type ThemeFileResult =
  { ok: true; theme: Theme; ignored: string[] } | { ok: false; error: ThemeFileError }

/** An installed theme, as main reads it from the themes folder. */
export interface InstalledTheme {
  id: string
  theme: Theme
  /** What the file holds that this version does not use, such as `dark.colors.bg-ap`. */
  ignored: string[]
  /** The catalog version it was installed at; none for a theme installed from a file. */
  catalog?: string
}

export type ThemeLoadFailure =
  { code: 'missing' } | { code: 'unreadable' } | { code: 'invalid'; error: ThemeFileError }

export interface ThemesState {
  /** By name. */
  installed: InstalledTheme[]
  /** The setting: an installed theme's id, or BUILTIN_THEME_ID. */
  chosen: string
  /** Set when the chosen theme could not load, so the built-in theme shows instead. */
  failed: { id: string; failure: ThemeLoadFailure } | null
}

export type ThemeInstallResult =
  | { status: 'cancelled' }
  | { status: 'installed'; id: string; ignored: string[] }
  // `token` names the checked file for `themes:replace`, once the user agrees.
  | { status: 'conflict'; token: string; name: string; installedName: string }
  | { status: 'failed'; file: string; error: ThemeFileError | { code: 'unreadable' } }

/** A theme the catalog lists, with what installing it does given what is installed. */
export interface CatalogTheme {
  id: string
  name: string
  author: string
  version: string
  license: string
  /** The PREVIEW_TOKENS it sets, checked like a theme's colors. */
  preview: Record<ThemeMode, ThemeColors>
  /** `install` too when the id is installed from a file, which asks before it replaces it. */
  action: 'install' | 'update' | 'installed'
}

export type CatalogState =
  | { status: 'ok'; themes: CatalogTheme[] }
  // `unreachable`: no answer or an error status; `invalid`: an answer that is not an index.
  | { status: 'unreachable' | 'invalid' | 'newer-format' }

// `mismatch`: the download differs from the index's SHA-256, or its name gives another id.
export type CatalogInstallError = ThemeFileError | { code: 'unreachable' } | { code: 'mismatch' }

export type CatalogInstallResult =
  | { status: 'installed'; id: string; ignored: string[] }
  | { status: 'conflict'; token: string; name: string; installedName: string }
  | { status: 'failed'; error: CatalogInstallError }

const MAX_NAME = 64
const MAX_AUTHOR = 100
const MAX_VERSION = 32
const MAX_COLOR = 100
const MAX_SLUG = 48
const MAX_IGNORED = 50
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
export const THEME_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const CODE_THEME = /^[a-z0-9-]{1,64}$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Trimmed text of 1 to `max` characters without control characters, or null. */
export function plainText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= max && !CONTROL.test(trimmed) ? trimmed : null
}

/** A theme's name, author or version as the file format takes it, trimmed; null when it fails. */
export function themeField(field: 'name' | 'author' | 'version', value: unknown): string | null {
  const found = plainText(
    value,
    { name: MAX_NAME, author: MAX_AUTHOR, version: MAX_VERSION }[field],
  )
  return found !== null && (field !== 'version' || VERSION.test(found)) ? found : null
}

/**
 * The id a theme's name gives: ASCII letters and digits in lowercase, other runs a dash. Empty when
 * nothing is left, for main to replace with a hash of the name.
 */
export function themeSlug(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '')
}

/** Reads and checks a theme file's text; the first problem refuses all of it. */
export function parseThemeFile(source: string): ThemeFileResult {
  const fail = (error: ThemeFileError): ThemeFileResult => ({ ok: false, error })
  if (source.length > THEME_MAX_BYTES) return fail({ code: 'too-large' })
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch {
    return fail({ code: 'not-json' })
  }
  if (!isRecord(raw)) return fail({ code: 'not-json' })
  const format = raw['kettuTheme']
  if (typeof format !== 'number' || !Number.isInteger(format) || format < 1) {
    return fail({ code: 'not-theme' })
  }
  if (format > THEME_FORMAT) return fail({ code: 'newer-format' })

  const name = themeField('name', raw['name'])
  if (name === null) return fail({ code: 'invalid-field', path: 'name' })
  if (themeSlug(name) === BUILTIN_THEME_ID) return fail({ code: 'reserved-name' })
  const theme: Theme = { name, light: { colors: {} }, dark: { colors: {} } }
  for (const field of ['author', 'version'] as const) {
    if (raw[field] === undefined) continue
    const value = themeField(field, raw[field])
    if (value === null) return fail({ code: 'invalid-field', path: field })
    theme[field] = value
  }

  const ignored: string[] = []
  const ignore = (path: string) => {
    if (ignored.length < MAX_IGNORED) ignored.push(path.slice(0, 120))
  }
  for (const mode of THEME_MODES) {
    const variant = raw[mode]
    if (variant === undefined) return fail({ code: 'missing-variant', variant: mode })
    if (!isRecord(variant)) return fail({ code: 'invalid-field', path: mode })
    for (const key of Object.keys(variant)) {
      if (key !== 'colors' && key !== 'code') ignore(`${mode}.${key}`)
    }
    const colors = variant['colors'] ?? {}
    if (!isRecord(colors)) return fail({ code: 'invalid-field', path: `${mode}.colors` })
    for (const [token, value] of Object.entries(colors)) {
      const path = `${mode}.colors.${token}`
      if (!isThemeToken(token)) {
        ignore(path)
        continue
      }
      if (typeof value !== 'string' || value.length > MAX_COLOR || parseColor(value) === null) {
        return fail({ code: 'invalid-color', path })
      }
      theme[mode].colors[token] = value.trim()
    }
    if (variant['code'] !== undefined) {
      const code = variant['code']
      if (typeof code !== 'string' || !CODE_THEME.test(code)) {
        return fail({ code: 'invalid-field', path: `${mode}.code` })
      }
      theme[mode].code = code
    }
  }
  return { ok: true, theme, ignored }
}

/** A color in sRGB, each channel from 0 to 1. */
export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/
const clamp = (value: number) => Math.min(1, Math.max(0, value))

type Unit = '' | '%' | 'deg' | 'rad' | 'grad' | 'turn'

/** One component: a number with an optional unit, or `none`. */
function component(part: string): { value: number; unit: Unit } | null {
  if (part === 'none') return { value: 0, unit: '' }
  const number = NUMBER.exec(part)?.[0]
  if (number === undefined) return null
  const unit = part.slice(number.length)
  if (!['', '%', 'deg', 'rad', 'grad', 'turn'].includes(unit)) return null
  const value = Number(number)
  return Number.isFinite(value) ? { value, unit: unit as Unit } : null
}

/** A channel, alpha or lightness: a number in `range` or a percentage of it. */
function amount(part: { value: number; unit: Unit } | undefined, range: number): number | null {
  if (!part) return null
  if (part.unit === '%') return (part.value / 100) * range
  return part.unit === '' ? part.value : null
}

function hue(part: { value: number; unit: Unit } | undefined): number | null {
  if (!part || part.unit === '%') return null
  const factor = { '': 1, deg: 1, rad: 180 / Math.PI, grad: 0.9, turn: 360 }[part.unit]
  return (((part.value * factor) % 360) + 360) % 360
}

// Colors outside sRGB, which oklch() can name, are clipped to it.
function encode(linear: number): number {
  const c = clamp(linear)
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055
}

function fromOklab(l: number, a: number, b: number, alpha: number): Rgba {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return {
    r: clamp(encode(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_)),
    g: clamp(encode(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_)),
    b: clamp(encode(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_)),
    a: clamp(alpha),
  }
}

function fromHsl(h: number, s: number, l: number, alpha: number): Rgba {
  const channel = (n: number) => {
    const k = (n + h / 30) % 12
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return { r: clamp(channel(0)), g: clamp(channel(8)), b: clamp(channel(4)), a: clamp(alpha) }
}

/**
 * Reads a color a theme may use: hex, `rgb()`, `hsl()`, `oklch()`, `oklab()` or `transparent`;
 * null for anything else, including every other CSS a value could carry.
 */
export function parseColor(value: string): Rgba | null {
  const source = value.trim().toLowerCase()
  if (source === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  const hex = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/.exec(source)?.[1]
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex
    const byte = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255
    return { r: byte(0), g: byte(2), b: byte(4), a: full.length === 8 ? byte(6) : 1 }
  }
  const call = /^(rgba?|hsla?|oklch|oklab)\(([\d\sa-z.%+,/-]*)\)$/.exec(source)
  if (!call) return null
  const [, name, args = ''] = call
  let parts: string[]
  let alphaPart: string | undefined
  if (args.includes(',')) {
    if (args.includes('/')) return null
    parts = args.split(',').map((part) => part.trim())
    if (parts.length === 4) alphaPart = parts.pop()
  } else {
    const [main = '', alpha, extra] = args.split('/')
    if (extra !== undefined) return null
    parts = main.trim().split(/\s+/)
    alphaPart = alpha?.trim()
  }
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return null
  const values = parts.map(component)
  if (values.some((part) => part === null)) return null
  const [x, y, z] = values as { value: number; unit: Unit }[]
  const alphaValue = alphaPart === undefined ? { value: 1, unit: '' as Unit } : component(alphaPart)
  const alpha = amount(alphaValue ?? undefined, 1)
  if (alpha === null) return null

  if (name === 'rgb' || name === 'rgba') {
    const channels = [x, y, z].map((part) => amount(part, 255))
    if (channels.some((channel) => channel === null)) return null
    const [r, g, b] = channels as number[]
    return { r: clamp(r / 255), g: clamp(g / 255), b: clamp(b / 255), a: clamp(alpha) }
  }
  if (name === 'hsl' || name === 'hsla') {
    const h = hue(x)
    // Saturation and lightness are percentages; the space syntax also takes bare numbers.
    const s = y && y.unit === '' ? y.value / 100 : amount(y, 1)
    const l = z && z.unit === '' ? z.value / 100 : amount(z, 1)
    if (h === null || s === null || l === null) return null
    return fromHsl(h, clamp(s), clamp(l), alpha)
  }
  const lightness = amount(x, 1)
  if (lightness === null) return null
  if (name === 'oklch') {
    const chroma = amount(y, 0.4)
    const angle = hue(z)
    if (chroma === null || angle === null) return null
    const radians = (angle * Math.PI) / 180
    return fromOklab(lightness, chroma * Math.cos(radians), chroma * Math.sin(radians), alpha)
  }
  const a = amount(y, 0.4)
  const b = amount(z, 0.4)
  if (a === null || b === null) return null
  return fromOklab(lightness, a, b, alpha)
}

const WHITE: Rgba = { r: 1, g: 1, b: 1, a: 1 }

/** `color` laid over `under`, which is taken as opaque. */
function composite(color: Rgba, under: Rgba): Rgba {
  const mix = (top: number, bottom: number) => top * color.a + bottom * (1 - color.a)
  return { r: mix(color.r, under.r), g: mix(color.g, under.g), b: mix(color.b, under.b), a: 1 }
}

/** `#rrggbb` for a color laid over an opaque `under`, for APIs that take hex, such as Electron's. */
export function toHex(color: Rgba, under: Rgba = WHITE): string {
  const { r, g, b } = composite(color, under)
  const byte = (channel: number) =>
    Math.round(clamp(channel) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${byte(r)}${byte(g)}${byte(b)}`
}

/** WCAG 2.x relative luminance. */
export function luminance({ r, g, b }: Rgba): number {
  const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

/** WCAG 2.x contrast of a foreground laid over an opaque background. */
export function contrastRatio(fg: Rgba, bg: Rgba): number {
  const under = { ...bg, a: 1 }
  const [la, lb] = [luminance(composite(fg, under)), luminance(under)]
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

export const MIN_CONTRAST: number = contrastPairs.minRatio

export interface ContrastIssue {
  mode: ThemeMode
  fg: string
  bg: string
  ratio: number
}

// The opaque surfaces a translucent fill, such as a hovered row, is laid on.
const BASES = ['bg-app', 'bg-sidebar', 'bg-surface']

/**
 * The pairs `tools/lint/contrast.mjs` checks in tokens.css that fall under MIN_CONTRAST, for colors
 * that hold every token of both modes. A translucent surface is laid over each opaque base, as
 * there, and its weakest ratio counts.
 */
export function contrastIssues(colors: Record<ThemeMode, Record<string, string>>): ContrastIssue[] {
  const issues: ContrastIssue[] = []
  for (const mode of THEME_MODES) {
    const read = (token: string) => {
      const value = colors[mode][token]
      return value === undefined ? null : parseColor(value)
    }
    const bases = BASES.map(read).filter((base): base is Rgba => base !== null && base.a === 1)
    for (const { fg: fgToken, on } of contrastPairs.groups) {
      const fg = fgToken.slice(2)
      const fgColor = read(fg)
      if (!fgColor) continue
      for (const bgToken of on) {
        const bg = bgToken.slice(2)
        const bgColor = read(bg)
        if (!bgColor || bgColor.a === 0) continue
        const unders = bgColor.a < 1 ? bases.map((base) => composite(bgColor, base)) : [bgColor]
        if (unders.length === 0) continue
        const ratio = Math.min(...unders.map((under) => contrastRatio(fgColor, under)))
        if (ratio < MIN_CONTRAST) issues.push({ mode, fg, bg, ratio })
      }
    }
  }
  return issues
}
