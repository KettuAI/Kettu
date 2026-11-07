// Which artifacts main publishes or updates on its own, while the switch for it is on.

import type { ArtifactBrief } from '@shared/host-control'
import type { AutoState, PublishedPage } from './store'

/** How long an artifact is left alone after its last version, so a burst of edits is one upload. */
export const AUTO_QUIET_MS = 5_000

export type AutoStep =
  { kind: 'publish'; id: string; version: number } | { kind: 'update'; id: string; version: number }

export interface AutoPlan {
  /** Oldest change first. */
  steps: AutoStep[]
  /** Milliseconds until the soonest artifact still being changed is quiet; null when none is. */
  wait: number | null
}

/**
 * The steps for the artifacts the host has: a new one published, and a page on Kettu whose artifact
 * has a later version updated. New means made since `auto.since`, not unpublished by the user and not
 * in Recently deleted; a page of another target or account, or of an artifact in Recently deleted,
 * is left alone.
 */
export function planAuto(input: {
  artifacts: readonly ArtifactBrief[]
  pages: readonly PublishedPage[]
  auto: AutoState
  accountId: string
  now: number
}): AutoPlan {
  const { artifacts, pages, auto, accountId, now } = input
  const byId = new Map(pages.map((page) => [page.id, page]))
  const declined = new Set(auto.declined)
  const due: { step: AutoStep; updatedAt: number }[] = []
  let wait: number | null = null
  for (const artifact of artifacts) {
    if (artifact.deleted) continue
    const page = byId.get(artifact.id)
    let step: AutoStep
    if (page) {
      if (page.target !== 'kettu' || page.accountId !== accountId) continue
      if (page.version >= artifact.version) continue
      step = { kind: 'update', id: artifact.id, version: artifact.version }
    } else {
      if (auto.since === null || artifact.createdAt < auto.since || declined.has(artifact.id)) {
        continue
      }
      step = { kind: 'publish', id: artifact.id, version: artifact.version }
    }
    const left = AUTO_QUIET_MS - (now - artifact.updatedAt)
    if (left > 0) {
      wait = wait === null ? left : Math.min(wait, left)
      continue
    }
    due.push({ step, updatedAt: artifact.updatedAt })
  }
  due.sort((a, b) => a.updatedAt - b.updatedAt)
  return { steps: due.map((entry) => entry.step), wait }
}
