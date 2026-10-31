import { useEffect, useMemo, useRef, useState } from 'react'
import type { ArtifactSession, ArtifactSummary } from '@shared/artifacts'
import { errorCode, host } from '@renderer/lib/host'
import {
  artifactListShown,
  markArtifactOpened,
  useArtifactsStore,
} from '@renderer/stores/artifacts'
import { useConnectionStore } from '@renderer/stores/connection'
import { layoutCanvas, parseCanvas, type CanvasLayout } from './canvas'

export type ViewerError = 'notFound' | 'unavailable' | 'failed'

/** The version on screen, its pages found as the format reads them. */
export interface ShownVersion {
  version: number
  title: string
  /** Laid out when the version marks two or more pages; null for a single page. */
  canvas: CanvasLayout | null
}

export interface Presence {
  viewers: number
  sessions: ArtifactSession[]
}

/**
 * An artifact as a viewer or pane shows it: its origin opened for this window, the version on
 * screen (the latest when `version` is null) read and laid out, its record from the lists, and who
 * else shows or changes it.
 */
export function useArtifact(id: string, version: number | null) {
  const [attempt, setAttempt] = useState(0)
  const [url, setUrl] = useState<string | null>(null)
  const [openError, setOpenError] = useState<ViewerError | null>(null)
  const [shown, setShown] = useState<ShownVersion | null>(null)
  const [readError, setReadError] = useState<ViewerError | null>(null)
  const [presence, setPresence] = useState<Presence | null>(null)
  const [stopped, setStopped] = useState(false)
  const [reloads, setReloads] = useState(0)
  const [announced, setAnnounced] = useState(0)
  const lastRead = useRef<number | null>(null)
  const connected = useConnectionStore((s) => s.agentHost === 'connected')
  const summary = useSummary(id)

  useEffect(() => {
    artifactListShown(true)
    return () => artifactListShown(false)
  }, [])

  // The window may frame the artifact's origin only between open and close, so close waits for
  // the frame to be gone, which it is by the time React runs this cleanup.
  useEffect(() => {
    let live = true
    let opened: string | null = null
    window.kettu.artifacts.open(id).then(
      (result) => {
        if ('failed' in result) {
          if (live) setOpenError(result.failed === 'not_found' ? 'notFound' : 'unavailable')
          return
        }
        opened = result.url
        if (live) {
          setUrl(result.url)
          markArtifactOpened(id)
        } else void window.kettu.artifacts.close(result.url).catch(() => {})
      },
      (reason: unknown) => {
        console.error(`Could not open ${id}`, reason)
        if (live) setOpenError('failed')
      },
    )
    return () => {
      live = false
      if (opened) void window.kettu.artifacts.close(opened).catch(() => {})
    }
  }, [id, attempt])

  // The latest version follows the agent's changes, announced before the lists are read again; an
  // earlier one stays as it is.
  const head = Math.max(summary?.version ?? 0, announced) || null
  const wanted = version ?? head
  useEffect(() => {
    if (!connected) return
    // The lists naming the version just read as the latest is no new version.
    if (version === null && wanted !== null && lastRead.current === wanted) return
    let live = true
    host('artifacts.read', wanted === null ? { id } : { id, version: wanted }).then(
      (read) => {
        if (!live) return
        lastRead.current = read.version
        const rows = parseCanvas(read.html)
        const layout = layoutCanvas(rows)
        setShown({
          version: read.version,
          title: read.title,
          canvas: layout.pages.length >= 2 ? layout : null,
        })
        setReadError(null)
      },
      (reason: unknown) => {
        if (live) setReadError(readFailure(reason))
      },
    )
    return () => {
      live = false
    }
  }, [id, version, wanted, connected, attempt])

  // Watched again after the host restarts, which forgets every watch.
  useEffect(() => {
    if (!connected) return
    void host('artifacts.watch', { id }).catch(() => {})
    const off = window.kettu.agents.onEvent((event) => {
      if (event.type === 'artifacts.activity' && event.id === id) {
        setPresence({ viewers: event.viewers, sessions: event.sessions })
      } else if (event.type === 'artifacts.version' && event.id === id) {
        setAnnounced((n) => Math.max(n, event.version))
      }
    })
    return () => {
      off()
      setPresence(null)
      void host('artifacts.unwatch', { id }).catch(() => {})
    }
  }, [id, connected, attempt])

  useEffect(() => {
    if (!url) return
    const origin = url.slice(0, -1)
    return window.kettu.artifacts.onStopped((event) => {
      if (event.origin === origin) setStopped(true)
    })
  }, [url])

  return {
    url,
    error: openError ?? readError,
    summary,
    shown,
    presence:
      presence ??
      (summary
        ? {
            viewers: 1,
            sessions: summary.editing.map((sessionId) => ({ sessionId, editing: true })),
          }
        : null),
    stopped,
    /** Counts Reload presses, for the frames to load their page again. */
    reloads,
    reload: () => setReloads((n) => n + 1),
    retry: () => {
      setOpenError(null)
      setReadError(null)
      setUrl(null)
      setStopped(false)
      lastRead.current = null
      setAttempt((n) => n + 1)
    },
    /**
     * Shows a stopped page again, in a new frame since the viewer drops the old one while it
     * stopped: Chromium shows a page reloaded into the old frame in the light theme, whatever the
     * app's.
     */
    restart: () => setStopped(false),
  }
}

/** The artifact's record from the lists, or null until they are read, and after it is erased. */
function useSummary(id: string): ArtifactSummary | null {
  const list = useArtifactsStore((s) => s.list)
  const deleted = useArtifactsStore((s) => s.deleted)
  return useMemo(
    () => list?.find((a) => a.id === id) ?? deleted?.find((a) => a.id === id) ?? null,
    [list, deleted, id],
  )
}

/** Whether both lists are in, so an artifact in neither is gone. */
export function useListsRead(): boolean {
  return useArtifactsStore((s) => s.list !== null && s.deleted !== null)
}

/** A page's frame address: one version, and for a canvas one page by the protocol's numbers. */
export function pageUrl(
  url: string,
  version: number,
  page?: { group: number; index: number },
): string {
  return page ? `${url}?v=${version}&page=${page.group}.${page.index}` : `${url}?v=${version}`
}

function readFailure(reason: unknown): ViewerError {
  const code = errorCode(reason)
  if (code === 'not_found') return 'notFound'
  if (code === 'host_restarted') return 'unavailable'
  console.error('Could not read the artifact', reason)
  return 'failed'
}

/**
 * Whether the artifact can show: an error, deleted while it showed (`gone`), or shown from
 * Recently deleted (`inTrash`), which keeps the page under a bar.
 */
export function useArtifactStates(
  artifact: ReturnType<typeof useArtifact>,
  listsRead: boolean,
): { error: ViewerError | null; gone: boolean; inTrash: boolean } {
  const { summary } = artifact
  // Whether it was in Recently deleted when it first showed here, settled once the lists are in.
  const [openedDeleted, setOpenedDeleted] = useState<boolean | null>(null)
  if (openedDeleted === null && summary) setOpenedDeleted(summary.deletedAt !== null)
  const deleted = summary?.deletedAt != null
  return {
    error: artifact.error ?? (listsRead && !summary ? 'notFound' : null),
    gone: deleted && openedDeleted === false,
    inTrash: deleted && openedDeleted === true,
  }
}

/** A canvas page's name by its place in reading order, as the canvas labels it. */
export function canvasPageName(
  shown: ShownVersion,
  numbered: (number: number) => string,
): (index: number) => string {
  return (index) => {
    const page = shown.canvas?.pages[index]
    return page?.name ?? numbered(page?.number ?? index + 1)
  }
}
