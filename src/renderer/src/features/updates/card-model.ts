import type { AgentStatus, SessionSummary } from '@shared/agent-host'
import { harnessOf, type AgentId, type HarnessId } from '@shared/thread'
import { i18n } from '@renderer/lib/i18n'
import type { AgentTaskErrors, AgentUpdateOffer, HarnessFailure, HarnessRun } from './agent-updates'
import { harnessUpdates } from './agent-updates'
import { appUpdateText, type AppUpdateNotice } from './app-updates'

/** The app's update, as one entry of the card and the review list. */
export interface AppItem {
  kind: 'app'
  notice: AppUpdateNotice
}

/** A harness's update on offer, as one entry of the card and the review list. */
export interface HarnessItem {
  kind: 'harness'
  offer: AgentUpdateOffer
  harnessId: HarnessId
  /** The agents that run this harness, its default one included. */
  agents: number
  /** Its sessions running on this computer now, which an update waits for. */
  running: number
  /** Asked for, and waiting for those sessions to end. */
  waiting: boolean
  /** Asked for, and waiting its turn behind the update installing. */
  queued: boolean
  skipped: boolean
}

export type UpdateItem = AppItem | HarnessItem

/** What the sidebar's one update card shows; it never stacks a second card. */
export type UpdateCard =
  | {
      kind: 'installing'
      run: { kind: 'app'; notice: AppUpdateNotice } | { kind: 'harness'; run: HarnessRun }
      /** Known only for the app's download. */
      percent: number | null
      /** The updates queued behind this one. */
      more: number
    }
  | { kind: 'failed'; failure: HarnessFailure }
  | { kind: 'waiting'; item: HarnessItem }
  | { kind: 'one'; item: UpdateItem }
  | { kind: 'several'; items: UpdateItem[] }

export interface UpdatesInput {
  app: AppUpdateNotice | null
  statuses: AgentStatus[]
  taskErrors: AgentTaskErrors
  /** This computer's sessions, which tell which harnesses run now and how often each is used. */
  sessions: readonly Pick<SessionSummary, 'agentId' | 'status'>[]
  waiting: readonly AgentId[]
  queued: readonly AgentId[]
}

/** The sessions of each harness with a turn running, which a harness update waits for. */
export function runningByHarness(
  sessions: readonly Pick<SessionSummary, 'agentId' | 'status'>[],
): Partial<Record<HarnessId, number>> {
  const counts: Partial<Record<HarnessId, number>> = {}
  for (const { agentId, status } of sessions) {
    if (status !== 'running' && status !== 'awaiting_permission') continue
    const harness = harnessOf(agentId)
    counts[harness] = (counts[harness] ?? 0) + 1
  }
  return counts
}

/** Every update in the review list's order: Kettu first, then the harnesses used most. */
export function updateItems(input: UpdatesInput): UpdateItem[] {
  const { offers } = harnessUpdates(input.statuses, input.taskErrors)
  const running = runningByHarness(input.sessions)
  const used: Partial<Record<HarnessId, number>> = {}
  for (const { agentId } of input.sessions) {
    const harness = harnessOf(agentId)
    used[harness] = (used[harness] ?? 0) + 1
  }
  const harnesses = offers.map(({ offer, skipped }): HarnessItem => {
    const harnessId = harnessOf(offer.agentId)
    return {
      kind: 'harness',
      offer,
      harnessId,
      agents: input.statuses.filter((s) => s.harnessId === harnessId && !s.hidden).length,
      running: running[harnessId] ?? 0,
      waiting: input.waiting.includes(offer.agentId),
      queued: input.queued.includes(offer.agentId),
      skipped,
    }
  })
  // Sorting is stable, so harnesses used as often keep the agents' order.
  harnesses.sort((a, b) => (used[b.harnessId] ?? 0) - (used[a.harnessId] ?? 0))
  const app: UpdateItem[] = input.app ? [{ kind: 'app', notice: input.app }] : []
  return [...app, ...harnesses]
}

/** The card: an update installing first, then one that failed, then those on offer. */
export function updateCard(input: UpdatesInput): UpdateCard | null {
  const { running, failed } = harnessUpdates(input.statuses, input.taskErrors)
  if (running) {
    return {
      kind: 'installing',
      run: { kind: 'harness', run: running },
      percent: null,
      more: input.queued.filter((id) => id !== running.agentId).length,
    }
  }
  const app = input.app
  if (app?.kind === 'downloading' || app?.kind === 'moving') {
    return {
      kind: 'installing',
      run: { kind: 'app', notice: app },
      percent: app.kind === 'downloading' ? app.percent : null,
      more: input.queued.length,
    }
  }
  if (failed) return { kind: 'failed', failure: failed }
  const shown = updateItems(input).filter((item) => item.kind === 'app' || !item.skipped)
  // "Updated to" only says what happened, so it gives way to anything still to do.
  const items =
    shown.length > 1
      ? shown.filter((item) => item.kind !== 'app' || item.notice.kind !== 'updated')
      : shown
  if (items.length === 0) return null
  if (items.length > 1) return { kind: 'several', items }
  const item = items[0]!
  if (item.kind === 'harness' && item.waiting) return { kind: 'waiting', item }
  return { kind: 'one', item }
}

/** "2.4.1 → 2.5.0", the package's name first when the versions are its own. */
export function versionsText(offer: AgentUpdateOffer): string {
  if (!offer.from) return offer.to
  const from = offer.package?.versions ? `${offer.package.name} ${offer.from}` : offer.from
  return `${from} → ${offer.to}`
}

/** The card's two lines for one harness's update on offer. */
export function harnessOfferText(item: HarnessItem): { title: string; note: string } {
  const { offer } = item
  const versions = versionsText(offer)
  return {
    title: i18n.t('updates:harness.offer', { name: offer.name, version: offer.to }),
    note:
      item.agents > 1
        ? i18n.t('updates:harness.offerAgents', { versions, count: item.agents })
        : versions,
  }
}

/** The review list's line under a harness's name and versions. */
export function harnessRowNote(item: HarnessItem): string {
  if (item.skipped) return i18n.t('updates:review.skipped')
  if (item.running > 0) return i18n.t('updates:review.waits', { count: item.running })
  return i18n.t('updates:review.background')
}

/** The subtitle of the several-updates card: "Kettu + 2 harnesses". */
export function severalNote(items: readonly UpdateItem[]): string {
  const harnesses = items.filter((item) => item.kind === 'harness').length
  return items.some((item) => item.kind === 'app')
    ? i18n.t('updates:several.withKettu', { count: harnesses })
    : i18n.t('updates:several.harnesses', { count: harnesses })
}

/** The card's first line, its name, as the collapsed sidebar's toggle lists it. */
export function updateCardLabel(card: UpdateCard): string {
  switch (card.kind) {
    case 'installing':
      return card.run.kind === 'app'
        ? appUpdateText(card.run.notice).title
        : i18n.t('updates:harness.installing', { name: card.run.run.name })
    case 'failed':
      return i18n.t('updates:harness.failed', { name: card.failure.name })
    case 'waiting':
      return i18n.t('updates:harness.waiting', {
        name: card.item.offer.name,
        version: card.item.offer.to,
      })
    case 'one':
      return card.item.kind === 'app'
        ? appUpdateText(card.item.notice).title
        : i18n.t('updates:harness.offerLabel', {
            name: card.item.offer.name,
            version: card.item.offer.to,
          })
    case 'several':
      return i18n.t('updates:several.title', { count: card.items.length })
  }
}
