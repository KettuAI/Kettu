import { createContext, type ReactNode } from 'react'
import type { IconSvgElement } from '@hugeicons/react'
import { i18n } from '@renderer/lib/i18n'
import type { SettingsSection } from '@renderer/stores/view'
import type { Platform } from '@shared/platform'
import {
  CATALOG,
  keywordKeys,
  platformKey,
  type EntryText,
  type SettingId,
} from '@shared/settings-catalog'
import { queryWords as words, wordStarts } from '@shared/word-match'
import { platform } from '@renderer/lib/platform'

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
  /** Rows that draw on the page itself rather than on a card, as the theme tiles do. */
  plain?: boolean
  /** The label names the group for assistive technology only, as a lone card needs none. */
  unlabeled?: boolean
  /** What shows under the group's card, as a `GroupNote` saying what a setting implies. */
  note?: ReactNode
  /** The row the note explains: it shows only while that row does, as it does not in the web client. */
  noteFor?: string
  /** Draws the group's card from its rows, as a list the user drags into another order does. */
  card?: (rows: RowDef[]) => ReactNode
}

/**
 * One row of a settings section. Its words come from its entry in the settings catalog, which
 * agents read too, so no row exists without one; a list's rows name their item themselves.
 */
export interface RowDef {
  id: string
  setting: SettingId
  /** One item of a list entry, such as an agent, a device or a site, by its own name. */
  item?: { name: string; description?: string; keywords?: string }
  /** The description as it reads now, where the state changes it; null for none. */
  description?: string | null
  /** Values for the entry's words, such as the host the page shows. */
  params?: Record<string, unknown>
  /** The description as the row shows it, when it marks up more than text, such as keys. */
  rich?: ReactNode
  /** Consecutive rows with the same group show under its label. */
  group?: GroupDef
  /**
   * `block` hands the row's text to the control, which keeps it beside its main control on the
   * first line and puts what it reveals underneath; `custom` renders only the control; `bare`
   * renders only the control and draws no line under it, as Text size draws its own.
   */
  layout?: 'inline' | 'block' | 'custom' | 'bare'
  render: (text: ReactNode) => ReactNode
  /** Where choosing the row in search results goes, when not to the row on its page. */
  open?: () => void
  /** Found by search but drawn by the page itself, as the environment line under the agents is. */
  searchOnly?: boolean
}

/** A row's words: its name and description, the words search also finds, and its English name. */
export interface RowText {
  name: string
  description?: string
  keywords?: string
  english: string
}

type Words = (key: string, options?: Record<string, unknown>) => string

/** An entry's own name and description, for the rows an item's page draws itself. */
export function entryText(setting: SettingId, params?: Record<string, unknown>) {
  return rowText({ id: '', setting, params, render: () => null })
}

/** A row's words in the interface's language, from its catalog entry or its item. */
export function rowText(row: RowDef): RowText {
  const entry = CATALOG[row.setting]
  const t = i18n.getFixedT(null, 'settings') as unknown as Words
  const en = i18n.getFixedT('en', 'settings') as unknown as Words
  const key = (text: EntryText) => platformKey(text, platform as Platform)
  const keywords = [...keywordKeys(entry).map((k) => t(k)), row.item?.keywords]
    .filter(Boolean)
    .join(' ')
  const description =
    row.description !== undefined
      ? (row.description ?? undefined)
      : row.item
        ? row.item.description
        : entry.description && t(key(entry.description), row.params)
  return {
    name: row.item?.name ?? t(key(entry.name), row.params),
    ...(description ? { description } : {}),
    ...(keywords ? { keywords } : {}),
    english: en(key(entry.name), row.params),
  }
}

export interface SectionDef {
  id: SettingsSection
  title: string
  /** The page's one line under its title. */
  description: string
  icon: IconSvgElement
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

/** Whether every word of the query starts a word of the row's name, description or keywords. */
export function matches(row: RowDef, query: string): boolean {
  if (!query) return true
  const { name, description, keywords, english } = rowText(row)
  const text = `${name} ${description ?? ''} ${keywords ?? ''} ${english}`.toLowerCase()
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
