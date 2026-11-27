import { ComputerTerminal01Icon } from '@hugeicons/core-free-icons'
import { create } from 'zustand'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { i18n } from '@renderer/lib/i18n'
import { allowsTerminal } from '@renderer/stores/hosts'
import {
  closeAllTerminals,
  isRunningTerminal,
  loadTerminals,
  terminalsOf,
  useTerminalsStore,
  type TerminalState,
} from '@renderer/stores/terminals'

export interface CloseAllTerminalsQuestion {
  panel: string
  /** Terminals currently running a command that closing all terminals will terminate. */
  running: TerminalState[]
  answer: (confirmed: boolean) => void
}

export const useCloseAllTerminalsQuestion = create<{
  question: CloseAllTerminalsQuestion | null
}>(() => ({ question: null }))

function ask(question: CloseAllTerminalsQuestion): void {
  useCloseAllTerminalsQuestion.getState().question?.answer(false)
  useCloseAllTerminalsQuestion.setState({ question })
}

/**
 * Refreshes the terminal list for `projectPath` without cold-starting the local terminal host when
 * it is not already running.
 */
export async function refreshSessionTerminals(projectPath: string): Promise<void> {
  const hostId = hostOfPath(projectPath)
  if (!allowsTerminal(hostId)) return
  if (hostId === null && !(await window.kettu.terminals.running())) return
  await loadTerminals(projectPath)
}

/**
 * Closes every terminal in `panel`. Idle and exited terminals close immediately; when any terminal
 * has a running command, asks once before ending all of them.
 */
export async function requestCloseAllTerminals(
  panel: string,
  options: { notify?: boolean } = {},
): Promise<number> {
  const list = terminalsOf(useTerminalsStore.getState().byId, panel)
  if (list.length === 0) return 0
  const running = list.filter(isRunningTerminal)
  if (running.length > 0) {
    const confirmed = await new Promise<boolean>((answer) => ask({ panel, running, answer }))
    if (!confirmed) return 0
  }
  const { closed, errors } = await closeAllTerminals(
    panel,
    list.map((terminal) => terminal.id),
  )
  if (errors.length > 0) {
    toast(errorMessage(errors[0]))
  } else if (options.notify && closed > 0) {
    toast(i18n.t('terminal:closeAll.closed', { count: closed }), undefined, {
      icon: ComputerTerminal01Icon,
    })
  }
  return closed
}
