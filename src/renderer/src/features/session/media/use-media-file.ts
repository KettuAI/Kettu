import { useContext, useEffect, useState, type RefObject } from 'react'
import type { MediaGrant } from '@shared/media'
import { ProjectPathContext } from '@renderer/features/files/file-refs'
import { errorMessage } from '@renderer/lib/host'
import { openViewer } from '@renderer/stores/viewer'
import { EntryIdContext, openMedia, SessionIdContext } from './grants'
import { NamedMediaContext } from './named'
import { useNearView } from './near-view'
import { fileKey, fileName } from './viewer-items'

export type Shown =
  | { kind: 'asking' }
  | { kind: 'granted'; grant: MediaGrant }
  | { kind: 'text' } // not allowed, or not media: the reference stays as written
  | { kind: 'missing' }
  | { kind: 'unsupported'; grant: MediaGrant }
  | { kind: 'failed'; message: string }

/**
 * A media file a reply names by its path, from the media scheme: what the host answers for it once
 * `near`, the element shown while it asks, comes near the view, and the viewer it opens in.
 * `image` marks a Markdown image, which the blocks of its message then leave out. The caller keys
 * it by path, so a different path starts over.
 */
export function useMediaFile(path: string, image: boolean, near: RefObject<Element | null>) {
  const projectPath = useContext(ProjectPathContext)
  const sessionId = useContext(SessionIdContext)
  const entryId = useContext(EntryIdContext)
  const named = useContext(NamedMediaContext)
  const enabled = !!projectPath && !!sessionId
  const isNear = useNearView(near, enabled)
  const [shown, setShown] = useState<Shown>({ kind: 'asking' })
  // Each retry, and a grant main no longer holds, asks the host again.
  const [asked, setAsked] = useState(0)
  // A file that fails to load is asked for once more, since main may have dropped its grant.
  const [renewed, setRenewed] = useState(false)
  const name = fileName(path)
  const viewerKey = fileKey(entryId ?? '', path)

  useEffect(
    () => (image && enabled && named ? named.image(path) : undefined),
    [image, enabled, named, path],
  )

  useEffect(() => {
    if (!projectPath || !sessionId || !isNear) return
    let current = true
    openMedia(projectPath, path, sessionId, asked > 0).then(
      (result) => {
        if (!current) return
        if (result.kind === 'granted') setShown({ kind: 'granted', grant: result.grant })
        else setShown({ kind: result.kind === 'not_found' ? 'missing' : 'text' })
      },
      (error: unknown) => {
        if (current) setShown({ kind: 'failed', message: errorMessage(error) })
      },
    )
    return () => {
      current = false
    }
  }, [projectPath, sessionId, path, asked, isNear])

  const ask = () => {
    setShown({ kind: 'asking' })
    setAsked((n) => n + 1)
  }
  const retry = () => {
    setRenewed(false)
    ask()
  }
  // A grant main dropped answers 404; a fresh one tells that apart from a bad file.
  const failed = (grant: MediaGrant, message: string | null) => {
    if (!renewed) {
      setRenewed(true)
      ask()
    } else if (message) setShown({ kind: 'failed', message })
    else setShown({ kind: 'unsupported', grant })
  }
  const open = (from: HTMLElement, alt = '') =>
    openViewer({
      sessionId,
      projectPath,
      draft: sessionId,
      item: { key: viewerKey, source: { kind: 'file', path }, name, alt },
      from,
    })

  return { enabled, shown, name, viewerKey, retry, failed, open }
}
