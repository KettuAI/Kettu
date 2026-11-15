import { useSettingsStore } from '@renderer/stores/settings'
import { useCloudOffHere } from './use-cloud-off-here'

/** Whether updates come from GitHub only, as chosen or because Kettu's services are off here. */
export function useGitHubOnly(): boolean {
  const chosen = useSettingsStore((s) => s.settings.updates.source === 'github')
  return useCloudOffHere() || chosen
}
