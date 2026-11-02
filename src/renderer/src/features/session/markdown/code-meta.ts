// What a code fence says about its block beyond the language.

const QUOTED = /\b(?:title|file|filename|name)=(?:"([^"]+)"|'([^']+)'|(\S+))/
const PATHLIKE = /^(?:[\w.~@-]+[\\/])*[\w.@-]*\.[\w-]+$|^(?:[\w.~@-]+[\\/])+[\w.@-]+$/

/**
 * The file a fence names: `title="src/a.ts"` (or `file=`, `filename=`, `name=`), else the first
 * word of the meta that looks like a path, as in ```` ```ts src/usage/day-key.ts ````. A language
 * written as `ts:src/a.ts` names one too.
 */
export function fenceFileName(language: string, meta: string | undefined): string | null {
  const colon = language.indexOf(':')
  if (colon > 0 && colon < language.length - 1) return language.slice(colon + 1)
  if (!meta) return null
  const quoted = QUOTED.exec(meta)
  if (quoted) return quoted[1] ?? quoted[2] ?? quoted[3] ?? null
  for (const word of meta.trim().split(/\s+/)) {
    if (word.startsWith('{') || word.includes('=')) continue
    if (PATHLIKE.test(word)) return word
  }
  return null
}

/** The fence's language without a file name glued to it. */
export function fenceLanguage(language: string): string {
  const colon = language.indexOf(':')
  return colon > 0 ? language.slice(0, colon) : language
}

/** Blocks longer than this many lines start folded. */
export const FOLD_OVER = 20
/** How many lines a folded block shows. */
export const FOLDED_LINES = 7

/** The lines a block shows, and how many it hides, folded or not. */
export function foldLines(code: string, folded: boolean): { shown: string; hidden: number } {
  const lines = code.replace(/\n$/, '').split('\n')
  if (!folded || lines.length <= FOLD_OVER) return { shown: code, hidden: 0 }
  return { shown: lines.slice(0, FOLDED_LINES).join('\n'), hidden: lines.length - FOLDED_LINES }
}
