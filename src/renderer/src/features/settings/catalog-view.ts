import type { CatalogState, CatalogTheme } from '@shared/themes'

/** The catalog as the dialog holds it: null while the index loads, or a call that threw. */
export type CatalogAnswer = CatalogState | { status: 'error'; message: string } | null

/** What the Browse themes dialog shows. */
export type CatalogView =
  | { kind: 'loading' }
  | { kind: 'failed'; error: 'unreachable' | 'invalid' | 'newer-format' }
  | { kind: 'error'; message: string }
  // The index lists no theme at all.
  | { kind: 'none' }
  | { kind: 'no-match'; query: string }
  | { kind: 'themes'; themes: CatalogTheme[] }

const fold = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()

/** The themes whose name holds the search, whatever its case and accents: "rose" finds Rosé Pine. */
export function matchingThemes(themes: CatalogTheme[], query: string): CatalogTheme[] {
  const needle = fold(query.trim())
  return needle ? themes.filter((theme) => fold(theme.name).includes(needle)) : themes
}

export function catalogView(answer: CatalogAnswer, query: string): CatalogView {
  if (answer === null) return { kind: 'loading' }
  if (answer.status === 'error') return { kind: 'error', message: answer.message }
  if (answer.status !== 'ok') return { kind: 'failed', error: answer.status }
  if (answer.themes.length === 0) return { kind: 'none' }
  const themes = matchingThemes(answer.themes, query)
  return themes.length > 0 ? { kind: 'themes', themes } : { kind: 'no-match', query: query.trim() }
}
