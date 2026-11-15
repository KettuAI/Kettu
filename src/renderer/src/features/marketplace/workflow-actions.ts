// The workflow library's reads and changes the Marketplace makes: reading it again, and adding a workflow
// from a .yaml file picked on this computer.

import { WORKFLOW_FILE_BYTES, type WorkflowEntry } from '@shared/workflow'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage } from '@renderer/lib/host'
import { i18n } from '@renderer/lib/i18n'
import { useHostScope, type HostScope } from '@renderer/stores/host-scope'
import { useHostWorkflows, useWorkflowsStore } from '@renderer/stores/workflows'
import { openMarketplace } from '@renderer/stores/view'
import { itemKey } from './model'
import { WORKFLOW_FILE_KB } from './workflow-model'

/** The workflows of the host the page shows, as last read. */
export function useWorkflows() {
  const { hostId } = useHostScope()
  return useHostWorkflows(hostId)
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
