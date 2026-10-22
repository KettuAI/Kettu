import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/ipc'

/** The app's version and runtime, read once the About page shows. */
export function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    void window.overbench.app.getInfo().then(setInfo)
  }, [])
  return info
}
