import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/ipc'
import { useHostScope } from '@renderer/stores/host-scope'

/** The version and system of the host the section shows, read once the component shows. */
export function useAppInfo(): AppInfo | null {
  const { api } = useHostScope()
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    let live = true
    api.getInfo().then(
      (read) => live && setInfo(read),
      (error: unknown) => console.warn('Could not read the host', error),
    )
    return () => {
      live = false
    }
  }, [api])
  return info
}
