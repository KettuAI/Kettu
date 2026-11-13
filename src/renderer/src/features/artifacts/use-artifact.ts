import { useEffect, useMemo, useRef, useState } from 'react'
import { ARTIFACT_ENTRY, isHtmlPath } from '@shared/artifact-files'
import { versionUrlPath } from '@shared/artifact-page'
import type { SessionViewer } from '@shared/agent-host'
import {
  CONTENT_MISSING,
  type ArtifactFileInfo,
  type ArtifactSession,
  type ArtifactSummary,
} from '@shared/artifacts'
import { artifactHost, artifactRefOf, errorCode, host } from '@renderer/lib/host'
import { i18n } from '@renderer/lib/i18n'
import {
  artifactListShown,
  markArtifactOpened,
  onArtifactEvent,
  useArtifactsStore,
} from '@renderer/stores/artifacts'
import { openReport } from '@renderer/stores/report'
import { useArtifactHostConnected } from './artifact-host'
import { CANVAS_FILE, parseCanvasDoc, type CanvasDoc } from '@shared/canvas-doc'
import { layoutCanvas, parseCanvas, type CanvasLayout } from './canvas'

/** Why an artifact cannot show; `missing`: the host has its record but not its version's files. */
export type ViewerError = 'notFound' | 'unavailable' | 'failed' | 'previewOnly' | 'missing'

/** The version on screen, its pages found as the format reads them. */
export interface ShownVersion {
  version: number
  title: string
  /** How many files it has. */
  files: number
  /** Laid out when the version marks two or more pages; null for a single page. */
  canvas: CanvasLayout | null
  /** A canvas document's version: the document as stored, which the canvas editor shows. */
  doc: CanvasDoc | null
  /** The version's files, by path. */
  paths: ReadonlySet<string>
  /** Each file's hash, by path; null when the host gives none. */
  sums: ReadonlyMap<string, string> | null
  /** The version each HTML file's frame loads, by path, as `frameVersions` keeps it. */
  loadFrom: ReadonlyMap<string, number>
}

/** The files a version's pages share: all but its HTML files and the canvas document. */
function sharedFiles(sums: ReadonlyMap<string, string>): string {
  return [...sums]
    .filter(([path]) => !isHtmlPath(path) && path !== CANVAS_FILE)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, sum]) => `${path}\0${sum}`)
    .join('\n')
}

/**
 * The version each HTML file's frame loads: the one it loaded before while neither the file nor
 * any file the pages share changed since, so a new version reloads only the pages it changed.
 */
function frameVersions(
  before: ShownVersion | null,
  version: number,
  files: readonly ArtifactFileInfo[],
): Pick<ShownVersion, 'sums' | 'loadFrom'> {
  const sums = files.every((f) => f.hash !== undefined)
    ? new Map(files.map((f) => [f.path, f.hash!]))
    : null
  const prior =
    sums && before?.sums && sharedFiles(sums) === sharedFiles(before.sums) ? before : null
  const loadFrom = new Map<string, number>()
  for (const { path } of files) {
    if (!isHtmlPath(path)) continue
    if (prior && prior.sums?.get(path) === sums?.get(path)) {
      loadFrom.set(path, prior.loadFrom.get(path) ?? prior.version)
    } else loadFrom.set(path, version)
  }
  return { sums, loadFrom }
}

/** The address a frame of the shown version loads `page` from, as `frameVersions` keeps it. */
export function framePageUrl(
  url: string,
  shown: Pick<ShownVersion, 'version' | 'loadFrom'>,
  page?: { group: number; index: number; file?: string | null },
): string {
  return pageUrl(url, shown.loadFrom.get(page?.file ?? ARTIFACT_ENTRY) ?? shown.version, page)
}

/** A canvas document's pages in reading order, for the parts that number them: present, pins. */
function docPages(doc: CanvasDoc): CanvasLayout {
  const pages = doc.pages.map((p, i) => ({
    name: p.name,
    number: i + 1,
    group: 0,
    index: i + 1,
    width: p.width,
    height: p.height,
    x: p.x,
    y: p.y,
    file: p.file,
    id: p.id,
  }))
  return { pages, titles: [], width: 0, height: 0 }
}

export interface Presence {
  viewers: number
  sessions: ArtifactSession[]
  /** The other clients showing it, and the canvas page each one is on. */
  clients: Array<SessionViewer & { page: string | null }>
}

/**
 * An artifact as a viewer or pane shows it: its origin opened for this window, the version on
 * screen (the latest when `version` is null) read and laid out, its record from the lists, and who
 * else shows or changes it.
 */
const OPEN_ERRORS = {
  not_found: 'notFound',
  unavailable: 'unavailable',
  preview_only: 'previewOnly',
} as const satisfies Record<string, ViewerError>

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
  const lastShown = useRef<{ id: string; shown: ShownVersion } | null>(null)
  const connected = useArtifactHostConnected(id)
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
    window.kettu.artifacts.open(artifactRefOf(id)).then(
      (result) => {
        if ('failed' in result) {
          if (live) setOpenError(OPEN_ERRORS[result.failed])
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
      async (read) => {
        if (!live) return
        const paths = new Set(read.files.map((f) => f.path))
        // A canvas document is the entry when there is one.
        let doc: CanvasDoc | null = null
        if (paths.has(CANVAS_FILE)) {
          const { bytes } = await host('artifacts.file', {
            id,
            version: read.version,
            path: CANVAS_FILE,
          })
          try {
            doc = parseCanvasDoc(new TextDecoder().decode(bytes))
          } catch (error) {
            console.error(`The canvas document of ${id} could not be read`, error)
          }
        }
        if (!live) return
        lastRead.current = read.version
        const layout = doc ? docPages(doc) : layoutCanvas(parseCanvas(read.html))
        const before = lastShown.current?.id === id ? lastShown.current.shown : null
        const next: ShownVersion = {
          version: read.version,
          title: read.title,
          files: read.files.length,
          canvas: doc || layout.pages.length >= 2 ? layout : null,
          doc,
          paths,
          ...frameVersions(before, read.version, read.files),
        }
        lastShown.current = { id, shown: next }
        setShown(next)
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
    const off = onArtifactEvent((event, hostId) => {
      if (hostId !== artifactHost(id)) return
      if (event.type === 'artifacts.activity' && event.id === id) {
        setPresence({ viewers: event.viewers, sessions: event.sessions, clients: event.clients })
      } else if (event.type === 'artifacts.version' && event.id === id) {
        setAnnounced((n) => Math.max(n, event.version))
      } else if (event.type === 'artifacts.consentSettled' && event.artifactId === id) {
        // The page stopped waiting before the user allowed it, so it loads again to use it.
        if (event.reload) setReloads((n) => n + 1)
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
            clients: [],
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

/** Whether both lists of the artifact's host are in, so an artifact in neither is gone. */
export function useListsRead(id: string): boolean {
  return useArtifactsStore((s) => {
    const hostId = artifactHost(id)
    if (hostId !== null && !s.hostsRead.includes(hostId)) return false
    return s.list !== null && s.deleted !== null
  })
}

/**
 * A page's frame address: the entry page of one version, and for a canvas one page by the
 * protocol's numbers. `url` is the artifact's origin, or its frame's folder, ending in a slash.
 */
export function pageUrl(
  url: string,
  version: number,
  page?: { group: number; index: number; file?: string | null },
): string {
  if (page?.file) return `${url.slice(0, -1)}${versionUrlPath(version, page.file)}`
  const entry = `${url.slice(0, -1)}${versionUrlPath(version)}`
  return page ? `${entry}?page=${page.group}.${page.index}` : entry
}

function readFailure(reason: unknown): ViewerError {
  const code = errorCode(reason)
  if (code === 'not_found') return 'notFound'
  if ((reason as { data?: { reason?: unknown } } | null)?.data?.reason === CONTENT_MISSING) {
    return 'missing'
  }
  if (code === 'host_restarted' || code === 'host_offline') return 'unavailable'
  console.error('Could not read the artifact', reason)
  return 'failed'
}

/** Opens a problem report about a version of the artifact whose files are missing. */
export function reportMissing(id: string, version: number | null): void {
  const which = version === null ? id : `${id} v${version}`
  void openReport({
    hostId: artifactHost(id),
    context: {
      sessionId: null,
      agentId: null,
      error: `${i18n.t('artifacts:viewer.error.missing')} (${which})`,
    },
  })
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
