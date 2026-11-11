import { useEffect, useState } from 'react'
import type { CommentThread } from '@shared/artifact-comments'
import { artifactHost, errorMessage, host } from '@renderer/lib/host'
import { onArtifactEvent } from '@renderer/stores/artifacts'
import { useArtifactHostConnected } from './artifact-host'

/**
 * The artifact's comment threads, read again when they change and with each new version, which
 * moves their anchors; null until read.
 */
export function useComments(id: string | null): {
  threads: CommentThread[] | null
  error: string | null
} {
  const [threads, setThreads] = useState<CommentThread[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const connected = useArtifactHostConnected(id)

  useEffect(() => {
    if (!connected || id === null) return
    let live = true
    let reading = false
    let again = false
    const read = (): void => {
      if (reading) {
        again = true
        return
      }
      reading = true
      host('artifacts.comments', { id })
        .then(
          (next) => {
            if (!live) return
            setThreads(next)
            setError(null)
          },
          (reason: unknown) => {
            if (live) setError(errorMessage(reason))
          },
        )
        .finally(() => {
          reading = false
          if (again && live) {
            again = false
            read()
          }
        })
    }
    read()
    const off = onArtifactEvent((event, hostId) => {
      if (
        (event.type === 'artifacts.comments' || event.type === 'artifacts.version') &&
        event.id === id &&
        hostId === artifactHost(id)
      ) {
        read()
      }
    })
    return () => {
      live = false
      off()
    }
  }, [id, connected])

  return { threads, error }
}
