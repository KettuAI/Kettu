// What the Files pane's left column shows, kept by side panel while another pane takes its place.

export interface Column {
  mode: 'changes' | 'all' | null
  query: string
  searching: boolean
  expanded: ReadonlySet<string>
  /** The open file the tree last opened its folders for. */
  revealed: string | undefined
  /** The tree's chosen rows, and the one a Shift click reaches from. */
  selected: ReadonlySet<string>
  anchor: string | null
  scroll: number
}

const columns = new Map<string, Column>()
export const NO_PATHS: ReadonlySet<string> = new Set()

export function columnOf(key: string): Column {
  return (
    columns.get(key) ?? {
      mode: null,
      query: '',
      searching: false,
      expanded: NO_PATHS,
      revealed: undefined,
      selected: NO_PATHS,
      anchor: null,
      scroll: 0,
    }
  )
}

export function saveColumn(key: string, change: Partial<Column>): void {
  columns.set(key, { ...columnOf(key), ...change })
}
