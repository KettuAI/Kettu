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
}

/** One row of a settings section: its name and description are what search matches. */
export interface RowDef {
  id: string
  name: string
  description?: string
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
}

function words(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

export function matches(row: RowDef, query: string): boolean {
  if (!query) return true
  const text =
    `${row.name} ${row.description ?? ''} ${row.keywords ?? ''} ${row.english ?? ''}`.toLowerCase()
  return words(query).every((word) => text.includes(word))
}

/** The text cut around every place a word of the query occurs, for marking the matches. */
export function highlight(text: string, query: string): { text: string; match: boolean }[] {
  const wanted = words(query)
  if (wanted.length === 0) return [{ text, match: false }]
  const lower = text.toLowerCase()
  const marked = new Array<boolean>(text.length).fill(false)
  for (const word of wanted) {
    for (let at = lower.indexOf(word); at >= 0; at = lower.indexOf(word, at + word.length)) {
      marked.fill(true, at, at + word.length)
    }
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
