// What in a prompt's text reads as a chip: the command it starts with, `@` mentions of attached
// or project files and of the session's terminals, and links. Chips are only how the text looks;
// the text is what is sent, with a ref for each terminal it mentions.

import type { PluginMentionRef } from '@shared/plugin-refs'
import { leadingCommand } from './slash'

/** What an `@` mention names, once resolved against the attachments and the project. */
export interface MentionTarget {
  kind: 'file' | 'folder' | 'image' | 'plugin' | SurfaceMention
  /** The item of a plugin it stands for; `name` is its title. */
  plugin?: PluginMentionRef
  /** The terminal, browser tab or device it stands for, and the name its tab shows. */
  surfaceId?: string
  name?: string
  /** The draft attachment it stands for, when one has its name. */
  attachmentKey?: string
  /** The path relative to the project, when the project has it. */
  path?: string
  thumb?: string | null
  /** Its attachment could not be read or is gone. */
  missing?: boolean
}

export type Chip =
  | { kind: 'command'; from: number; to: number; name: string }
  | ({
      from: number
      to: number
      /** What the chip reads: a file's name, a folder's path with its slash. */
      label: string
      /** The lines it names, as `41–44`. */
      lines: string | null
    } & MentionTarget)
  | {
      kind: 'link'
      from: number
      to: number
      url: string
      host: string
      path: string
      local: boolean
    }

export interface ChipContext {
  /** The agent's command names. */
  commands: readonly string[]
  /** What `@token` names, or null when nothing does and it stays text. */
  resolve: (token: string) => MentionTarget | null
}

// A full-width at sign is what some input methods type for `@`. A mention starts at a space, the
// start or text without spaces such as Chinese, as typing it does (`startsWord`), and ends at a
// space or at CJK punctuation, which a path seldom holds; CJK letters stay, as a file may be named
// in them.
const MENTION =
  /(^|\s|\P{ASCII})[@＠]([^\s\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]+)/gu
const MENTION_AT_END =
  /(^|\s|\P{ASCII})[@＠][^\s\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]*$/u

/** Where the mention that runs to the end of `before` starts, at its `@`; -1 for none. */
export function mentionEndingAt(before: string): number {
  const match = MENTION_AT_END.exec(before)
  return match ? match.index + match[1]!.length : -1
}
// A link ends at a space, a quote or a character of CJK text, which a URL never holds as typed.
const URL_TEXT = /https?:\/\/[^\s<>"'`\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+/g
// What a sentence puts after a mention or a link, which is not part of it.
const TRAILING = /[.,;:!?)\]}>'"。，；：！？）、]+$/
const SENTENCE_END = /[.,;:!?>'"]/
const OPENER: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
// `:41-44`, or `#L41-44` as Claude Code writes a range and `#L41-L44` as GitHub does.
const RANGE = /(?::(\d+)(?:[-–](\d+))?|#L(\d+)(?:-L?(\d+))?)$/

/** A mention's name and the lines after it: `usage-store.ts:41-44` is the file and `41–44`. */
export function splitLines(token: string): { name: string; lines: string | null } {
  const match = RANGE.exec(token)
  if (!match || match.index === 0) return { name: token, lines: null }
  const start = match[1] ?? match[3]!
  const end = match[2] ?? match[4]
  const lines = end && end !== start ? `${start}–${end}` : start
  return { name: token.slice(0, match.index), lines }
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$|\.localhost$/i

/** A link's host with its port, in full, and the rest trimmed of a bare `/`. */
export function linkParts(url: string): { host: string; path: string; local: boolean } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (!parsed.hostname) return null
  const path = `${parsed.pathname}${parsed.search}${parsed.hash}`
  return {
    host: parsed.host,
    path: path === '/' ? '' : path,
    local: LOCAL_HOST.test(parsed.hostname),
  }
}

// About as much of an address as a chip's width shows in the interface face.
const LINK_CHARS = 44

/**
 * A link's path as its chip writes it: whole when the address fits, else its last segments after
 * `/…`, so the end that tells links apart, such as an issue number or a file name, stays.
 */
export function shortLinkPath(host: string, path: string): string {
  if (host.length + path.length <= LINK_CHARS) return path
  const end = path.search(/[?#]/)
  const segments = (end < 0 ? path : path.slice(0, end)).split('/').slice(1)
  let tail = (segments.pop() ?? '') + (end < 0 ? '' : path.slice(end))
  while (segments.length > 0) {
    const next = `${segments.at(-1)}/${tail}`
    if (host.length + '/…/'.length + next.length > LINK_CHARS) break
    tail = next
    segments.pop()
  }
  return segments.length === 0 ? path : `/…/${tail}`
}

const count = (text: string, char: string) => text.split(char).length - 1

/** A link without what ends the sentence around it, or a bracket it did not open. */
export function trimLink(url: string): string {
  let end = url.length
  for (;;) {
    const last = url[end - 1] ?? ''
    const kept = url.slice(0, end)
    if (SENTENCE_END.test(last)) end--
    else if (last in OPENER && count(kept, OPENER[last]!) < count(kept, last)) end--
    else return kept
  }
}

/** The links in the text, each without the punctuation that ends a sentence after it. */
export function findLinks(text: string): Extract<Chip, { kind: 'link' }>[] {
  const links: Extract<Chip, { kind: 'link' }>[] = []
  for (const match of text.matchAll(URL_TEXT)) {
    const url = trimLink(match[0])
    const parts = linkParts(url)
    if (!parts) continue
    links.push({ kind: 'link', from: match.index, to: match.index + url.length, url, ...parts })
  }
  return links
}

/** Every chip in the text, in order: the leading command, the mentions and the links. */
export function findChips(text: string, context: ChipContext): Chip[] {
  const chips: Chip[] = []
  const command = leadingCommand(text, context.commands)
  if (command) chips.push({ kind: 'command', from: 0, to: command, name: text.slice(1, command) })
  for (const match of text.matchAll(MENTION)) {
    const from = match.index + match[1]!.length
    const found = resolveMention(match[2]!, context.resolve)
    if (!found) continue
    const { token, name, lines, target } = found
    const label = isSurfaceMention(target.kind)
      ? (target.name ?? name)
      : target.kind === 'plugin'
        ? name
        : target.kind === 'folder'
          ? name.endsWith('/')
            ? name
            : `${name}/`
          : basename(name)
    chips.push({ ...target, from, to: from + 1 + token.length, label, lines })
  }
  const taken = (from: number, to: number) => chips.some((c) => from < c.to && to > c.from)
  for (const link of findLinks(text)) if (!taken(link.from, link.to)) chips.push(link)
  return chips.sort((a, b) => a.from - b.from)
}

/** The attachments the text mentions, by key. */
export function mentioned(
  text: string,
  resolve: (token: string) => MentionTarget | null,
): Set<string> {
  const keys = new Set<string>()
  for (const chip of findChips(text, { commands: [], resolve })) {
    if ('attachmentKey' in chip && chip.attachmentKey) keys.add(chip.attachmentKey)
  }
  return keys
}

/** What `@token` names, as written or without the punctuation of the sentence after it. */
function resolveMention(token: string, resolve: ChipContext['resolve']) {
  for (const candidate of new Set([token, token.replace(TRAILING, '')])) {
    if (!candidate) continue
    const { name, lines } = splitLines(candidate)
    const target = resolve(name)
    if (target) return { token: candidate, name, lines, target }
  }
  return null
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** What a draft attachment is mentioned as: a file's or image's name, a folder's with `/`. */
export function mentionedAs(item: { name: string; kind: string }): string {
  return item.kind === 'folder' ? `${item.name}/` : item.name
}

/** What else of the session a message can mention, which the agent may then use. */
export type SurfaceMention = 'terminal' | 'page' | 'device'
const SURFACE_MENTIONS: readonly SurfaceMention[] = ['terminal', 'page', 'device']

export function isSurfaceMention(kind: string): kind is SurfaceMention {
  return (SURFACE_MENTIONS as readonly string[]).includes(kind)
}

/** A terminal, browser tab or device as a mention names it: its id and the name its tab shows. */
export interface MentionItem {
  id: string
  name: string
}

/** The session's terminals, browser tabs and devices that a message can mention. */
export interface MentionSurfaces {
  terminal: readonly MentionItem[]
  page: readonly MentionItem[]
  device: readonly MentionItem[]
}

export const NO_SURFACES: MentionSurfaces = { terminal: [], page: [], device: [] }

// Enough of an id to tell the session's terminals, tabs or devices apart; a device's id starts with
// its kind, so its own part after the last colon counts.
const SHORT_ID_CHARS = 8

function shortId(id: string): string {
  return id
    .slice(id.lastIndexOf(':') + 1)
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, SHORT_ID_CHARS)
}

/** How the text mentions a terminal, tab or device: its name, with spaces, would end the mention. */
export function surfaceMention(kind: SurfaceMention, id: string): string {
  return `@${kind}:${shortId(id)}`
}

/** A terminal, tab or device the text mentions as `<kind>:<short id>`, among `surfaces`. */
function surfaceOf(token: string, surfaces: MentionSurfaces): MentionTarget | null {
  const colon = token.indexOf(':')
  const kind = token.slice(0, colon)
  if (colon < 1 || !isSurfaceMention(kind)) return null
  const short = token.slice(colon + 1)
  if (!short) return null
  const item = surfaces[kind].find((entry) => shortId(entry.id) === short)
  return item ? { kind, surfaceId: item.id, name: item.name } : null
}

/** The terminals, tabs and devices the text mentions, as a prompt carries them, each once. */
export function surfaceRefs(
  text: string,
  resolve: (token: string) => MentionTarget | null,
): SurfaceRef[] {
  const refs = new Map<string, SurfaceRef>()
  for (const chip of findChips(text, { commands: [], resolve })) {
    if (!('surfaceId' in chip) || !chip.surfaceId) continue
    const id = chip.surfaceId
    const ref: SurfaceRef | null =
      chip.kind === 'terminal'
        ? { kind: 'terminal', terminalId: id, name: chip.label }
        : chip.kind === 'page'
          ? { kind: 'page', tabId: id, name: chip.label }
          : chip.kind === 'device'
            ? { kind: 'device', deviceId: id, name: chip.label }
            : null
    if (ref) refs.set(`${chip.kind}:${id}`, ref)
  }
  return [...refs.values()]
}

/** The items of plugins the text mentions, as a prompt carries them, each once. */
export function pluginRefs(
  text: string,
  resolve: (token: string) => MentionTarget | null,
): PluginMentionRef[] {
  const refs = new Map<string, PluginMentionRef>()
  for (const chip of findChips(text, { commands: [], resolve })) {
    if (chip.kind !== 'plugin' || !chip.plugin) continue
    const { pluginId, source, item } = chip.plugin
    refs.set(`${pluginId}\n${source}\n${item}`, chip.plugin)
  }
  return [...refs.values()]
}

export type SurfaceRef =
  | { kind: 'terminal'; terminalId: string; name: string }
  | { kind: 'page'; tabId: string; name: string }
  | { kind: 'device'; deviceId: string; name: string }

/**
 * Resolves a mention against the session's terminals and the attachments first, by the name it is
 * written as, then against the project's files and folders by path.
 */
export function mentionResolver(
  attachments: readonly {
    key: string
    name: string
    kind: string
    status?: string
    thumb?: string | null
  }[],
  project: { files: ReadonlySet<string>; folders: ReadonlySet<string> } | null,
  surfaces: MentionSurfaces = NO_SURFACES,
  plugins: readonly PluginMentionRef[] = [],
): (token: string) => MentionTarget | null {
  return (token) => {
    const surface = surfaceOf(token, surfaces)
    if (surface) return surface
    const item = attachments.find(
      (a) => a.kind !== 'text' && (mentionedAs(a) === token || a.name === token),
    )
    if (item) {
      const kind = item.kind === 'folder' ? 'folder' : item.kind === 'image' ? 'image' : 'file'
      return {
        kind,
        attachmentKey: item.key,
        thumb: item.thumb ?? null,
        missing: item.status === 'failed',
      }
    }
    const mentioned = plugins.find((ref) => ref.word === token)
    if (mentioned) return { kind: 'plugin', name: mentioned.name, plugin: mentioned }
    if (!project) return null
    const path = token.replace(/^\.\//, '')
    if (project.files.has(path)) return { kind: 'file', path }
    const folder = path.endsWith('/') ? path : `${path}/`
    if (project.folders.has(folder)) return { kind: 'folder', path: folder.slice(0, -1) }
    return null
  }
}
