// The SOP library's reads and changes the Marketplace makes: reading it again, and adding an SOP
// from a .yaml file picked on this computer.

import { SOP_FILE_BYTES, type SopEntry } from '@shared/sop'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage } from '@renderer/lib/host'
import { i18n } from '@renderer/lib/i18n'
import { useHostScope, type HostScope } from '@renderer/stores/host-scope'
import { useHostSops, useSopsStore } from '@renderer/stores/sops'
import { openMarketplace } from '@renderer/stores/view'
import { itemKey } from './model'
import { SOP_FILE_KB } from './sop-model'

/** The SOPs of the host the page shows, as last read. */
export function useSops() {
  const { hostId } = useHostScope()
  return useHostSops(hostId)
}

export function retrySops(scope: HostScope): Promise<void> {
  return useSopsStore.getState().load(scope.hostId)
}

/** Asks for an SOP file through the page's own file picker; null when the user closes it. */
function pickSopFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.yaml,.yml'
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true })
    input.addEventListener('cancel', () => resolve(null), { once: true })
    input.click()
  })
}

/** Shows the SOP just added, read again first so its page finds it. */
export async function showAdded(scope: HostScope, entry: SopEntry): Promise<void> {
  await retrySops(scope)
  openMarketplace({ item: itemKey({ kind: 'sop', id: entry.id }), tab: 'sop' })
}

/**
 * Picks a .yaml file, reads it here and hands its text to the host, which keeps it unapproved:
 * `added`, why it failed, or `closed` when the picker was closed.
 */
export async function addSopFile(
  scope: HostScope,
): Promise<'added' | 'closed' | { error: string }> {
  const file = await pickSopFile()
  if (!file) return 'closed'
  if (!/\.ya?ml$/i.test(file.name)) return { error: i18n.t('marketplace:sop.add.notYaml') }
  if (file.size > SOP_FILE_BYTES) {
    return { error: i18n.t('marketplace:sop.add.tooLarge', { size: SOP_FILE_KB }) }
  }
  try {
    const text = await file.text()
    const entry = await scope.request('sops.add', { kind: 'file', name: file.name, text })
    await showAdded(scope, entry)
    return 'added'
  } catch (error) {
    return { error: errorMessage(error) }
  }
}

/** The Add menu's file item: a failure shows as a toast, since no dialog is open. */
export function addSopFromFile(scope: HostScope): void {
  void addSopFile(scope).then((result) => {
    if (typeof result === 'object') {
      toast(i18n.t('marketplace:sop.add.failed', { error: result.error }), undefined, {
        tone: 'warning',
      })
    }
  })
}
