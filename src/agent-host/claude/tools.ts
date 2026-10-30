// How a Claude Code tool call shows in a thread: its title, kind, locations and content, from
// the tool's name and input, then from its result.

import path from 'node:path'
import type { ContentRef, ToolContent, ToolEntry, ToolKind } from '@shared/thread'
import { toLf } from '../session-updates'
import type { ContentBlock, ToolResultBlock } from './sdk'

export interface ToolView {
  title: string
  toolKind: ToolKind
  locations: ToolEntry['locations']
  content: ToolContent[]
}

type Input = Record<string, unknown>

function asInput(input: unknown): Input {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Input)
    : {}
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

/** A path relative to the session's folder when it lies inside it. */
export function displayPath(file: string, cwd: string): string {
  const root = path.resolve(cwd)
  const resolved = path.resolve(file)
  return resolved === root || resolved.startsWith(root + path.sep)
    ? path.relative(root, resolved)
    : file
}

/** Text in a fence longer than any it holds, so it shows as written. */
export function fenced(body: string, info = ''): string {
  let fence = '```'
  for (const [run] of body.matchAll(/^`{3,}/gm)) {
    while (run.length >= fence.length) fence += '`'
  }
  return `${fence}${info}\n${body}${body.endsWith('\n') ? '' : '\n'}${fence}`
}

const markdown = (value: string): ToolContent => ({ type: 'markdown', markdown: toLf(value) })

function grepTitle(input: Input): string {
  let label = 'grep'
  if (input['-i']) label += ' -i'
  if (input['-n']) label += ' -n'
  for (const flag of ['-A', '-B', '-C']) {
    if (input[flag] !== undefined) label += ` ${flag} ${String(input[flag])}`
  }
  if (input.output_mode === 'files_with_matches') label += ' -l'
  else if (input.output_mode === 'count') label += ' -c'
  if (input.head_limit !== undefined) label += ` | head -${String(input.head_limit)}`
  if (text(input.glob)) label += ` --include="${String(input.glob)}"`
  if (text(input.type)) label += ` --type=${String(input.type)}`
  if (input.multiline) label += ' -P'
  if (text(input.pattern)) label += ` "${String(input.pattern)}"`
  if (text(input.path)) label += ` ${String(input.path)}`
  return label
}

/** What a tool call shows from its input. */
export function toolView(name: string, raw: unknown, cwd: string): ToolView {
  const input = asInput(raw)
  const view = (
    title: string,
    toolKind: ToolKind,
    extra: Partial<Omit<ToolView, 'title' | 'toolKind'>> = {},
  ): ToolView => ({ title, toolKind, locations: [], content: [], ...extra })
  const file = text(input.file_path) ?? text(input.path)
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return view(text(input.command) ?? 'Terminal', 'execute')
    case 'Read': {
      const offset = typeof input.offset === 'number' ? input.offset : null
      const limit = typeof input.limit === 'number' && input.limit > 0 ? input.limit : null
      const range =
        limit !== null
          ? ` (${offset ?? 1} - ${(offset ?? 1) + limit - 1})`
          : offset
            ? ` (from line ${offset})`
            : ''
      return view(`Read ${file ? displayPath(file, cwd) : 'File'}${range}`, 'read', {
        locations: file ? [{ path: file, line: offset ?? 1 }] : [],
      })
    }
    case 'Write': {
      const content = text(input.content) ?? text(input.file_text) ?? ''
      return view(file ? `Write ${displayPath(file, cwd)}` : 'Write', 'edit', {
        locations: file ? [{ path: file }] : [],
        content: file ? [{ type: 'diff', path: file, oldText: null, newText: toLf(content) }] : [],
      })
    }
    case 'Edit': {
      const oldText = typeof input.old_string === 'string' ? toLf(input.old_string) : ''
      const newText = typeof input.new_string === 'string' ? toLf(input.new_string) : ''
      return view(file ? `Edit ${displayPath(file, cwd)}` : 'Edit', 'edit', {
        locations: file ? [{ path: file }] : [],
        content: file ? [{ type: 'diff', path: file, oldText, newText }] : [],
      })
    }
    case 'NotebookEdit': {
      const notebook = text(input.notebook_path)
      return view(notebook ? `Edit ${displayPath(notebook, cwd)}` : 'Edit notebook', 'edit', {
        locations: notebook ? [{ path: notebook }] : [],
      })
    }
    case 'Glob': {
      let label = 'Find'
      if (text(input.path)) label += ` \`${String(input.path)}\``
      if (text(input.pattern)) label += ` \`${String(input.pattern)}\``
      return view(label, 'search', {
        locations: text(input.path) ? [{ path: String(input.path) }] : [],
      })
    }
    case 'Grep':
      return view(grepTitle(input), 'search')
    case 'WebFetch':
      return view(text(input.url) ? `Fetch ${String(input.url)}` : 'Fetch', 'fetch', {
        content: text(input.prompt) ? [markdown(String(input.prompt))] : [],
      })
    case 'WebSearch':
      return view(text(input.query) ? `Search "${String(input.query)}"` : 'Web search', 'fetch')
    case 'Agent':
    case 'Task':
      return view(text(input.description) ?? 'Task', 'think', {
        content: text(input.prompt) ? [markdown(String(input.prompt))] : [],
      })
    case 'ExitPlanMode':
      return view('Approve Plan', 'switch_mode', {
        content: text(input.plan) ? [markdown(String(input.plan))] : [],
      })
    case 'EnterPlanMode':
      return view('Plan', 'switch_mode')
    case 'Skill':
      return view(text(input.skill) ? `Load skill: ${String(input.skill)}` : 'Load skill', 'other')
    default:
      return view(name || 'Tool', 'other')
  }
}

/** The tools whose calls show as the session's plan instead of as tool calls. */
export const PLAN_TOOLS: ReadonlySet<string> = new Set([
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
])

/** The tools that start a subagent, which shows as a session of its own. */
export const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task'])

function blockRef(block: ContentBlock): ContentRef | null {
  if (block.type !== 'image') return null
  const source = (block as { source?: { type?: string; media_type?: string; data?: string } })
    .source
  if (source?.type !== 'base64' || !source.media_type || !source.data) return null
  return { kind: 'image', mimeType: source.media_type, data: source.data }
}

/** The text and images of a tool result, as Claude Code sent them to the model. */
export function resultParts(result: ToolResultBlock): { text: string; refs: ContentRef[] } {
  const { content } = result
  if (typeof content === 'string') return { text: content, refs: [] }
  if (!Array.isArray(content)) return { text: '', refs: [] }
  const texts: string[] = []
  const refs: ContentRef[] = []
  for (const block of content) {
    if (block.type === 'text') texts.push((block as { text: string }).text)
    else {
      const ref = blockRef(block)
      if (ref) refs.push(ref)
    }
  }
  return { text: texts.join('\n'), refs }
}

const REMINDER = /\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*/g

/**
 * What a finished tool call shows: its output, from the structured result where Claude Code
 * gives one, else from the text it sent the model. Null keeps what the call showed.
 */
export function resultContent(
  name: string,
  result: ToolResultBlock,
  structured: unknown,
  before: readonly ToolContent[],
): ToolContent[] | null {
  const { text: raw, refs } = resultParts(result)
  const error = result.is_error === true
  const body = toLf(raw.replace(REMINDER, '\n')).trim()
  const images: ToolContent[] = refs.map((ref) => ({ type: 'ref', ref }))
  const shaped = asInput(structured)
  if (name === 'Bash' || name === 'PowerShell') {
    let output = body
    if (typeof shaped.stdout === 'string' && typeof shaped.stderr === 'string') {
      output = [shaped.stdout, shaped.stderr].filter(Boolean).join('\n')
      if (shaped.interrupted === true) {
        output = [output, '[Command was aborted before completion]'].filter(Boolean).join('\n')
      }
    }
    output = toLf(output).replace(/\n+$/, '')
    return [...(output ? [markdown(fenced(output, 'console'))] : []), ...images]
  }
  if (error) return [...(body ? [markdown(fenced(body))] : []), ...images]
  switch (name) {
    case 'Edit':
    case 'NotebookEdit':
      return null
    case 'Write': {
      const original = shaped.originalFile
      if (typeof original !== 'string') return null
      return before.map((item) =>
        item.type === 'diff' ? { ...item, oldText: toLf(original) } : item,
      )
    }
    case 'ExitPlanMode':
    case 'EnterPlanMode':
      return null
    case 'Read': {
      const file = asInput(shaped.file)
      if (shaped.type === 'text' && typeof file.content === 'string' && file.content !== '') {
        const start = typeof file.startLine === 'number' ? file.startLine : 1
        const numbered = toLf(file.content)
          .replace(/\n$/, '')
          .split('\n')
          .map((line, i) => `${start + i}\t${line}`)
          .join('\n')
        return [markdown(fenced(numbered)), ...images]
      }
      return [...(body ? [markdown(fenced(body))] : []), ...images]
    }
    case 'Agent':
    case 'Task': {
      const report = shaped.content
      if (shaped.status === 'completed' && Array.isArray(report) && report.length > 0) {
        const texts = report.flatMap((block: unknown) =>
          typeof block === 'object' && block !== null && (block as ContentBlock).type === 'text'
            ? [(block as { text: string }).text]
            : [],
        )
        if (texts.length > 0) return [markdown(texts.join('\n\n'))]
      }
      return [...(body ? [markdown(body)] : []), ...images]
    }
    default:
      return [...(body ? [markdown(body)] : []), ...images]
  }
}

/** The tool the turn's own work keeps running after its call ended. */
export function startsBackgroundWork(name: string, input: unknown): boolean {
  const fields = asInput(input)
  if (name === 'Monitor') return true
  return fields.run_in_background === true && typeof fields.command === 'string'
}
