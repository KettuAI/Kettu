import { useState } from 'react'
import type { SettingsPatch } from '@shared/settings'
import { errorMessage } from '@renderer/lib/host'
import { useHostScope } from '@renderer/stores/host-scope'

/**
 * Applies a change at once, on the host the section shows; a failure shows next to the control
 * that caused it.
 */
export function useApply(): [(patch: SettingsPatch) => void, string | null] {
  const { useSettingsStore } = useHostScope()
  const [error, setError] = useState<string | null>(null)
  const apply = (patch: SettingsPatch) => {
    setError(null)
    useSettingsStore
      .getState()
      .update(patch)
      .catch((e: unknown) => setError(errorMessage(e)))
  }
  return [apply, error]
}
