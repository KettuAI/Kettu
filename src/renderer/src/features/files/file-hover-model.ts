// Pure model and layout helpers for the desktop thread file hover preview.

import { nameOf } from './paths'

/** Pointer dwell before opening the file hover preview, avoiding flicker on pass-through. */
export const FILE_HOVER_OPEN_DELAY_MS = 400
/** Short close grace so the pointer can travel into the scrollable preview card. */
export const FILE_HOVER_CLOSE_DELAY_MS = 180
/** Maximum rendered lines in one hover preview so scrolling stays smooth. */
export const FILE_HOVER_MAX_LINES = 400
/** Maximum rendered characters in one hover preview so minified files stay bounded. */
export const FILE_HOVER_MAX_CHARS = 40_000
/** Maximum characters kept per line before clipping with an ellipsis. */
export const FILE_HOVER_MAX_LINE_CHARS = 2_000
/** Lines of context kept before a targeted line when slicing a long file around it. */
export const FILE_HOVER_CONTEXT_BEFORE = 120

/** Inclusive 1-based line range. */
export interface LineRange {
  start: number
  end: number
}

export interface PreviewSliceLimits {
  maxLines?: number
  maxChars?: number
  maxLineChars?: number
  contextBefore?: number
}

export interface PreviewLine {
  /** 1-based line number in the original file. */
  number: number
  text: string
  /** Whether this individual line exceeded the per-line character cap and was clipped. */
  lineTruncated: boolean
}

export interface PreviewTextSlice {
  lines: PreviewLine[]
  /** 1-based first displayed line number, or 0 when the file is empty. */
  startLine: number
  /** 1-based last displayed line number, or 0 when the file is empty. */
  endLine: number
  /** Total line count of the source text. */
  totalLines: number
  /** Targeted line range clamped to [1, totalLines], or null if no target was given. */
  highlight: LineRange | null
  /** True when earlier lines precede `startLine`. */
  truncatedBefore: boolean
  /** True when later lines follow `endLine` or budget truncation occurred. */
  truncatedAfter: boolean
  /** True when any content was omitted by line or character caps. */
  truncated: boolean
  /** True when the file holds zero characters. */
  empty: boolean
}

function positiveInt(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const n = Math.trunc(value)
  return n > 0 ? n : null
}

/** Normalizes a start line and optional end line into an inclusive 1-based LineRange. */
export function normalizeLineRange(
  line: number | null | undefined,
  endLine?: number | null,
): LineRange | null {
  const start = positiveInt(line)
  if (start === null) return null
  const end = positiveInt(endLine)
  return { start, end: end !== null && end >= start ? end : start }
}

const LINE_RANGE_TEXT = /^(\d+)(?:[-–](\d+))?$/

/** Parses a chip's `lines` string such as `42` or `41-44` / `41–44` into a LineRange. */
export function parseLineRangeText(lines: string | null | undefined): LineRange | null {
  if (!lines) return null
  const match = LINE_RANGE_TEXT.exec(lines.trim())
  if (!match) return null
  return normalizeLineRange(Number(match[1]), match[2] ? Number(match[2]) : null)
}

/** Formats a LineRange concisely (`42` or `41-44` with an en-dash). */
export function formatLineRange(range: LineRange | null): string | null {
  if (!range) return null
  return range.end > range.start ? `${range.start}\u2013${range.end}` : String(range.start)
}

/** Formats a file target with optional line or range for labels and tooltips. */
export function formatFileTarget(path: string, range: LineRange | null): string {
  const suffix = formatLineRange(range)
  return suffix ? `${path}:${suffix}` : path
}

/** Splits source text into logical 1-based lines, ignoring a single trailing newline. */
function splitLines(text: string): string[] {
  if (text.length === 0) return []
  const normalized = text.replace(/\r\n?/g, '\n')
  const raw = normalized.split('\n')
  if (raw.length > 1 && raw.at(-1) === '') raw.pop()
  return raw
}

function clipLine(line: string, maxLineChars: number): { text: string; truncated: boolean } {
  if (line.length <= maxLineChars) return { text: line, truncated: false }
  const end = /[\uD800-\uDBFF]/.test(line[maxLineChars - 1] ?? '') ? maxLineChars - 1 : maxLineChars
  return { text: `${line.slice(0, end)}\u2026`, truncated: true }
}

/**
 * Slices file text into a bounded window suitable for the hover preview.
 * Small and medium files render completely; large files slice around the targeted line range
 * (when provided) or from line 1, enforcing both line and character budgets.
 */
export function slicePreviewText(
  text: string,
  range: LineRange | null,
  limits: PreviewSliceLimits = {},
): PreviewTextSlice {
  const maxLines = Math.max(1, limits.maxLines ?? FILE_HOVER_MAX_LINES)
  const maxChars = Math.max(1, limits.maxChars ?? FILE_HOVER_MAX_CHARS)
  const maxLineChars = Math.max(16, limits.maxLineChars ?? FILE_HOVER_MAX_LINE_CHARS)
  const contextBefore = Math.max(0, limits.contextBefore ?? FILE_HOVER_CONTEXT_BEFORE)

  const all = splitLines(text)
  const totalLines = all.length
  if (totalLines === 0) {
    return {
      lines: [],
      startLine: 0,
      endLine: 0,
      totalLines: 0,
      highlight: null,
      truncatedBefore: false,
      truncatedAfter: false,
      truncated: false,
      empty: true,
    }
  }

  const highlight: LineRange | null = range
    ? {
        start: Math.min(Math.max(1, range.start), totalLines),
        end: Math.min(Math.max(range.start, range.end), totalLines),
      }
    : null

  let windowStart = 1
  if (totalLines > maxLines && highlight && highlight.end > maxLines) {
    windowStart = Math.max(1, Math.min(highlight.start - contextBefore, totalLines - maxLines + 1))
  }
  const windowEnd = Math.min(totalLines, windowStart + maxLines - 1)

  const buildWindow = (from: number, to: number) => {
    const out: PreviewLine[] = []
    let chars = 0
    let hitCharLimit = false
    let anyLineTruncated = false
    for (let number = from; number <= to; number++) {
      const clipped = clipLine(all[number - 1] ?? '', maxLineChars)
      const nextChars = chars + clipped.text.length + 1
      if (out.length > 0 && nextChars > maxChars) {
        hitCharLimit = true
        break
      }
      if (clipped.truncated) anyLineTruncated = true
      chars = nextChars
      out.push({ number, text: clipped.text, lineTruncated: clipped.truncated })
    }
    return { lines: out, hitCharLimit, anyLineTruncated }
  }

  let built = buildWindow(windowStart, windowEnd)
  // If very long lines exhausted the character budget before reaching the target line, recenter near it.
  if (
    highlight &&
    built.lines.length > 0 &&
    built.lines.at(-1)!.number < highlight.start &&
    windowStart < highlight.start
  ) {
    const recenteredStart = Math.max(1, highlight.start - Math.min(contextBefore, 8))
    const recenteredEnd = Math.min(totalLines, recenteredStart + maxLines - 1)
    windowStart = recenteredStart
    built = buildWindow(windowStart, recenteredEnd)
    if (built.lines.length > 0 && built.lines.at(-1)!.number < highlight.start) {
      windowStart = highlight.start
      built = buildWindow(windowStart, Math.min(totalLines, highlight.start + maxLines - 1))
    }
  }

  const startLine = built.lines[0]?.number ?? 0
  const endLine = built.lines.at(-1)?.number ?? 0
  const truncatedBefore = startLine > 1
  const truncatedAfter = endLine < totalLines || built.hitCharLimit
  return {
    lines: built.lines,
    startLine,
    endLine,
    totalLines,
    highlight,
    truncatedBefore,
    truncatedAfter,
    truncated: truncatedBefore || truncatedAfter || built.anyLineTruncated,
    empty: false,
  }
}

/**
 * Computes the vertical scroll offset inside the preview scroll container so a targeted line
 * or range appears comfortably centered without scrolling any ancestor container.
 */
export function computePreviewScrollTop({
  rowOffsetTop,
  rowHeight,
  highlightHeight = rowHeight,
  containerHeight,
  scrollHeight,
}: {
  rowOffsetTop: number
  rowHeight: number
  highlightHeight?: number
  containerHeight: number
  scrollHeight: number
}): number {
  const maxScroll = Math.max(0, scrollHeight - containerHeight)
  if (maxScroll === 0 || containerHeight <= 0) return 0
  const desired =
    highlightHeight <= containerHeight
      ? rowOffsetTop - (containerHeight - highlightHeight) / 2
      : rowOffsetTop - Math.min(containerHeight * 0.25, rowHeight * 3)
  return Math.round(Math.min(maxScroll, Math.max(0, desired)))
}

const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'jsonc',
  json5: 'json5',
  py: 'python',
  pyi: 'python',
  rs: 'rust',
  go: 'go',
  rb: 'ruby',
  php: 'php',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'mdx',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  env: 'dotenv',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'fish',
  ps1: 'powershell',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  mk: 'makefile',
  diff: 'diff',
  patch: 'diff',
  lua: 'lua',
  r: 'r',
  dart: 'dart',
  ex: 'elixir',
  exs: 'elixir',
  zig: 'zig',
  vue: 'vue',
  svelte: 'svelte',
  astro: 'astro',
  prisma: 'prisma',
  proto: 'proto',
  tf: 'hcl',
  hcl: 'hcl',
  nix: 'nix',
}

const BASENAME_LANGUAGE: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  gemfile: 'ruby',
  rakefile: 'ruby',
  podfile: 'ruby',
  justfile: 'makefile',
  '.bashrc': 'bash',
  '.zshrc': 'bash',
  '.env': 'dotenv',
  '.gitignore': 'ini',
  '.npmrc': 'ini',
  '.editorconfig': 'ini',
}

/** Maps a file path to a Shiki language id, falling back to `text`. */
export function languageFromFilePath(path: string): string {
  const fileName = nameOf(path.replace(/\\/g, '/')).toLowerCase()
  if (!fileName) return 'text'
  if (fileName in BASENAME_LANGUAGE) return BASENAME_LANGUAGE[fileName]!
  if (fileName.startsWith('.env.')) return 'dotenv'
  if (fileName.startsWith('dockerfile.')) return 'dockerfile'
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0 || dot === fileName.length - 1) return 'text'
  const ext = fileName.slice(dot + 1)
  return EXTENSION_LANGUAGE[ext] ?? 'text'
}

/** Whether a file is an SVG whose source should be requested as text when targeting lines. */
export function shouldReadAsText(path: string, range: LineRange | null): boolean {
  return range !== null && /\.svg$/i.test(path)
}
