import type { AgentStatus, SessionSummary } from '@shared/agent-host'
import { harnessOf, type AgentId, type HarnessId } from '@shared/thread'
import { i18n } from '@renderer/lib/i18n'
import type { HarnessSessionCount } from '@renderer/stores/sessions'
import type { HarnessBatchEntry } from '@renderer/stores/updates'
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

/** Where one update of the batch the card follows is. */
export type BatchState = 'queued' | 'installing' | 'waiting' | 'updated' | 'failed'

/** One harness update of the batch, asked for together with Update all or one by one. */
export interface BatchItem extends Omit<HarnessBatchEntry, 'ended'> {
  state: BatchState
  /** Its sessions running on this computer now, which it waits for. */
  running: number
  failure: HarnessFailure | null
}

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
  /** A batch with an update installing or queued; `run` is the one installing, once it reports. */
  | { kind: 'batch'; items: BatchItem[]; run: HarnessRun | null }
  /** `updated`: the others of its batch that installed. */
  | { kind: 'failed'; failure: HarnessFailure; updated: number }
  | { kind: 'waiting'; item: HarnessItem; batch: BatchItem[] }
  /** `updated`: the harnesses a batch just installed, said under Kettu's own update. */
  | { kind: 'one'; item: UpdateItem; updated: number }
  | { kind: 'several'; items: UpdateItem[] }
  /** Every update of the batch installed, said for a moment. */
  | { kind: 'done'; items: BatchItem[] }

export interface UpdatesInput {
  app: AppUpdateNotice | null
  statuses: AgentStatus[]
  taskErrors: AgentTaskErrors
  /** This computer's sessions, which tell which harnesses run now and how often each is used. */
  sessions: readonly Pick<SessionSummary, 'agentId' | 'status'>[]
  /** Pre-aggregated per-harness counts; avoids O(N) scans when provided by `useUpdates`. */
  sessionCounts?: readonly HarnessSessionCount[]
  waiting: readonly AgentId[]
  queued: readonly AgentId[]
  /** The update the queue runs now, before its agent reports the task. */
  installing: AgentId | null
  batch: readonly HarnessBatchEntry[]
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

function runningCounts(input: UpdatesInput): Partial<Record<HarnessId, number>> {
  if (!input.sessionCounts) return runningByHarness(input.sessions)
  const counts: Partial<Record<HarnessId, number>> = {}
  for (const { harnessId, running } of input.sessionCounts) {
    if (running > 0) counts[harnessId] = running
  }
  return counts
}

/** Every update in the review list's order: Kettu first, then the harnesses used most. */
export function updateItems(input: UpdatesInput): UpdateItem[] {
  const { offers } = harnessUpdates(input.statuses, input.taskErrors)
  const running = runningCounts(input)
  const used: Partial<Record<HarnessId, number>> = {}
  if (input.sessionCounts) {
    for (const { harnessId, total } of input.sessionCounts) used[harnessId] = total
  } else {
    for (const { agentId } of input.sessions) {
      const harness = harnessOf(agentId)
      used[harness] = (used[harness] ?? 0) + 1
    }
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

/** The batch the card follows, each update where it is now. */
export function updateBatch(input: UpdatesInput): BatchItem[] {
  const { running, failures } = harnessUpdates(input.statuses, input.taskErrors)
  return batchItems(input, running, failures)
}

function batchItems(
  input: UpdatesInput,
  running: HarnessRun | null,
  failures: HarnessFailure[],
): BatchItem[] {
  const sessions = runningCounts(input)
  return input.batch.map(({ ended, ...entry }) => {
    const id = entry.agentId
    const failure = failures.find((f) => f.agentId === id) ?? null
    let state: BatchState
    if (running?.agentId === id || input.installing === id) state = 'installing'
    else if (input.waiting.includes(id)) state = 'waiting'
    else if (input.queued.includes(id)) state = 'queued'
    else if (ended === 'failed' || (ended === null && failure)) state = 'failed'
    else if (ended === 'updated') state = 'updated'
    // Asked for, between the queue's steps.
    else state = 'queued'
    return { ...entry, state, running: sessions[harnessOf(id)] ?? 0, failure }
  })
}

/**
 * The card: an update installing first, then the batch the card follows until it has said how it
 * ended, then those on offer.
 */
export function updateCard(input: UpdatesInput): UpdateCard | null {
  const { running, failed, failures } = harnessUpdates(input.statuses, input.taskErrors)
  const batch = batchItems(input, running, failures)
  const inBatch = (id: AgentId) => batch.some((item) => item.agentId === id)
  // An update started elsewhere, such as on the harness's settings page.
  if (running && !inBatch(running.agentId)) {
    return {
      kind: 'installing',
      run: { kind: 'harness', run: running },
      percent: null,
      more: input.queued.filter((id) => id !== running.agentId).length,
    }
  }
  if (batch.some((item) => item.state === 'installing' || item.state === 'queued')) {
    return { kind: 'batch', items: batch, run: running }
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
  const updated = batch.filter((item) => item.state === 'updated').length
  const failedItem = batch.find((item) => item.state === 'failed' && item.failure)
  if (failedItem) return { kind: 'failed', failure: failedItem.failure!, updated }
  if (failed) return { kind: 'failed', failure: failed, updated: 0 }
  const items = updateItems(input)
  const waiting = batch.find((item) => item.state === 'waiting')
  const waitingItem = items.find(
    (item): item is HarnessItem =>
      item.kind === 'harness' && item.offer.agentId === waiting?.agentId,
  )
  if (waitingItem) return { kind: 'waiting', item: waitingItem, batch }
  const shown = items.filter((item) => item.kind === 'app' || !item.skipped)
  // "Updated to" only says what happened, so it gives way to anything still to do.
  const todo = shown.filter((item) => item.kind !== 'app' || item.notice.kind !== 'updated')
  if (batch.length > 0 && updated === batch.length) {
    // Kettu's own update is the batch's last step, as only it restarts.
    if (todo.length === 1 && todo[0]!.kind === 'app') {
      return { kind: 'one', item: todo[0]!, updated }
    }
    return { kind: 'done', items: batch }
  }
  const offered = shown.length > 1 ? todo : shown
  if (offered.length === 0) return null
  if (offered.length > 1) return { kind: 'several', items: offered }
  const item = offered[0]!
  if (item.kind === 'harness' && item.waiting) return { kind: 'waiting', item, batch }
  return { kind: 'one', item, updated: 0 }
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

/** An update's name: Kettu, or the harness's. */
export function itemName(item: UpdateItem): string {
  return item.kind === 'app' ? 'Kettu' : item.offer.name
}

/** The subtitle of the several-updates card, their names: "Kettu, Claude Code, Codex". */
export function severalNote(items: readonly UpdateItem[]): string {
  return items.map(itemName).join(i18n.t('sidebar:footer.listSeparator'))
}

/** The card's first line, its name, as the collapsed sidebar's toggle lists it. */
export function updateCardLabel(card: UpdateCard): string {
  switch (card.kind) {
    case 'batch': {
      const now =
        card.items.find((item) => item.state === 'installing') ??
        card.items.find((item) => item.state === 'queued')
      return i18n.t('updates:harness.installing', { name: now?.name ?? '' })
    }
    case 'done':
      return i18n.t('updates:done.title')
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
