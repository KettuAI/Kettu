import { AnimatePresence } from 'motion/react'
import { useShallow } from 'zustand/react/shallow'
import type { AgentId } from '@shared/thread'
import { ControlLabel } from '@renderer/components/control/control-label'
import { useControlAgent } from '@renderer/components/control/use-control-agent'
import { controlDevice, deviceInUse, useDevicesStore } from '@renderer/stores/devices'

/** On the composer's top edge while a turn of the session uses one of its devices. */
export function DeviceLabel({
  sessionId,
  agentId,
  hostId,
}: {
  sessionId: string
  agentId: AgentId
  hostId: string | null
}) {
  const used = useDevicesStore(
    useShallow((s) => {
      const device = deviceInUse(s.devices, sessionId)
      return device
        ? { id: device.id, name: device.name, control: device.operator.control }
        : { id: null, name: '', control: null }
    }),
  )
  const agent = useControlAgent(agentId, hostId)
  const { id, name, control } = used
  return (
    <AnimatePresence>
      {id && control && agent && (
        <ControlLabel
          key="device"
          surface="device"
          control={control}
          agent={agent}
          hostId={hostId}
          target={name}
          held={name}
          onTakeOver={() => controlDevice('devices.takeOver', id, sessionId)}
          onHandBack={() => controlDevice('devices.handBack', id, sessionId)}
          onDone={() => controlDevice('devices.handBack', id, sessionId)}
        />
      )}
    </AnimatePresence>
  )
}
