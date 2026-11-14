import { useEffect, useState } from 'react'

/** The system's icon for the app at `path`, as main reads it; null until then, or when none. */
export function useAppIcon(path: string | null): string | null {
  const [icon, setIcon] = useState<{ path: string; url: string | null } | null>(null)
  useEffect(() => {
    if (!path) return
    let live = true
    window.kettu.computer.appIcon(path).then(
      (url) => live && setIcon({ path, url }),
      () => live && setIcon({ path, url: null }),
    )
    return () => {
      live = false
    }
  }, [path])
  return icon && icon.path === path ? icon.url : null
}
