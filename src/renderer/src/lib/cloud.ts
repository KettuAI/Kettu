import { useSettingsStore } from '@renderer/stores/settings'
import { isWeb } from './platform'

/**
 * Whether Kettu's cloud services are off on this computer, the self-hosted mode. It is read from
 * the window's own settings, whatever host a section shows, since the switch belongs to this
 * computer. The web client never shows the switch, so it never counts as off there.
 */
export function useCloudOff(): boolean {
  return useSettingsStore((s) => !isWeb && !s.settings.cloud.enabled)
}
