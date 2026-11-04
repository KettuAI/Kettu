/** What fills a session's context, as the agent's own report breaks it down. */
export interface ContextBreakdown {
  model: string | null
  used: number
  size: number
  /** In the report's order, free space and the autocompact buffer included. */
  categories: { name: string; tokens: number; share: number | null }[]
  lists: ContextList[]
  observedAt: number
}

export interface ContextList {
  name: string
  items: { name: string; detail: string | null; tokens: string }[]
}

/** The last successful snapshot and the state of its refresh, shared with every viewer. */
export interface ContextReport {
  key: string
  breakdown: ContextBreakdown | null
  loading: boolean
  error: string | null
}

export const CONTEXT_REFRESH_MS = 2_000
