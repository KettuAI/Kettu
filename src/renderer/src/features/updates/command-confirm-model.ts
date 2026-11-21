// The step before Kettu runs the update of a program the user installed: its command, shown with
// Run and Cancel on every surface that offers the update.

import { create } from 'zustand'
import type { AgentStatus } from '@shared/agent-host'
import { updateOffer } from '@shared/agent-update-offer'
import type { AgentId } from '@shared/thread'
import { useAgentsStore } from '@renderer/stores/agents'

/** A program's update command, and the harness it updates. */
export interface ProgramCommand {
  agentId: AgentId
  name: string
  command: string
}

export interface CommandQuestion {
  commands: ProgramCommand[]
  answer: (run: boolean) => void
}

export const useCommandQuestion = create<{ question: CommandQuestion | null }>(() => ({
  question: null,
}))

/**
 * Shows the commands, each once, and resolves to whether the user chose Run; true at once when
 * there are none, as for updates of Kettu's own installs.
 */
export function confirmCommands(commands: readonly ProgramCommand[]): Promise<boolean> {
  const unique = commands.filter(
    (entry, index) => commands.findIndex((other) => other.command === entry.command) === index,
  )
  if (unique.length === 0) return Promise.resolve(true)
  return new Promise((resolve) => {
    useCommandQuestion.getState().question?.answer(false)
    useCommandQuestion.setState({ question: { commands: unique, answer: resolve } })
  })
}

/** The update commands of the user's own programs among these harnesses' updates on offer. */
export function programCommands(agentIds: readonly AgentId[]): ProgramCommand[] {
  const { byId } = useAgentsStore.getState()
  return agentIds.flatMap((agentId) => {
    const status = byId[agentId]
    const offer = status ? updateOffer(status) : null
    return offer?.command ? [{ agentId, name: offer.name, command: offer.command }] : []
  })
}

/** Updates the user's own program once they saw its command and chose Run. */
export async function confirmCliUpdate(status: AgentStatus): Promise<void> {
  const update = status.cli?.update
  if (update) {
    const command = { agentId: status.id, name: status.harnessName, command: update.command }
    if (!(await confirmCommands([command]))) return
  }
  await useAgentsStore.getState().updateCli(status.id)
}
