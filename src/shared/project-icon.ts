// Custom sidebar icons for projects, persisted on ProjectRecord and shared across clients.
// Clients that do not recognize a built-in icon name should fall back to a default folder icon
// while preserving the optional color token.

export const PROJECT_ICON_NAMES = [
  'folder',
  'code',
  'terminal',
  'git-branch',
  'bug',
  'wrench',
  'settings',
  'globe',
  'server',
  'database',
  'cloud',
  'cpu',
  'smartphone',
  'laptop',
  'sparkles',
  'brain',
  'robot',
  'flask',
  'rocket',
  'bolt',
  'palette',
  'layers',
  'cube',
  'package',
  'file',
  'book',
  'notebook',
  'briefcase',
  'chart',
  'shield',
  'lock',
  'compass',
  'home',
  'star',
  'heart',
  'flame',
  'bulb',
  'coffee',
  'gamepad',
  'music',
  'camera',
  'bookmark',
] as const

export type ProjectIconName = (typeof PROJECT_ICON_NAMES)[number]

export const PROJECT_ICON_COLORS = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'slate',
] as const

export type ProjectIconColor = (typeof PROJECT_ICON_COLORS)[number]

/** Maximum UTF-16 code-unit length for a single emoji grapheme cluster (ZWJ/skin-tone sequences). */
export const PROJECT_ICON_EMOJI_MAX = 32

export type ProjectIcon =
  | { kind: 'icon'; value: ProjectIconName; color?: ProjectIconColor }
  | { kind: 'emoji'; value: string }

const ICON_NAME_SET = new Set<string>(PROJECT_ICON_NAMES)
const ICON_COLOR_SET = new Set<string>(PROJECT_ICON_COLORS)

export function isProjectIconName(value: unknown): value is ProjectIconName {
  return typeof value === 'string' && ICON_NAME_SET.has(value)
}

export function isProjectIconColor(value: unknown): value is ProjectIconColor {
  return typeof value === 'string' && ICON_COLOR_SET.has(value)
}

const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u
const REGIONAL_FLAG = /^\p{Regional_Indicator}{2}$/u
const KEYCAP_EMOJI = /^[#*0-9]\uFE0F?\u20E3$/u

let graphemeSegmenter: Intl.Segmenter | null = null

function getGraphemeSegmenter(): Intl.Segmenter {
  if (!graphemeSegmenter) {
    graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
  }
  return graphemeSegmenter
}

function hasControlChar(value: string): boolean {
  for (const ch of value) {
    const cp = ch.codePointAt(0)
    if (cp !== undefined && (cp <= 0x1f || cp === 0x7f)) return true
  }
  return false
}

function isEmojiGrapheme(cluster: string): boolean {
  return (
    EXTENDED_PICTOGRAPHIC.test(cluster) || REGIONAL_FLAG.test(cluster) || KEYCAP_EMOJI.test(cluster)
  )
}

/**
 * Returns the trimmed single emoji grapheme when `raw` is a valid custom project emoji, or null
 * when it is empty, too long, contains control characters, has multiple graphemes, or is not emoji.
 */
export function extractSingleProjectEmoji(raw: string): string | null {
  if (hasControlChar(raw)) return null
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > PROJECT_ICON_EMOJI_MAX) return null
  let count = 0
  let single = ''
  for (const part of getGraphemeSegmenter().segment(trimmed)) {
    count += 1
    if (count > 1) return null
    single = part.segment
  }
  if (count !== 1 || !isEmojiGrapheme(single)) return null
  return single
}

export function isValidProjectEmoji(value: unknown): value is string {
  return typeof value === 'string' && extractSingleProjectEmoji(value) !== null
}

export type ProjectIconValidation = { ok: true; icon: ProjectIcon } | { ok: false; reason: string }

/** Strictly validates an untrusted project icon payload from IPC or remote requests. */
export function validateProjectIcon(value: unknown): ProjectIconValidation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'icon must be an object or null' }
  }
  const record = value as Record<string, unknown>
  if (record.kind === 'icon') {
    if (!isProjectIconName(record.value)) {
      return { ok: false, reason: 'icon.value must be a supported built-in icon' }
    }
    if (record.color !== undefined && record.color !== null) {
      if (!isProjectIconColor(record.color)) {
        return { ok: false, reason: 'icon.color must be a supported color token' }
      }
      return { ok: true, icon: { kind: 'icon', value: record.value, color: record.color } }
    }
    return { ok: true, icon: { kind: 'icon', value: record.value } }
  }
  if (record.kind === 'emoji') {
    if (record.color !== undefined && record.color !== null) {
      return { ok: false, reason: 'emoji icons do not accept a color' }
    }
    if (typeof record.value !== 'string') {
      return { ok: false, reason: 'icon.value must be an emoji string' }
    }
    const emoji = extractSingleProjectEmoji(record.value)
    if (!emoji) {
      return { ok: false, reason: 'icon.value must be a single valid emoji' }
    }
    return { ok: true, icon: { kind: 'emoji', value: emoji } }
  }
  return { ok: false, reason: 'icon.kind must be "icon" or "emoji"' }
}

/**
 * Lenient parser for persisted `projects.json` entries. Drops malformed icons rather than failing
 * the whole file load, and normalizes optional color tokens.
 */
export function parseProjectIcon(value: unknown): ProjectIcon | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.kind === 'icon') {
    if (!isProjectIconName(record.value)) return null
    return isProjectIconColor(record.color)
      ? { kind: 'icon', value: record.value, color: record.color }
      : { kind: 'icon', value: record.value }
  }
  if (record.kind === 'emoji' && typeof record.value === 'string') {
    const emoji = extractSingleProjectEmoji(record.value)
    return emoji ? { kind: 'emoji', value: emoji } : null
  }
  return null
}

/** Structural equality for comparing draft vs. persisted project icons. */
export function projectIconsEqual(
  a: ProjectIcon | null | undefined,
  b: ProjectIcon | null | undefined,
): boolean {
  if (!a && !b) return true
  if (!a || !b || a.kind !== b.kind || a.value !== b.value) return false
  if (a.kind === 'icon' && b.kind === 'icon') {
    return (a.color ?? null) === (b.color ?? null)
  }
  return true
}
