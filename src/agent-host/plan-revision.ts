// A plan an agent asks the user to approve, the same for every agent: its number among the plans
// since the last one approved, and the plan it revises when the user sent the one before back.

import type { ThreadState, ToolEntry } from '@shared/thread'

/** A plan entry's plan: its first Markdown content. */
export function planMarkdown(entry: ToolEntry): string {
  const item = entry.content.find((content) => content.type === 'markdown')
  return item?.type === 'markdown' ? item.markdown : ''
}

export interface PlanRevision {
  /** From 1, counting the plans since the last approved one. */
  version: number
  /** The plan before, when the user sent it back; null otherwise. */
  previous: string | null
}

function answerKind(entry: ToolEntry): string | null {
  const result = entry.permissionResult
  return typeof result === 'object' && result !== null ? result.kind : null
}

/** The revision `entryId` holds, from the plan entries before it; a new entry counts at the end. */
export function planRevision(thread: ThreadState, entryId: string): PlanRevision {
  const at = thread.order.indexOf(entryId)
  let version = 1
  let previous: string | null = null
  let latest = true
  for (let i = (at === -1 ? thread.order.length : at) - 1; i >= 0; i--) {
    const entry = thread.byId[thread.order[i]!]
    if (entry?.kind !== 'tool' || entry.planVersion === undefined) continue
    const kind = answerKind(entry)
    if (kind === 'allow_once' || kind === 'allow_always') break
    // Kept planning: the user sent it back with the option that keeps planning.
    if (latest && (kind === 'reject_once' || kind === 'reject_always')) {
      previous = planMarkdown(entry)
    }
    latest = false
    version++
  }
  return { version, previous }
}
