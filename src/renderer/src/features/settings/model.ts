import { createContext, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { i18n } from '@renderer/lib/i18n'
import type { SettingsSection } from '@renderer/stores/view'

/** The row a search result led to, lit for a moment once its page shows. */
export const FlashContext = createContext<string | null>(null)

/** A labelled run of rows on a page, such as "Language and input". */
export interface GroupDef {
  id: string
  label: string
  /** Shown after the label, as Agents counts its installed agents. */
  count?: number
  /** Small actions at the label's end, such as Send a test notification. */
  actions?: ReactNode
  tone?: 'danger'
  /** Rows that draw on the page itself rather than on a card, as the theme tiles do. */
  plain?: boolean
  /** The label names the group for assistive technology only, as a lone card needs none. */
  unlabeled?: boolean
  /** What shows under the group's card, as a `GroupNote` saying what a setting implies. */
  note?: ReactNode
}

/** One row of a settings section: its name and description are what search matches. */
export interface RowDef {
  id: string
  name: string
  description?: string
  /** The description as the row shows it, when it marks up more than text, such as keys. */
  rich?: ReactNode
  /** Extra words search should find, such as "dark" for the theme row. */
  keywords?: string
  /** The name in English, so a search in English finds the row in any language. */
  english?: string
  /** Consecutive rows with the same group show under its label. */
  group?: GroupDef
  /**
   * `block` hands the row's text to the control, which keeps it beside its main control on the
   * first line and puts what it reveals underneath; `custom` renders only the control.
   */
  layout?: 'inline' | 'block' | 'custom'
  render: (text: ReactNode) => ReactNode
  /** Where choosing the row in search results goes, when not to the row on its page. */
  open?: () => void
  /** Found by search but drawn by the page itself, as the environment line under the agents is. */
  searchOnly?: boolean
}

export interface SectionDef {
  id: SettingsSection
  title: string
  /** The page's one line under its title. */
  description: string
  icon: LucideIcon
  rows: RowDef[]
  /** Takes the place of the title and description, as About's app name does. */
  hero?: ReactNode
  /** Shown under the rows, outside search, such as where the environment was read. */
  footer?: ReactNode
  /** A dot after the section's name in the list, such as an agent update. */
  mark?: string
  /** The page of one of the section's items, such as an agent's or a server's, by its id. */
  itemPage?: (item: string) => ReactNode
}

function words(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

const WORD = /[\p{L}\p{N}]/u
// Chinese and Japanese run their words together, so any character can start one.
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u

function startsWord(text: string, at: number): boolean {
  if (at === 0) return true
  const before = text[at - 1]!
  return !WORD.test(before) || UNSPACED.test(before) || UNSPACED.test(text[at]!)
}

/** Where `word` starts a word of `lower`, so "sh" finds Shell but not finished. */
function wordStarts(lower: string, word: string): number[] {
  const found: number[] = []
  for (let at = lower.indexOf(word); at >= 0; at = lower.indexOf(word, at + 1)) {
    if (startsWord(lower, at)) found.push(at)
  }
  return found
}

/** Whether every word of the query starts a word of the row's name, description or keywords. */
export function matches(row: RowDef, query: string): boolean {
  if (!query) return true
  const text =
    `${row.name} ${row.description ?? ''} ${row.keywords ?? ''} ${row.english ?? ''}`.toLowerCase()
  return words(query).every((word) => wordStarts(text, word).length > 0)
}

// A description whose first match starts past this many characters shows from shortly before it.
const EXCERPT_AFTER = 72
const EXCERPT_BEFORE = 48

/** The text, or for a match deep in it, the text from a word shortly before the match. */
export function excerpt(text: string, query: string): string {
  const lower = text.toLowerCase()
  const first = Math.min(...words(query).map((word) => wordStarts(lower, word)[0] ?? Infinity))
  if (first === Infinity || first <= EXCERPT_AFTER) return text
  const space = text.indexOf(' ', first - EXCERPT_BEFORE)
  const from = space >= 0 && space < first ? space + 1 : first - EXCERPT_BEFORE
  return `…${text.slice(from)}`
}

/** The text cut around every place a word of the query starts a word, for marking the matches. */
export function highlight(text: string, query: string): { text: string; match: boolean }[] {
  const wanted = words(query)
  if (wanted.length === 0) return [{ text, match: false }]
  const lower = text.toLowerCase()
  const marked = new Array<boolean>(text.length).fill(false)
  for (const word of wanted) {
    for (const at of wordStarts(lower, word)) marked.fill(true, at, at + word.length)
  }
  const parts: { text: string; match: boolean }[] = []
  for (let i = 0; i < text.length; i++) {
    const last = parts.at(-1)
    if (last && last.match === marked[i]) last.text += text[i]
    else parts.push({ text: text[i]!, match: marked[i]! })
  }
  return parts
}

/** Settings text in English, whatever the interface language, for `RowDef.english`. */
export function english() {
  return i18n.getFixedT('en', 'settings')
}
