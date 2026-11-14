// Claude Code's own per-project auto memory, read for import into Kettu's: one Markdown file per
// entry with `name`, `description` and a type, and a MEMORY.md that links them with their titles.
// The files are only read, never changed.

import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  MEMORY_BODY_CHARS,
  MEMORY_DESCRIPTION_CHARS,
  MEMORY_TITLE_CHARS,
  type MemoryDraft,
} from '@shared/memory'
import type { LogFn } from '../storage'
import { cut, humanize, normalizeBody, oneLine, splitFrontmatter } from './entry-file'
import { secretKind } from './secrets'

/** A file larger than this is no memory entry Claude Code wrote, and is passed over. */
const MAX_FILE_BYTES = 256 * 1024

/** An entry of Claude Code's memory, shaped to fit Kettu's limits. */
export interface ClaudeMemory {
  /** Its file's name in the memory folder. */
  file: string
  draft: MemoryDraft
  /** Filed as being about the user. */
  aboutUser: boolean
  /** When its file last changed. */
  modifiedAt: number
}

/** The folder Claude Code keeps a project's auto memory in, under its config folder. */
export function claudeMemoryDir(configDir: string, project: string): string {
  return path.join(configDir, 'projects', project.replace(/[^A-Za-z0-9]/g, '-'), 'memory')
}

/** The titles MEMORY.md gives its links, by file name. */
function linkTitles(index: string): Map<string, string> {
  const titles = new Map<string, string>()
  for (const match of index.matchAll(/^\s*[-*]\s*\[([^\]]+)\]\(([^)\s]+)\)/gm)) {
    titles.set(path.basename(match[2]!), oneLine(match[1]!))
  }
  return titles
}

/** The value of `key` in the frontmatter's `metadata:` map, where newer files keep the type. */
function metadataValue(text: string, key: string): string | undefined {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const start = lines.findIndex((line, index) => index > 0 && /^metadata:\s*$/.test(line))
  if (start === -1) return undefined
  for (const line of lines.slice(start + 1)) {
    if (!/^\s/.test(line)) break
    const match = new RegExp(`^\\s+${key}:\\s*["']?([^"'\\s]*)["']?\\s*$`).exec(line)
    if (match) return match[1]
  }
  return undefined
}

function titleOf(file: string, name: string | undefined, titles: Map<string, string>): string {
  const linked = titles.get(file)
  if (linked) return linked
  const named = oneLine(name ?? '')
  // Claude Code names an entry by a slug; an older or hand-written file may use a title.
  if (named !== '') return /[\sA-Z]/.test(named) ? named : humanize(named)
  return humanize(file.replace(/\.md$/i, ''))
}

/** The body, cut to fit with a note that says where the whole text is. */
function fitted(body: string, source: string): string {
  if (Array.from(body).length <= MEMORY_BODY_CHARS) return body
  const note = `\n\n(Cut to fit Kettu's memory on import; the whole text is in ${source}.)`
  return `${cut(body, MEMORY_BODY_CHARS - Array.from(note).length)}${note}`
}

/** What the folder holds; a missing folder holds nothing, and an unreadable file is logged. */
export async function readClaudeMemory(dir: string, log: LogFn): Promise<ClaudeMemory[]> {
  let names: { name: string; isFile(): boolean }[]
  try {
    names = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      log('warn', `Could not read Claude Code memory in ${dir}: ${(error as Error).message}`)
    }
    return []
  }
  const files = names
    .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
    .map((entry) => entry.name)
  const indexName = files.find((name) => name.toLowerCase() === 'memory.md')
  const titles = indexName
    ? linkTitles(await readFile(path.join(dir, indexName), 'utf8').catch(() => ''))
    : new Map<string, string>()
  const out: ClaudeMemory[] = []
  for (const file of files.sort()) {
    if (file === indexName) continue
    const full = path.join(dir, file)
    try {
      const info = await stat(full)
      if (info.size > MAX_FILE_BYTES) {
        log('warn', `Passed over ${full} for import: it is larger than a memory entry`)
        continue
      }
      const text = await readFile(full, 'utf8')
      const { fields, body } = splitFrontmatter(text)
      const draft: MemoryDraft = {
        title: cut(titleOf(file, fields.name, titles), MEMORY_TITLE_CHARS),
        description: cut(oneLine(fields.description ?? ''), MEMORY_DESCRIPTION_CHARS),
        body: fitted(normalizeBody(body), full),
      }
      if (draft.description === '' && draft.body === '') continue
      const secret = secretKind(`${draft.title}\n${draft.description}\n${draft.body}`)
      if (secret !== null) {
        log('warn', `Passed over ${full} for import: it seems to hold ${secret}`)
        continue
      }
      const type = fields.type ?? metadataValue(text, 'type')
      out.push({ file, draft, aboutUser: type === 'user', modifiedAt: info.mtimeMs })
    } catch (error) {
      log('warn', `Could not read ${full} for import: ${(error as Error).message}`)
    }
  }
  return out
}
