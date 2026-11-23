// The frames of an artifact that loaded an error answer instead of their page, as main saw them:
// a file of the version gone from the host's store, or a host not reached in time.

import { useCallback, useEffect, useState } from 'react'
import { parseServed } from '@shared/artifact-page'
import { isWeb } from '@renderer/lib/platform'

/** The HTTP status each failed file of the artifact at `url` answered with, by its path. */
export function useFailedFrames(url: string | null): {
  failed: ReadonlyMap<string, number>
  forget: (path: string) => void
} {
  const [failed, setFailed] = useState<ReadonlyMap<string, number>>(() => new Map())
  // Another origin starts with none.
  const [of, setOf] = useState(url)
  if (of !== url) {
    setOf(url)
    setFailed(new Map())
  }
  useEffect(() => {
    if (!url || isWeb) return
    const origin = url.slice(0, -1)
    return window.kettu.artifacts.onFrameFailed((event) => {
      if (event.origin !== origin) return
      const at = URL.parse(event.url)
      const path = at ? parseServed(at.pathname, at.searchParams)?.path : null
      if (!path) return
      setFailed((was) => new Map(was).set(path, event.status))
    })
  }, [url])
  const forget = useCallback(
    (path: string) =>
      setFailed((was) => {
        if (!was.has(path)) return was
        const next = new Map(was)
        next.delete(path)
        return next
      }),
    [],
  )
  return { failed, forget }
}
