import { AnimatePresence } from 'motion/react'
import { useShallow } from 'zustand/react/shallow'
import type { AgentId } from '@shared/thread'
import { ControlLabel } from '@renderer/components/control/control-label'
import { useControlAgent } from '@renderer/components/control/use-control-agent'
import {
  handBackTerminal,
  takeOverTerminal,
  terminalInUse,
  useTerminalsStore,
} from '@renderer/stores/terminals'

/** On the composer's top edge while the session's turn uses a terminal its agent started. */
export function TerminalLabel({
  sessionId,
  agentId,
  hostId,
}: {
  sessionId: string
  agentId: AgentId
  hostId: string | null
}) {
  const used = useTerminalsStore(
    useShallow((s) => {
      const found = terminalInUse(s, sessionId)
      return found ?? { id: null, name: '', control: null }
    }),
  )
  const agent = useControlAgent(agentId, hostId)
  const { id, name, control } = used
  return (
    <AnimatePresence>
      {id && control && agent && (
        <ControlLabel
          key="terminal"
          surface="terminal"
          control={control}
          agent={agent}
          hostId={hostId}
          target={name}
          held={name}
          onTakeOver={() => takeOverTerminal(id)}
          onHandBack={() => handBackTerminal(id)}
          onDone={() => handBackTerminal(id)}
        />
      )}
    </AnimatePresence>
  )
}
