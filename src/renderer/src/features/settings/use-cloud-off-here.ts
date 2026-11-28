import { useHostScope } from '@renderer/stores/host-scope'

/** Whether the host shown by the current host scope has Kettu's cloud services turned off. */
export function useCloudOffHere(): boolean {
  return useHostScope().useSettingsStore((s) => !s.settings.cloud.enabled)
}
