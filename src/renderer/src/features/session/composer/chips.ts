// What in a prompt's text reads as a chip: the command it starts with, `@` mentions of attached
// or project files, and links. Chips are only how the text looks; the text is what is sent.

import { leadingCommand } from './slash'

/** What an `@` mention names, once resolved against the attachments and the project. */
export interface MentionTarget {
  kind: 'file' | 'folder' | 'image'
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

// A full-width at sign is what some input methods type for `@`.
const MENTION = /(^|\s)[@＠](\S+)/g
// A link ends at a space, a quote or a character of CJK text, which a URL never holds as typed.
const URL_TEXT = /https?:\/\/[^\s<>"'`\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+/g
// What a sentence puts after a link, which is not part of it.
const TRAILING = /[.,;:!?)\]}>'"。，；：！？）、]+$/
const RANGE = /:(\d+)(?:[-–](\d+))?$/

/** A mention's name and the lines after it: `usage-store.ts:41-44` is the file and `41–44`. */
export function splitLines(token: string): { name: string; lines: string | null } {
  const match = RANGE.exec(token)
  if (!match || match.index === 0) return { name: token, lines: null }
  const lines = match[2] && match[2] !== match[1] ? `${match[1]}–${match[2]}` : match[1]!
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

/** The links in the text, each without the punctuation that ends a sentence after it. */
export function findLinks(text: string): Extract<Chip, { kind: 'link' }>[] {
  const links: Extract<Chip, { kind: 'link' }>[] = []
  for (const match of text.matchAll(URL_TEXT)) {
    const url = match[0].replace(TRAILING, '')
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
    const token = match[2]!
    const { name, lines } = splitLines(token)
    const target = context.resolve(name)
    if (!target) continue
    const label =
      target.kind === 'folder' ? (name.endsWith('/') ? name : `${name}/`) : basename(name)
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

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** What a draft attachment is mentioned as: a file's or image's name, a folder's with `/`. */
export function mentionedAs(item: { name: string; kind: string }): string {
  return item.kind === 'folder' ? `${item.name}/` : item.name
}

/**
 * Resolves a mention against the attachments first, by the name it is written as, then against
 * the project's files and folders by path.
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
): (token: string) => MentionTarget | null {
  return (token) => {
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
    if (!project) return null
    const path = token.replace(/^\.\//, '')
    if (project.files.has(path)) return { kind: 'file', path }
    const folder = path.endsWith('/') ? path : `${path}/`
    if (project.folders.has(folder)) return { kind: 'folder', path: folder.slice(0, -1) }
    return null
  }
}
