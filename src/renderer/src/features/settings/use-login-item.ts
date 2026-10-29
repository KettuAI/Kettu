import { useEffect, useState } from 'react'
import type { LoginItemStatus } from '@shared/ipc'
import { useSettingsStore } from '@renderer/stores/settings'

/** The login item's state, read again whenever the setting changes. */
export function useLoginItemStatus(): LoginItemStatus | null {
  const openAtLogin = useSettingsStore((s) => s.settings.general.openAtLogin)
  const [status, setStatus] = useState<LoginItemStatus | null>(null)
  useEffect(() => {
    let live = true
    window.kettu.loginItem.getStatus().then(
      (next) => {
        if (live) setStatus(next)
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [openAtLogin])
  return status
}
