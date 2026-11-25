import { useContext, useEffect, useRef, useState, type RefObject } from 'react'
import type { MediaGrant, MediaOpenResult } from '@shared/media'
import { ProjectPathContext } from '@renderer/features/files/file-refs'
import { errorMessage } from '@renderer/lib/host'
import { openViewer } from '@renderer/stores/viewer'
import { EntryIdContext, openMedia, SessionIdContext } from './grants'
import { bareName, NamedMediaContext, rootFile } from './named'
import { useNearView } from './near-view'
import { fileKey, fileName } from './viewer-items'

export type Shown =
  | { kind: 'asking' }
  | { kind: 'granted'; grant: MediaGrant }
  | { kind: 'text' } // not allowed, not media, or no file where none had to show: as written
  | { kind: 'missing' }
  | { kind: 'unsupported'; grant: MediaGrant }
  | { kind: 'failed'; message: string }

/**
 * Where a reply names a media file: a Markdown image, which the agent wrote to show; its text,
 * inline code or a link, which may only name a file somewhere else; or a tool call, which touched
 * it.
 */
export type MediaOrigin = 'image' | 'text' | 'tool'

/**
 * What the host's answer for a file shows. A file it did not find is missing only for a Markdown
 * image or a tool call's path; one the text names stays as written, as does a tool call's bare
 * name or `/name`, which may name none, as a site's path does.
 */
function shownOf(result: MediaOpenResult, path: string, origin: MediaOrigin): Shown {
  if (result.kind === 'granted') return { kind: 'granted', grant: result.grant }
  if (result.kind !== 'not_found' || origin === 'text') return { kind: 'text' }
  return origin === 'image' || !(bareName(path) || rootFile(path))
    ? { kind: 'missing' }
    : { kind: 'text' }
}

/** Asks the host for a file the thread names, and what its answer shows. */
function askMedia(
  projectPath: string,
  path: string,
  sessionId: string,
  origin: MediaOrigin,
  fresh = false,
): Promise<Shown> {
  return openMedia(projectPath, path, sessionId, fresh).then(
    (result) => shownOf(result, path, origin),
    (error: unknown): Shown => ({ kind: 'failed', message: errorMessage(error) }),
  )
}

/**
 * The host's answers for the media files a block's text names, asked for once the block is
 * `near` the view, by path. A path is asked once; its own `useMediaFile` asks again on Retry.
 */
export function useTextMedia(paths: readonly string[], near: boolean): ReadonlyMap<string, Shown> {
  const projectPath = useContext(ProjectPathContext)
  const sessionId = useContext(SessionIdContext)
  const [answers, setAnswers] = useState<ReadonlyMap<string, Shown>>(() => new Map())
  const asked = useRef(new Set<string>())
  const key = paths.join('\0')
  useEffect(() => {
    if (!near || !projectPath || !sessionId || key === '') return
    for (const path of key.split('\0')) {
      if (asked.current.has(path)) continue
      asked.current.add(path)
      void askMedia(projectPath, path, sessionId, 'text').then((shown) =>
        setAnswers((old) => new Map(old).set(path, shown)),
      )
    }
  }, [near, key, projectPath, sessionId])
  return answers
}

/**
 * A media file a reply names by its path, from the media scheme: what the host answers for it once
 * `near`, the element shown while it asks, comes near the view, and the viewer it opens in. A
 * Markdown image is one the blocks of its message then leave out. `known` is the answer its block
 * already has, which it starts from without asking. The caller keys it by path, so a different
 * path starts over.
 */
export function useMediaFile(
  path: string,
  origin: MediaOrigin,
  near: RefObject<Element | null>,
  known?: Shown,
) {
  const projectPath = useContext(ProjectPathContext)
  const sessionId = useContext(SessionIdContext)
  const entryId = useContext(EntryIdContext)
  const named = useContext(NamedMediaContext)
  const enabled = !!projectPath && !!sessionId
  const image = origin === 'image'
  // A known answer was asked for near the view, so asking again needs no wait.
  const isNear = useNearView(near, enabled && !known) || !!known
  const [shown, setShown] = useState<Shown>(known ?? { kind: 'asking' })
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

  const startsKnown = useRef(!!known)
  useEffect(() => {
    if (!projectPath || !sessionId || !isNear) return
    if (asked === 0 && startsKnown.current) return
    let current = true
    void askMedia(projectPath, path, sessionId, origin, asked > 0).then((next) => {
      if (current) setShown(next)
    })
    return () => {
      current = false
    }
  }, [projectPath, sessionId, path, origin, asked, isNear])

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
