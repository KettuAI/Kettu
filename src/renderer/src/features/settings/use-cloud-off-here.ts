import { useCloudOff } from '@renderer/lib/cloud'
import { useHostScope } from '@renderer/stores/host-scope'

/** Whether the host section shows this computer while its Kettu cloud is off. */
export function useCloudOffHere(): boolean {
  const { hostId } = useHostScope()
  const off = useCloudOff()
  return off && hostId === null
}
