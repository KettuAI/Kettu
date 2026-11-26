import {
  bundledLanguages,
  bundledLanguagesInfo,
  createHighlighter,
  type BundledLanguage,
  type BundledTheme,
  type GrammarState,
  type Highlighter,
  type SpecialLanguage,
  type ThemedToken,
  type ThemeRegistrationAny,
} from 'shiki'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import type {
  CodeHighlighterPlugin,
  CodePluginOptions,
  HighlightOptions,
  HighlightResult,
  ThemeInput,
} from '@streamdown/code'

const CHARS_PER_COST = 64
// Skip heavy TextMate regex tokenization for huge pasted dumps so the main thread and heap stay bounded.
const MAX_HIGHLIGHT_CHARS = 60_000
const MAX_HIGHLIGHT_LINES = 1_500
const MAX_STREAM_PREFIXES = 8

const isWebClient = (): boolean =>
  typeof window !== 'undefined' &&
  (window as { kettu?: { client?: string } }).kettu?.client === 'web'

const ALIASES: Record<string, BundledLanguage> = Object.fromEntries(
  bundledLanguagesInfo.flatMap((info) =>
    (info.aliases ?? []).map((alias) => [alias, info.id as BundledLanguage]),
  ),
)

const SUPPORTED = new Set<string>(Object.keys(bundledLanguages))

function normalizeLanguage(language: string): string {
  const lowered = language.trim().toLowerCase()
  return ALIASES[lowered] ?? lowered
}

function themeName(theme: ThemeInput): string {
  return typeof theme === 'string' ? theme : (theme.name ?? 'custom')
}

function cacheKey(code: string, language: string, light: string, dark: string): string {
  return `${language}:${light}:${dark}\n${code}`
}

function tokenCost(code: string, result: HighlightResult): number {
  let cost = result.tokens.length + Math.ceil(code.length / CHARS_PER_COST)
  for (const line of result.tokens) cost += line.length
  return cost
}

interface CacheEntry {
  cost: number
  result: HighlightResult
}

interface StreamPrefix {
  lang: string
  light: string
  dark: string
  prefix: string
  rows: ThemedToken[][]
  grammarState: GrammarState | undefined
}

const engine = createJavaScriptRegexEngine({ forgiving: true })
let sharedHighlighterPromise: Promise<Highlighter> | null = null
let sharedHighlighter: Highlighter | null = null
const loadedThemes = new Set<string>()
const loadedLangs = new Set<string>(['text', 'plaintext', 'txt'])
const loadingThemes = new Map<string, Promise<void>>()
const loadingLangs = new Map<string, Promise<void>>()

const tokenCache = new Map<string, CacheEntry>()
let totalCost = 0
const streamPrefixes: StreamPrefix[] = []

function cacheLimits(): { maxEntries: number; maxCost: number } {
  return isWebClient() ? { maxEntries: 120, maxCost: 24_000 } : { maxEntries: 240, maxCost: 60_000 }
}

function getCached(key: string): HighlightResult | undefined {
  const entry = tokenCache.get(key)
  if (!entry) return undefined
  tokenCache.delete(key)
  tokenCache.set(key, entry)
  return entry.result
}

function removeCached(key: string): void {
  const entry = tokenCache.get(key)
  if (!entry) return
  tokenCache.delete(key)
  totalCost -= entry.cost
}

function setCached(key: string, code: string, result: HighlightResult): void {
  removeCached(key)
  const cost = tokenCost(code, result)
  const { maxEntries, maxCost } = cacheLimits()
  if (cost > maxCost) return
  tokenCache.set(key, { cost, result })
  totalCost += cost
  while ((totalCost > maxCost || tokenCache.size > maxEntries) && tokenCache.size > 1) {
    const oldest = tokenCache.keys().next().value
    if (oldest === undefined) break
    removeCached(oldest)
  }
}

function shiftOffsets(lines: ThemedToken[][], delta: number): void {
  if (delta === 0) return
  for (const line of lines) {
    for (const token of line) token.offset += delta
  }
}

function plainResult(code: string): HighlightResult {
  const rawLines = code.split('\n')
  const tokens: ThemedToken[][] = []
  let offset = 0
  for (const line of rawLines) {
    tokens.push(line.length > 0 ? [{ content: line, offset }] : [])
    offset += line.length + 1
  }
  return { tokens, fg: undefined, bg: undefined }
}

function tooLargeForHighlight(code: string): boolean {
  if (code.length > MAX_HIGHLIGHT_CHARS) return true
  let lines = 1
  for (let i = code.indexOf('\n'); i !== -1; i = code.indexOf('\n', i + 1)) {
    if (++lines > MAX_HIGHLIGHT_LINES) return true
  }
  return false
}

function getSharedHighlighter(): Promise<Highlighter> {
  if (!sharedHighlighterPromise) {
    sharedHighlighterPromise = createHighlighter({ themes: [], langs: [], engine }).then((h) => {
      sharedHighlighter = h
      return h
    })
  }
  return sharedHighlighterPromise
}

async function ensureTheme(highlighter: Highlighter, theme: ThemeInput): Promise<void> {
  const name = themeName(theme)
  if (loadedThemes.has(name)) return
  let pending = loadingThemes.get(name)
  if (!pending) {
    pending = highlighter
      .loadTheme(theme as BundledTheme | ThemeRegistrationAny)
      .then(() => {
        loadedThemes.add(name)
      })
      .finally(() => {
        loadingThemes.delete(name)
      })
    loadingThemes.set(name, pending)
  }
  await pending
}

async function ensureLanguage(highlighter: Highlighter, language: string): Promise<void> {
  if (loadedLangs.has(language) || !SUPPORTED.has(language)) return
  let pending = loadingLangs.get(language)
  if (!pending) {
    pending = highlighter
      .loadLanguage(language as BundledLanguage)
      .then(() => {
        loadedLangs.add(language)
      })
      .finally(() => {
        loadingLangs.delete(language)
      })
    loadingLangs.set(language, pending)
  }
  await pending
}

function putStreamPrefix(entry: StreamPrefix): void {
  streamPrefixes.push(entry)
  if (streamPrefixes.length > MAX_STREAM_PREFIXES) {
    streamPrefixes.splice(0, streamPrefixes.length - MAX_STREAM_PREFIXES)
  }
}

function takeMatchingStreamPrefix(
  lang: string,
  light: string,
  dark: string,
  code: string,
): StreamPrefix | undefined {
  let bestIdx = -1
  let bestLen = -1
  for (let i = streamPrefixes.length - 1; i >= 0; i--) {
    const entry = streamPrefixes[i]!
    if (
      entry.lang === lang &&
      entry.light === light &&
      entry.dark === dark &&
      entry.prefix.length > bestLen &&
      code.startsWith(entry.prefix)
    ) {
      bestIdx = i
      bestLen = entry.prefix.length
    }
  }
  if (bestIdx < 0) return undefined
  return streamPrefixes.splice(bestIdx, 1)[0]
}

function highlightWith(
  highlighter: Highlighter,
  code: string,
  language: string,
  light: string,
  dark: string,
  isIncomplete: boolean,
): HighlightResult {
  const lang = (loadedLangs.has(language) ? language : 'text') as BundledLanguage | SpecialLanguage
  const themes = { light, dark }
  if (!isIncomplete) {
    return highlighter.codeToTokens(code, { lang, themes })
  }
  // Only streaming blocks keep incremental line prefixes, bounded to a tiny LRU.
  const previous = takeMatchingStreamPrefix(lang, light, dark, code)
  let prefix = previous ? previous.prefix : ''
  let rows = previous ? previous.rows : []
  let grammarState = previous?.grammarState
  const lastNewline = code.lastIndexOf('\n') + 1
  if (lastNewline > prefix.length) {
    const chunk = highlighter.codeToTokens(code.slice(prefix.length, lastNewline), {
      lang,
      themes,
      grammarState,
    })
    const completed = chunk.tokens
    completed.pop()
    shiftOffsets(completed, prefix.length)
    rows = rows.concat(completed)
    grammarState = chunk.grammarState
    prefix = code.slice(0, lastNewline)
    putStreamPrefix({ lang, light, dark, prefix, rows, grammarState })
  } else if (previous) {
    putStreamPrefix(previous)
  }
  const tail = highlighter.codeToTokens(code.slice(lastNewline), {
    lang,
    themes,
    grammarState,
  })
  shiftOffsets(tail.tokens, lastNewline)
  return { ...tail, tokens: rows.concat(tail.tokens) }
}

/**
 * Shared single-instance Shiki code plugin for Streamdown.
 * Unlike `@streamdown/code`, which creates one Shiki highlighter per language/theme pair and keeps
 * up to 5,000 blocks / 300,000 tokens plus unbounded prefix caches, this shares one highlighter
 * across all languages and bounds both caches.
 */
export function createCodePlugin(options: CodePluginOptions = {}): CodeHighlighterPlugin {
  const defaultThemes: [ThemeInput, ThemeInput] = options.themes ?? ['github-light', 'github-dark']
  return {
    name: 'shiki',
    type: 'code-highlighter',
    supportsLanguage(language: BundledLanguage) {
      return SUPPORTED.has(normalizeLanguage(language))
    },
    getSupportedLanguages() {
      return Array.from(SUPPORTED) as BundledLanguage[]
    },
    getThemes() {
      return defaultThemes
    },
    highlight(
      { code, language, themes, isIncomplete = false }: HighlightOptions,
      callback?: (result: HighlightResult) => void,
    ): HighlightResult | null {
      if (tooLargeForHighlight(code)) return plainResult(code)
      const normalized = normalizeLanguage(language)
      const lang = SUPPORTED.has(normalized) ? normalized : 'text'
      const light = themeName(themes[0])
      const dark = themeName(themes[1])
      const key = cacheKey(code, lang, light, dark)
      const cached = getCached(key)
      if (cached) return cached

      if (
        sharedHighlighter &&
        loadedThemes.has(light) &&
        loadedThemes.has(dark) &&
        loadedLangs.has(lang)
      ) {
        const result = highlightWith(sharedHighlighter, code, lang, light, dark, isIncomplete)
        if (!isIncomplete) setCached(key, code, result)
        return result
      }

      void getSharedHighlighter()
        .then(async (highlighter) => {
          await Promise.all([
            ensureTheme(highlighter, themes[0]),
            ensureTheme(highlighter, themes[1]),
            ensureLanguage(highlighter, lang),
          ])
          let result = getCached(key)
          if (!result) {
            result = highlightWith(highlighter, code, lang, light, dark, isIncomplete)
            if (!isIncomplete) setCached(key, code, result)
          }
          callback?.(result)
        })
        .catch((error: unknown) => {
          console.error('[CodePlugin] Failed to highlight code:', error)
        })
      return null
    },
  }
}

/** Test-only helper to inspect or clear the bounded caches. */
export const _codePluginCacheForTests = {
  size: () => tokenCache.size,
  cost: () => totalCost,
  streamPrefixCount: () => streamPrefixes.length,
  clear: () => {
    tokenCache.clear()
    totalCost = 0
    streamPrefixes.length = 0
  },
}
