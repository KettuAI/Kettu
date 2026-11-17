import type { LimitView } from '@renderer/lib/plan-limit'
import { useSettingsStore } from '@renderer/stores/settings'

/** Whether this window's plan limits show the share used or the share left. */
export function useLimitView(): LimitView {
  return useSettingsStore((s) => s.settings.usage.limits)
}
