import { AnimatePresence } from 'motion/react'
import { useShallow } from 'zustand/react/shallow'
import type { AgentId } from '@shared/thread'
import { ControlLabel } from '@renderer/components/control/control-label'
import { useControlAgent } from '@renderer/components/control/use-control-agent'
import { controlDevice, useDevicesStore } from '@renderer/stores/devices'

export function DeviceLabels({
  sessionId,
  agentId,
  hostId,
}: {
  sessionId: string
  agentId: AgentId
  hostId: string | null
}) {
  const devices = useDevicesStore(
    useShallow((s) => s.devices.filter((device) => device.sessionId === sessionId)),
  )
  const agent = useControlAgent(agentId, hostId)
  return (
    <AnimatePresence>
      {agent &&
        devices.map(({ id, name, operator }) =>
          operator ? (
            <ControlLabel
              key={id}
              surface="device"
              control={operator.control}
              agent={agent}
              hostId={hostId}
              target={name}
              held={name}
              onTakeOver={() => controlDevice('devices.takeOver', id, sessionId)}
              onHandBack={() => controlDevice('devices.handBack', id, sessionId)}
              onDone={() => controlDevice('devices.handBack', id, sessionId)}
            />
          ) : null,
        )}
    </AnimatePresence>
  )
}
