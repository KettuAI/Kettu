import { useEffect, useMemo } from 'react'
import type { SlashCommand } from '@shared/thread'
import { loadKettuCommands, useKettuCommands } from '@renderer/stores/kettu-commands'
import { mergeCommands } from './slash-list'

/**
 * The commands the composer lists: Kettu's own and the host's, with the agent's. `hostId` is the
 * host the session is on, null being this computer.
 */
export function useSlashCommands(
  hostId: string | null,
  builtin: readonly SlashCommand[],
  agent: readonly SlashCommand[],
): SlashCommand[] {
  const kettu = useKettuCommands(hostId)
  useEffect(() => {
    void loadKettuCommands(hostId)
  }, [hostId])
  return useMemo(() => mergeCommands({ builtin, kettu, agent }), [builtin, kettu, agent])
}
