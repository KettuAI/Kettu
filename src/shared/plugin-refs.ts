// What plugins add to the places that name things: the composer's `@` menu, where a plugin gives
// a source of items to mention, and the links in replies, where a plugin says which addresses it
// knows and gives the card each one shows. A plugin's script only gives data; Kettu draws it.

import { domainCovers, isPluginPermission, networkDomain } from './plugins'
import type {
  PluginViewBadge,
  PluginViewError,
  PluginViewField,
  PluginViewIcon,
} from './plugin-views'

/** What a script is asked, as events its listeners answer. */
export const PLUGIN_REF_EVENTS = ['mention.search', 'mention.content', 'link.card'] as const

/** A mention source's or link kind's id in a manifest, which also names what wakes the plugin. */
export const PLUGIN_REF_ID = /^[a-z][a-z0-9-]{0,39}$/
/** The name of a part of an address that a pattern captures. */
export const PLUGIN_CAPTURE_NAME = /^[a-z][a-zA-Z0-9_]{0,31}$/

const MENTION_PREFIX = 'mention:'
const LINK_PREFIX = 'link:'

/** What wakes a plugin when its mention source is searched or its content is read. */
export function mentionTrigger(sourceId: string): string {
  return `${MENTION_PREFIX}${sourceId}`
}

/** What wakes a plugin when a link of its kind is looked up. */
export function linkTrigger(linkId: string): string {
  return `${LINK_PREFIX}${linkId}`
}

/**
 * What mentions and cards may hold. A text over its limit is cut; more items than `items` are
 * dropped and the answer says so; an answer of any other shape is refused, with the reason.
 */
export const PLUGIN_REF_LIMITS = {
  /** Mention sources, and link kinds, one plugin declares. */
  mentions: 8,
  links: 8,
  patterns: 8,
  pattern: 200,
  segments: 12,
  segment: 100,
  captures: 8,
  capture: 200,
  /** What a source is searched for, as typed after the `@`. */
  query: 200,
  items: 20,
  itemId: 128,
  itemTitle: 200,
  itemSubtitle: 300,
  itemEnd: 40,
  /** The word an item is written as after the `@`. */
  itemWord: 40,
  /** What one mentioned item adds to a message, in characters. */
  content: 16_000,
  contentTitle: 200,
  /** Mentioned items one message may carry, and the most characters all of them add. */
  perMessage: 10,
  total: 48_000,
  cardLabel: 60,
  cardTitle: 200,
  cardSubtitle: 300,
  cardBody: 400,
  cardBadges: 3,
  cardFields: 4,
  fieldLabel: 80,
  fieldValue: 200,
  badgeText: 40,
  error: 300,
} as const

/** How long a window waits for a source's items and for a link's card, from the host's side. */
export const PLUGIN_REF_DEADLINE_MS = 3_000
/** How long a send waits for what a mentioned item adds, which the message cannot go without. */
export const PLUGIN_MENTION_CONTENT_DEADLINE_MS = 5_000

/** What a manifest declares of a mention source; the script gives the items. */
export interface PluginMentionDecl {
  id: string
  /** By language tag, such as `en` and `zh-CN`; at least one. */
  title: Record<string, string>
  /** The glyph of its items and chips; a generic one when left out. */
  icon?: PluginViewIcon
}

/** What a manifest declares of a kind of link: where it lives and how it is drawn. */
export interface PluginLinkDecl {
  id: string
  /** Patterns of the form `https://host/path`, see `parseLinkPattern`; at least one. */
  patterns: string[]
  /** The glyph before the reference; a link glyph when left out. */
  icon?: PluginViewIcon
}

/**
 * An installed plugin as the composer and the thread know it: what it declares for them, and the
 * tools whose calls the thread names by it.
 */
export interface PluginRefSource {
  pluginId: string
  /** The plugin's name, which its tile is drawn from. */
  name: string
  /** The plugin's title as the thread names it. */
  title: string
  /** The plugin's icon as a data URL; null without one. */
  icon: string | null
  mentions: PluginMentionDecl[]
  links: PluginLinkDecl[]
  /** The names the plugin's tools have on Kettu's MCP service; absent from an older host. */
  tools?: string[]
}

/** One item a mention source found. */
export interface PluginMentionItem {
  /** What the plugin knows it by, at most 128 characters; sent back to read its content. */
  id: string
  title: string
  subtitle?: string
  /** A short figure at the row's end, such as a state. */
  end?: string
  icon?: PluginViewIcon
  /** The word written after the `@`, with no space in it; made from the id or title when left out. */
  word?: string
}

export type PluginMentionResult =
  { ok: true; items: PluginMentionItem[]; truncated?: true } | { ok: false; error: PluginViewError }

/** What a mentioned item adds to the message it is in. */
export interface PluginMentionContent {
  title?: string
  text: string
}

/** The card a link shows on hover, and the label it is drawn with in a line. */
export interface PluginLinkCard {
  /** The short form in a line, such as an issue key; the title when left out. */
  label?: string
  title: string
  subtitle?: string
  icon?: PluginViewIcon
  /** The first is the state in the card's head. */
  badges?: PluginViewBadge[]
  fields?: PluginViewField[]
  /** Plain text. */
  body?: string
}

export type PluginLinkResult =
  { ok: true; card: PluginLinkCard } | { ok: false; error: PluginViewError }

/** What the script is asked on `mention.search`. */
export interface PluginMentionSearchRequest {
  source: string
  query: string
  locale: string
}

/** What the script is asked on `mention.content`. */
export interface PluginMentionContentRequest {
  source: string
  /** The `id` of the item the user chose. */
  item: string
  locale: string
}

/** What the script is asked on `link.card`. */
export interface PluginLinkCardRequest {
  /** The id the manifest gives the kind of link. */
  link: string
  url: string
  /** What the pattern's `{name}` parts matched, decoded. */
  match: Record<string, string>
  locale: string
}

/** The mention of an item that a message carries: what the user chose and the word that names it. */
export interface PluginMentionRef {
  pluginId: string
  source: string
  item: string
  /** The word after the `@` in the message's text. */
  word: string
  /** The item's title when it was chosen. */
  name: string
}

/**
 * A mention word: letters and digits with `.`, `_`, `#`, `/` and `-` between them, so that it ends
 * where a sentence's punctuation begins and no `:41` after it reads as a line range.
 */
const MENTION_WORD = /^[\p{L}\p{N}](?:[\p{L}\p{N}._#/-]*[\p{L}\p{N}])?$/u

/** The word an item is written as: its own when it is one, else made of its id, else its title. */
export function mentionWord(item: Pick<PluginMentionItem, 'id' | 'title' | 'word'>): string {
  const max = PLUGIN_REF_LIMITS.itemWord
  for (const candidate of [item.word, item.id]) {
    if (candidate !== undefined && candidate.length <= max && MENTION_WORD.test(candidate)) {
      return candidate
    }
  }
  const made = [...item.title.trim().replace(/[^\p{L}\p{N}._#/-]+/gu, '-')]
    .slice(0, max)
    .join('')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
  return MENTION_WORD.test(made) ? made : 'item'
}

/** One part of a pattern's path. */
type PatternSegment =
  { kind: 'literal'; text: string } | { kind: 'any' } | { kind: 'capture'; name: string }

/** A link pattern, checked and cut into its host and the segments of its path. */
export interface LinkPattern {
  /** The host as written: a name, or `*.` and a name for every subdomain of it. */
  host: string
  segments: PatternSegment[]
  /** The path ends in `**`, which matches whatever follows, nothing included. */
  rest: boolean
}

const PATH_LITERAL = /^[A-Za-z0-9._~%:@!$&'()+,;=-]+$/

/**
 * Reads a link pattern, `https://host/path`, which matches addresses and never runs as code. The
 * host is a name or `*.name`; each segment of the path is a literal, `*` for any one segment,
 * `{name}` for one segment that the script is told, and a last `**` for the rest. A query, a
 * fragment, a port, a login and an empty or dot segment are not allowed. Null when it is not one.
 */
export function parseLinkPattern(text: string): LinkPattern | null {
  if (text.length > PLUGIN_REF_LIMITS.pattern || !text.startsWith('https://')) return null
  const rest = text.slice('https://'.length)
  if (/[?#\s\\]/.test(rest)) return null
  const slash = rest.indexOf('/')
  const host = (slash < 0 ? rest : rest.slice(0, slash)).toLowerCase()
  if (!isPluginPermission(`network:${host}`)) return null
  const path = slash < 0 ? '' : rest.slice(slash + 1)
  const parts = path === '' ? [] : path.split('/')
  // A single trailing slash only says the path is the host's own.
  if (parts.length > 0 && parts.at(-1) === '' && parts.length > 1) parts.pop()
  if (parts.length > PLUGIN_REF_LIMITS.segments) return null
  const segments: PatternSegment[] = []
  const names = new Set<string>()
  let tail = false
  for (const [index, part] of parts.entries()) {
    if (part === '**') {
      if (index !== parts.length - 1) return null
      tail = true
    } else if (part === '*') {
      segments.push({ kind: 'any' })
    } else if (part.startsWith('{') && part.endsWith('}')) {
      const name = part.slice(1, -1)
      if (!PLUGIN_CAPTURE_NAME.test(name) || names.has(name)) return null
      if (names.size >= PLUGIN_REF_LIMITS.captures) return null
      names.add(name)
      segments.push({ kind: 'capture', name })
    } else if (
      part !== '' &&
      part !== '.' &&
      part !== '..' &&
      part.length <= PLUGIN_REF_LIMITS.segment &&
      PATH_LITERAL.test(part)
    ) {
      segments.push({ kind: 'literal', text: part })
    } else {
      return null
    }
  }
  return { host, segments, rest: tail }
}

/**
 * Whether the plugin may connect to the pattern's host, which is the one condition on what it may
 * recognize: a plugin only ever hears of addresses on hosts it declared network access to. A
 * `*.` host needs a `*.` permission that covers every one of its subdomains.
 */
export function patternHostAllowed(pattern: LinkPattern, permissions: readonly string[]): boolean {
  const wildcard = pattern.host.startsWith('*.')
  const probe = wildcard ? `a.${pattern.host.slice(2)}` : pattern.host
  return permissions.some((permission) => {
    const domain = networkDomain(permission)
    return domain !== null && (!wildcard || domain.startsWith('*.')) && domainCovers(domain, probe)
  })
}

/**
 * What a pattern's `{name}` parts matched in an address, or null when the address is not one the
 * pattern names. Only the host and the path count, and one trailing slash does not.
 */
export function matchLinkPattern(pattern: LinkPattern, url: string): Record<string, string> | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return null
  if (!domainCovers(pattern.host, parsed.hostname)) return null
  const parts = parsed.pathname === '/' ? [] : parsed.pathname.slice(1).split('/')
  if (parts.length > 1 && parts.at(-1) === '') parts.pop()
  if (parts.length < pattern.segments.length) return null
  if (!pattern.rest && parts.length !== pattern.segments.length) return null
  const match: Record<string, string> = {}
  for (const [index, segment] of pattern.segments.entries()) {
    const part = parts[index]!
    if (part === '') return null
    if (segment.kind === 'literal') {
      if (segment.text !== part) return null
    } else if (segment.kind === 'capture') {
      match[segment.name] = decoded(part).slice(0, PLUGIN_REF_LIMITS.capture)
    }
  }
  return match
}

function decoded(part: string): string {
  try {
    return decodeURIComponent(part)
  } catch {
    return part
  }
}

/** The first link kind of a plugin whose patterns name the address, with what its pattern matched. */
export function matchLink(
  links: readonly PluginLinkDecl[],
  url: string,
): { link: PluginLinkDecl; match: Record<string, string> } | null {
  for (const link of links) {
    for (const text of link.patterns) {
      const pattern = parseLinkPattern(text)
      const match = pattern === null ? null : matchLinkPattern(pattern, url)
      if (match !== null) return { link, match }
    }
  }
  return null
}
