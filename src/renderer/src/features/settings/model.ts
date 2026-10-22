import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { SettingsSection } from '@renderer/stores/view'

/** One row of a settings section: its name and description are what search matches. */
export interface RowDef {
  id: string
  name: string
  description?: string
  /** Extra words search should find, such as "dark" for the theme row. */
  keywords?: string
  /**
   * `block` hands the row's text to the control, which keeps it beside its main control on the
   * first line and puts what it reveals underneath; `custom` renders only the control, a card.
   */
  layout?: 'inline' | 'block' | 'custom'
  render: (text: ReactNode) => ReactNode
}

export interface SectionDef {
  id: SettingsSection
  title: string
  icon: LucideIcon
  rows: RowDef[]
  /** Shown under the rows, outside search, such as where the environment was read. */
  footer?: ReactNode
}

export function matches(row: RowDef, query: string): boolean {
  if (!query) return true
  const text = `${row.name} ${row.description ?? ''} ${row.keywords ?? ''}`.toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word))
}
