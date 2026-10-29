import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/ipc'

/** The app's version and system, read once the component shows. */
export function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    void window.kettu.app.getInfo().then(setInfo)
  }, [])
  return info
}
