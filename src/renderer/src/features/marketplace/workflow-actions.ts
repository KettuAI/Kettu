// The workflow library's reads and changes the Marketplace makes: reading it again, adding a workflow
// from a .yaml file picked on this computer, and adding or updating one from the Kettu Marketplace.

import { WORKFLOW_FILE_BYTES, type WorkflowEntry } from '@shared/workflow'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage } from '@renderer/lib/host'
import { i18n } from '@renderer/lib/i18n'
import { useHostScope, type HostScope } from '@renderer/stores/host-scope'
import { busyKey, setBusy } from '@renderer/stores/marketplace'
import { useHostWorkflows, useWorkflowsStore } from '@renderer/stores/workflows'
import { openMarketplace, type MarketplaceTab } from '@renderer/stores/view'
import { itemKey, updateFor } from './model'
import { listingOrigin, WORKFLOW_FILE_KB } from './workflow-model'

// Bound to the namespace only: each call reads the language shown at the time.
const tm = i18n.getFixedT(null, 'marketplace')

/** The workflows of the host the page shows, as last read. */
export function useWorkflows() {
  const { hostId } = useHostScope()
  return useHostWorkflows(hostId)
}

/** The library's workflow of a Kettu Marketplace listing; null while it has none. */
export function useListingWorkflow(listingId: string): WorkflowEntry | null {
  const { entries } = useWorkflows()
  return entries.find((entry) => listingOrigin(entry)?.listingId === listingId) ?? null
}

/**
 * Where a workflow from the Kettu Marketplace stands with its listing: the newer version it offers,
 * or one that replaces a withdrawn version, and whether it was taken down.
 */
export function useWorkflowStanding(entry: WorkflowEntry): {
  update: string | null
  takenDown: boolean
} {
  const { useMarketplaceStore } = useHostScope()
  const origin = listingOrigin(entry)
  const standing = useMarketplaceStore((s) =>
    origin ? s.communityInstalled?.standings[origin.listingId] : undefined,
  )
  return {
    update: origin ? updateFor(standing, origin.version) : null,
    takenDown: standing?.state === 'taken-down',
  }
}

/**
 * Adds a workflow listing to the host's library, or updates the one it has to the listing's
 * version: the host checks every file and the workflow before it writes it, unapproved. A new one
 * opens on its page, where its approval waits, unless `stay`.
 */
export async function addCommunityWorkflow(
  scope: HostScope,
  listing: { id: string; name: string },
  how: { update?: boolean; tab?: MarketplaceTab; stay?: boolean } = {},
): Promise<void> {
  const busy = busyKey('community', listing.id)
  const market = scope.useMarketplaceStore
  if (market.getState().busy.includes(busy)) return
  setBusy(market, busy, true)
  try {
    const entry = await scope.request('market.addCommunityWorkflow', { id: listing.id })
    await retryWorkflows(scope)
    void market.getState().loadCommunityInstalled(true)
    const version = listingOrigin(entry)?.version ?? ''
    toast(
      how.update
        ? tm('toast.workflowUpdated', { name: entry.name, version })
        : tm('toast.workflowAdded', { name: entry.name }),
      undefined,
      { tone: 'success' },
    )
    if (!how.update && !how.stay) {
      openMarketplace({
        item: itemKey({ kind: 'workflow', id: entry.id }),
        tab: how.tab ?? 'workflow',
      })
    }
  } catch (error) {
    toast(
      tm(how.update ? 'toast.updateFailed' : 'toast.installFailed', {
        name: listing.name,
        error: errorMessage(error),
      }),
      {
        label: i18n.t('common:actions.retry'),
        onClick: () => void addCommunityWorkflow(scope, listing, how),
      },
      { tone: 'warning' },
    )
  } finally {
    setBusy(market, busy, false)
  }
}

export function retryWorkflows(scope: HostScope): Promise<void> {
  return useWorkflowsStore.getState().load(scope.hostId)
}

/** Asks for a workflow file through the page's own file picker; null when the user closes it. */
function pickWorkflowFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.yaml,.yml'
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true })
    input.addEventListener('cancel', () => resolve(null), { once: true })
    input.click()
  })
}

/** Shows the workflow just added, read again first so its page finds it. */
export async function showAdded(scope: HostScope, entry: WorkflowEntry): Promise<void> {
  await retryWorkflows(scope)
  openMarketplace({ item: itemKey({ kind: 'workflow', id: entry.id }), tab: 'workflow' })
}

/**
 * Picks a .yaml file, reads it here and hands its text to the host, which keeps it unapproved:
 * `added`, why it failed, or `closed` when the picker was closed.
 */
export async function addWorkflowFile(
  scope: HostScope,
): Promise<'added' | 'closed' | { error: string }> {
  const file = await pickWorkflowFile()
  if (!file) return 'closed'
  if (!/\.ya?ml$/i.test(file.name)) return { error: i18n.t('marketplace:workflow.add.notYaml') }
  if (file.size > WORKFLOW_FILE_BYTES) {
    return { error: i18n.t('marketplace:workflow.add.tooLarge', { size: WORKFLOW_FILE_KB }) }
  }
  try {
    const text = await file.text()
    const entry = await scope.request('workflows.add', { kind: 'file', name: file.name, text })
    await showAdded(scope, entry)
    return 'added'
  } catch (error) {
    return { error: errorMessage(error) }
  }
}

/** The Add menu's file item: a failure shows as a toast, since no dialog is open. */
export function addWorkflowFromFile(scope: HostScope): void {
  void addWorkflowFile(scope).then((result) => {
    if (typeof result === 'object') {
      toast(i18n.t('marketplace:workflow.add.failed', { error: result.error }), undefined, {
        tone: 'warning',
      })
    }
  })
}
