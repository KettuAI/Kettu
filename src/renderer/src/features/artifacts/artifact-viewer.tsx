import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowShrink01Icon,
  Delete02Icon,
  MinusSignIcon,
  PlusSignIcon,
  RotateLeft01Icon,
  SidebarLeftIcon,
  ArrowReloadHorizontalIcon,
  LinkSquare02Icon,
  SparklesIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { DOCUMENT_ENTRY } from '@shared/artifact-document-anchors'
import { ARTIFACT_ENTRY } from '@shared/artifact-files'
import { NO_SESSION } from '@shared/artifacts'
import { Icon, type MenuItem } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { AgentCursorStyles } from '@renderer/components/affect/agent-cursors'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { toast } from '@renderer/components/ui/toast'
import { useChanges } from '@renderer/features/session/entries/artifact-changes'
import { usePhoneWindow } from '@renderer/features/shell/narrow'
import { PaneBody } from '@renderer/features/shell/panel-button'
import {
  artifactHost,
  artifactRefOf,
  errorMessage,
  host,
  learnArtifactHost,
} from '@renderer/lib/host'
import { useDark } from '@renderer/hooks/use-dark'
import { useHostHas, useHostHasRecord } from '@renderer/lib/host-features'
import { hostOfPath } from '@renderer/lib/host-paths'
import { longAgo } from '@renderer/lib/format'
import { isWeb } from '@renderer/lib/platform'
import { useNow } from '@renderer/lib/use-now'
import {
  setViewerState,
  useViewerState,
  viewerStateOf,
  type ViewerMode,
} from '@renderer/stores/artifact-viewer'
import { useSaysHostAway } from '@renderer/features/shell/host-notice'
import { setDeckSlide, useDeckSlide } from '@renderer/stores/artifact-deck'
import { unsavedOf } from '@renderer/stores/artifact-unsaved'
import {
  restoreArtifact,
  restoreVersion,
  setPaneSelection,
  useArtifactsStore,
} from '@renderer/stores/artifacts'
import { agentName } from '@renderer/stores/agents'
import { useSessionsStore } from '@renderer/stores/sessions'
import {
  artifactPageShown,
  closeArtifact,
  keepDoc,
  openArtifact,
  MAIN_ARTIFACT_PANEL,
  openSessionWithArtifact,
  useViewStore,
} from '@renderer/stores/view'
import { anchorOf } from './anchors'
import { useArtifactHostConnected, useArtifactHostName, useArtifactShares } from './artifact-host'
import { useArtifactWalk } from '@renderer/stores/artifact-walk'
import { useChangeWalk } from './use-change-walk'
import { ChangePill } from './change-pill'
import { atMaxZoom, atMinZoom } from './camera'
import { CanvasEditor, type CanvasStates } from './canvas-editor'
import { CanvasControls, useCanvasState } from './canvas-controls'
import { changeCount } from './change-words'
import type { PageActions } from './canvas-view'
import { DeckPresent } from './deck-present'
import { DeckSheet } from './deck-sheet'
import { DocumentSheet } from './document-sheet'
import { ArtifactEditor, useEditorState, type EditorMode } from './editor'
import { isEditable, modeKey } from './keys'
import { artifactKind, daysLeft } from './model'
import { mayLeave } from './unsaved'
import { HeldCard } from './edit-panel'
import { handOffPageErrors, handOffRepair } from './page-error-handoff'
import { Waiting } from './page-frame'
import { PageSheet, type SheetAgent } from './page-sheet'
import { PresenceFaces } from './presence-faces'
import { CanvasPresent } from './canvas-present'
import { canvasSheets } from './canvas-sheets'
import { PreviewOnly } from './preview-only'
import {
  canvasPageName,
  reportMissing,
  useArtifact,
  useArtifactStates,
  useListsRead,
} from './use-artifact'
import { useComments } from './use-comments'
import { useDeck } from './use-deck'
import { staticCanvas, useCanvasDoc } from './use-canvas-doc'
import { clampSize, useDocActions } from './use-doc-actions'
import {
  noteAuthor,
  usePresentAgents,
  useVisitors,
  useWriter,
  type Writer,
} from './use-present-agents'
import { useVersions } from './use-versions'
import { canvasContent, useViewerTools, type ToolContent } from './viewer-tools'
import { ViewerBar, type BarPage } from './viewer-bar'
import { ArtifactSurface, ViewerEmpty } from './viewer-parts'
import { ArtifactShell, DockButton, DockRule, ViewerSlot, type RightContent } from './viewer-shell'
import { useShell } from './viewer-shell-context'
import { SkeletonRows, StageNote } from './viewer-states'
import './viewer.css'

/** Where the viewer shows: the main area, or a session's side panel beside its thread. */
export type ViewerPlace =
  | { where: 'main'; id: string; history?: boolean }
  | { where: 'panel'; id: string; panel: string; projectPath: string; maximized: boolean }

/** The editor's mode for the viewer's: View leaves a page live, Edit picks what to change. */
function editorMode(mode: ViewerMode): EditorMode {
  return mode === 'comment' ? 'comment' : mode === 'edit' ? 'select' : null
}

/**
 * An artifact, live, away from the app and the machine, in its one viewer: the same component in
 * the main area and in a session's side panel, for every kind, laid out by its own width.
 */
export default function ArtifactViewer(place: ViewerPlace) {
  const { id } = place
  const { t } = useTranslation(['artifacts', 'common'])
  const panel = place.where === 'panel' ? place : null
  const phone = usePhoneWindow()
  // A session's panel shows the artifacts of the host it runs on.
  const onHost = panel ? hostOfPath(panel.projectPath) : null
  if (onHost !== null) learnArtifactHost(id, onHost)

  const opened = useRef(place.where === 'main' && place.history === true)
  useEffect(() => {
    if (opened.current) setViewerState(id, { right: 'history' })
    opened.current = false
  }, [id])

  const state = useViewerState(id, (s) => s)
  const picked = state.version
  // What is presented, from: a document's frame by its id, or a page's place as a string.
  const [presenting, setPresenting] = useState<string | null>(null)
  const frame = useRef<HTMLDivElement>(null)
  const area = useRef<HTMLDivElement>(null)
  const [since] = useState(() => performance.now())
  const artifact = useArtifact(id, picked)
  const listsRead = useListsRead(id)
  const controls = useMemo(() => new CanvasControls(), [])
  const canvasState = useCanvasState(controls)
  const { summary, shown, url } = artifact
  const head = summary?.version ?? null
  const { versions, error: versionsError } = useVersions(id, head)
  const states = useArtifactStates(artifact, listsRead)
  // Offline: the computer the artifact is kept on, another host or this one's agent host.
  const offline = !useArtifactHostConnected(id)
  const hostName = useArtifactHostName(id)
  const earlier = picked !== null && head !== null && picked < head ? picked : null
  const title = summary?.title ?? shown?.title ?? ''
  const kind = summary ? artifactKind(summary) : null
  // A web page: one page of its own, neither a canvas nor a typed document or deck.
  const webPage = !!shown && !shown.canvas && !summary?.type
  const isDocument = !!shown && summary?.type === 'document'
  const isDeck = !!shown && summary?.type === 'slides'
  const deck = useDeck(id, isDeck && shown ? shown.version : null)
  const deckSlide = useDeckSlide(id)
  // An agent's newest version, which what it changed compares with the version before: a frame,
  // the web page, a slide.
  const lastWrite = versions?.[0] ?? null
  const agentWrite =
    lastWrite && lastWrite.author !== null && lastWrite.version > 1 && lastWrite.version === head
      ? { before: lastWrite.version - 1, after: lastWrite.version }
      : null
  // While the pill counts a range, before and after compares the same versions.
  const walkRange = useArtifactWalk((s) => s.ranges[id] ?? null)
  const compareRange =
    walkRange && walkRange.to === head
      ? { before: walkRange.from, after: walkRange.to }
      : agentWrite
  const pageChanges = useChanges(
    id,
    compareRange?.before ?? null,
    compareRange?.after ?? null,
    (webPage || isDeck || !!shown?.canvas) && compareRange !== null,
  )
  // A web page compares when the agent changed it at all, a deck when it changed the slide shown.
  const pageCompare =
    compareRange && pageChanges && changeCount(pageChanges).count > 0
      ? webPage ||
        (isDeck &&
          pageChanges.kind === 'slides' &&
          pageChanges.slides.some((s) => s.number === deckSlide))
        ? compareRange
        : null
      : null
  const comparing = pageCompare !== null && earlier === pageCompare.before
  // The slide "before" was asked on: turning to another goes back to the latest, as leaving a
  // compared frame does.
  const comparedSlide = useRef<number | null>(null)
  useEffect(() => {
    if (comparedSlide.current === null || comparedSlide.current === deckSlide) return
    comparedSlide.current = null
    setViewerState(id, { version: null })
  }, [id, deckSlide])
  // Publishing takes the account the host keeps, which the daemon has none of.
  const shares = useArtifactShares(id)
  // Only a desktop host renders a page apart from the window.
  const renders = useHostHas('thumbnails') === true
  const editor = useMemo(() => (url ? new ArtifactEditor(url.slice(0, -1)) : null), [url])
  useEffect(() => () => editor?.dispose(), [editor])
  // A change that did not save before the viewer was left shows again where it was made.
  useEffect(() => {
    const kept = unsavedOf(id)
    if (kept.length === 0) return
    const params = kept.find((change) => change.kind === 'params')
    if (params?.kind === 'params')
      setViewerState(id, { right: 'tweaks', selection: [params.frame] })
    if (kept.some((change) => change.kind !== 'params')) setViewerState(id, { mode: 'edit' })
    const element = kept.find((change) => change.kind === 'element')
    if (editor && element?.kind === 'element') editor.repick(element.page, element.src)
  }, [id, editor])
  // Pins and the picked outline take the theme's colors, again when the color mode changes.
  const dark = useDark()
  useEffect(() => editor?.restyle(), [editor, dark])
  const editing = useEditorState(editor)
  const { threads, error: commentsError } = useComments(id)
  // A version just written counts as the latest while it loads, so editing goes on across it.
  const latest = !!shown && earlier === null && !states.inTrash && !states.gone
  const pageAsked = useViewStore((s) => {
    const asked = s.sideArtifactPage[panel?.panel ?? MAIN_ARTIFACT_PANEL]
    return asked?.artifactId === id ? asked : null
  })
  // What changed, walked by the one pill every kind shares, and where the viewer lands.
  const changeWalk = useChangeWalk({
    id,
    panel: panel?.panel ?? MAIN_ARTIFACT_PANEL,
    summary: summary ?? null,
    versions,
    ready: !!shown && (latest || comparing) && !states.error,
    positioned: pageAsked !== null,
    latest: !states.inTrash && (earlier === null || comparing),
  })
  const walk = changeWalk.walk
  const walkAsk = changeWalk.ask
  const sheetWalk = useMemo(
    () =>
      walk
        ? {
            from: walk.range.from,
            to: walk.range.to,
            changes: walk.changes,
            at: walk.at,
            marks: walk.marks,
          }
        : null,
    [walk],
  )
  const [docChangesShown, setDocChangesShown] = useState(false)
  const doneAsk = changeWalk.done
  const askShown = useCallback(
    (seq: number) => {
      if (seq < 0) doneAsk(seq)
      else artifactPageShown(panel?.panel ?? MAIN_ARTIFACT_PANEL, seq)
    },
    [doneAsk, panel?.panel],
  )
  // Comment and Edit act on the latest version only; elsewhere the viewer only shows. Edit pauses
  // while the computer is away, and comes back on its own when it returns.
  const mode: ViewerMode = !latest
    ? 'view'
    : offline && state.mode === 'edit'
      ? 'comment'
      : state.mode
  // Commenting on it or editing it keeps its tab, which a preview would give up to the next click.
  const besidePanel = panel?.panel ?? null
  useEffect(() => {
    if (besidePanel && mode !== 'view') keepDoc(besidePanel, `artifact:${id}`)
  }, [besidePanel, mode, id])
  // A canvas document: the latest is edited live on the host, an earlier one only shown.
  const docShown = shown?.doc ?? null
  const legacyCanvas = !!shown?.canvas && !docShown
  const liveCanvas = useCanvasDoc(id, latest && (!!docShown || legacyCanvas))
  const shownCanvas = useMemo(
    () => (latest || !docShown ? liveCanvas : staticCanvas(docShown)),
    [latest, docShown, liveCanvas],
  )
  const doc = shownCanvas.doc
  const [following, setFollowing] = useState<string | null>(null)
  const agents = usePresentAgents(artifact.presence, summary?.deletedAt != null)
  const writer = useWriter(artifact.presence, summary?.deletedAt != null)
  const visitors = useVisitors(id)
  const followingNow = following && agents.some((a) => a.sessionId === following) ? following : null
  // Deleted while it shows, it stays on screen, dimmed, until it is restored or left.
  const showing = !!(url && shown) && !states.error && !artifact.stopped

  // The canvas document sets the editor's mode itself, as a frame it enters is picked in.
  useEffect(() => {
    if (!editor || docShown) return
    editor.setMode(editorMode(mode))
  }, [editor, mode, docShown])

  // A document lays out its own pins beside its blocks, on a host that anchors threads on them.
  const docBlocks = useHostHasRecord('documentSheet') === true
  const [docHeadings, setDocHeadings] = useState(0)
  const [docFocus, setDocFocus] = useState<{ thread: string; seq: number } | null>(null)

  // What is picked beside a session is the context its composer offers, until something else is.
  const projectPath = panel?.projectPath ?? null
  useEffect(() => {
    if (!projectPath || editing.mode !== 'select' || !editing.picked || !shown) return
    setPaneSelection({
      projectPath,
      artifactId: id,
      title,
      anchor: anchorOf(editing.picked, shown),
    })
  }, [projectPath, editing.mode, editing.picked, shown, id, title])
  const choosePage = useCallback(
    (index: number) => {
      const page = shown?.canvas?.pages[index]
      if (!projectPath || !page || !shown) return
      setPaneSelection({
        projectPath,
        artifactId: id,
        title,
        anchor: {
          version: shown.version,
          path: ARTIFACT_ENTRY,
          page: { number: page.number, name: page.name },
          offset: null,
          tag: null,
          text: '',
          missing: false,
        },
      })
    },
    [shown, projectPath, id, title],
  )
  useEffect(
    () => () => {
      if (projectPath && useArtifactsStore.getState().paneSelection?.artifactId === id) {
        setPaneSelection(null)
      }
    },
    [id, projectPath],
  )

  const pageName = useMemo(
    () => (shown?.canvas ? canvasPageName(shown, (number) => t('canvas.page', { number })) : null),
    [shown, t],
  )

  const downloadPng = useCallback(
    (index: number | null) => {
      if (!shown) return
      const page = index === null ? null : (shown.canvas?.pages[index] ?? null)
      const rect = area.current?.getBoundingClientRect()
      const size = page
        ? clampSize(page.width, page.height)
        : clampSize(rect?.width ?? 1280, rect?.height ?? 800)
      const name = page && pageName ? `${title} - ${pageName(index!)}` : title
      window.kettu.artifacts
        .png(
          artifactRefOf(id),
          shown.version,
          page ? { group: page.group, index: page.index } : null,
          size,
          name,
        )
        .catch((error: unknown) =>
          toast(t('canvas.pngFailed', { error: errorMessage(error) }), undefined, {
            tone: 'warning',
          }),
        )
    },
    [shown, id, title, pageName, t],
  )
  const actions = useMemo<PageActions>(
    () => ({
      download: renders ? downloadPng : null,
      present: (index) => setPresenting(String(index)),
    }),
    [renders, downloadPng],
  )
  const docActions = useDocActions({
    id,
    title,
    shown: shown ?? null,
    doc,
    summary: summary ?? null,
    agents,
    present: setPresenting,
  })
  // Which frames count as changed: those the pill walks, else those the agent's last write changed.
  const frameChanges = walk?.changes ?? pageChanges
  const changedFrames = useMemo<ReadonlySet<string>>(
    () => new Set(frameChanges?.kind === 'frames' ? frameChanges.frames.map((f) => f.id) : []),
    [frameChanges],
  )
  const frameComments = useMemo(() => {
    const out = new Map<string, number>()
    if (!doc || !threads) return out
    for (const thread of threads) {
      if (thread.resolvedAt !== null) continue
      for (const page of doc.pages) {
        if (page.file === thread.anchor.path) out.set(page.id, (out.get(page.id) ?? 0) + 1)
      }
    }
    return out
  }, [doc, threads])

  const content = useMemo<ToolContent>(
    () =>
      shown?.canvas
        ? canvasContent({
            id,
            doc,
            shown,
            panel: panel?.panel ?? MAIN_ARTIFACT_PANEL,
            editor,
            focusLegacy: (index) => controls.commands?.focus(index),
          })
        : isDocument || isDeck
          ? {
              reveal: (_anchor, thread) => {
                if (thread) setDocFocus((was) => ({ thread, seq: (was?.seq ?? 0) + 1 }))
              },
            }
          : { reveal: (anchor) => anchor.offset !== null && editor?.reveal(null, anchor.offset) },
    [id, doc, shown, panel?.panel, editor, controls, isDocument, isDeck],
  )
  const tools = useViewerTools({
    id,
    title,
    summary: summary ?? null,
    shown: shown ?? null,
    head,
    latest,
    editable: states.inTrash || states.gone ? 'deleted' : earlier !== null ? 'earlier' : 'yes',
    mode,
    right: state.right,
    picked,
    editor,
    editing,
    threads,
    commentsError,
    versions,
    versionsError,
    presence: artifact.presence ?? null,
    doc,
    page: state.page,
    beside: panel && projectPath ? { panel: panel.panel, projectPath } : null,
    content,
    area,
    root: frame,
  })
  // The frame bar's and the sheets' Ask open the tools' Ask, beside what it is about or above the
  // composer; read when pressed, so what holds them is not made again on every render.
  const toolsNow = useRef(tools)
  useEffect(() => {
    toolsNow.current = tools
  })
  const canvasActions = useMemo<typeof docActions>(
    () => ({ ...docActions, handOff: (ids) => toolsNow.current.askFrames(ids) }),
    [docActions],
  )
  const compareBefore = compareRange?.before ?? null
  const compareAfter = compareRange?.after ?? null
  const compare = useMemo(
    () =>
      latest && compareBefore !== null && compareAfter !== null
        ? { before: compareBefore, after: compareAfter }
        : null,
    [latest, compareBefore, compareAfter],
  )
  // Edit on a document section or a slide an agent is writing: the card says it is locked, until
  // closed for this writer.
  const [heldClosed, setHeldClosed] = useState<string | null>(null)
  const heldPiece = writer?.pieces?.find(
    (p) => p.kind === 'section' || (p.kind === 'slide' && p.number === deckSlide),
  )
  const heldShown =
    mode === 'edit' &&
    !!writer &&
    (isDocument || isDeck) &&
    !!heldPiece &&
    heldClosed !== writer.sessionId
  const heldRight: RightContent | null =
    heldShown && writer && heldPiece
      ? {
          key: `held:${writer.sessionId}`,
          body: (
            <HeldCard
              heldBy={{
                sessionId: writer.sessionId,
                piece: heldPiece.kind === 'slide' ? 'slide' : 'section',
                agent: {
                  name: writer.name,
                  id: writer.agentId,
                  hostId: writer.hostId,
                },
              }}
              onOpenSession={(sessionId) => {
                const session = useSessionsStore.getState().byId[sessionId]
                if (session) openSessionWithArtifact(session.id, session.projectPath, id)
              }}
            />
          ),
          onClose: () => setHeldClosed(writer.sessionId),
        }
      : null
  const right: RightContent | null =
    tools.right ??
    heldRight ??
    (state.right === 'tweaks' && docShown
      ? { key: 'tweaks', body: null, onClose: () => setViewerState(id, { right: null }) }
      : null)
  const rightKey = right?.key ?? null

  const setMode = useCallback(
    (next: ViewerMode) => {
      tools.leftComment(next)
      setViewerState(id, (s) => ({
        mode: next,
        // Comment opens the comments, and leaving it puts them away.
        right: next === 'comment' ? 'comments' : s.right === 'comments' ? null : s.right,
      }))
    },
    [id, tools],
  )
  // Read when called, from a key or the Outline opening in its place.
  const rightNow = useRef(right)
  useEffect(() => {
    rightNow.current = right
  })
  const closeRight = useCallback(() => {
    if (mayLeave(id)) rightNow.current?.onClose()
  }, [id])
  const toggleHistory = () =>
    setViewerState(id, (s) =>
      s.right === 'history' ? { right: null, version: null } : { right: 'history' },
    )

  const maximized = panel?.maximized ?? false
  const setMaximized = (on: boolean) => useViewStore.setState({ sidePaneMaximized: on })

  // Esc goes back one layer at a time: the pick, the opened frame or the selection, the right
  // card, then the expanded panel. It never closes the side panel or leaves the viewer.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || isEditable(event.target)) return
      const root = frame.current
      const active = document.activeElement
      const mine =
        !!root &&
        (root.contains(active) || (place.where === 'main' && (!active || active === document.body)))
      if (!mine) return
      const key = modeKey(event)
      if (key) {
        if (!latest || (key !== 'view' && !summary)) return
        event.preventDefault()
        setMode(key)
        return
      }
      // Enter types the picked element's text in place.
      if (event.key === 'Enter' && mode === 'edit' && editor?.get().picked?.selection.textOnly) {
        event.preventDefault()
        editor.textEdit(true)
        return
      }
      if (event.key !== 'Escape') return
      const now = viewerStateOf(id)
      if (tools.escape()) {
        // A popover closed.
      } else if (editor?.escape()) {
        // The pick let go of.
      } else if (now.opened !== null) setViewerState(id, { opened: null })
      else if (now.selection.length > 0) setViewerState(id, { selection: [] })
      else if (rightKey) closeRight()
      else if (panel && maximized && !phone) setMaximized(false)
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    editor,
    latest,
    summary,
    setMode,
    id,
    rightKey,
    closeRight,
    panel,
    maximized,
    phone,
    place.where,
    tools,
    mode,
  ])

  // One restore at a time: a second click would restore over the version the first one wrote.
  const [restoring, setRestoring] = useState(false)
  const restore = (run: () => Promise<unknown>): void => {
    if (restoring) return
    setRestoring(true)
    run()
      .catch((error: unknown) => toast(errorMessage(error), undefined, { tone: 'warning' }))
      .finally(() => setRestoring(false))
  }

  // The pill at the content's top, one at a time and in this order for every kind: the computer
  // offline, the artifact deleted while it shows, an earlier version picked in History, Recently
  // deleted, an agent writing it, an old canvas, then what changed, which stays while the
  // before-and-after switch shows the version before, since it says what that compares.
  let pill: React.ReactNode = null
  const changePill =
    walk && !walk.dismissed ? (
      <ChangePill
        walk={{
          ...walk,
          dismiss: () => {
            if (comparing) setViewerState(id, { version: null })
            walk.dismiss()
          },
        }}
        label={
          isDocument && docChangesShown
            ? t(phone ? 'doc.changesFrom' : 'doc.showingFrom', { version: walk.range.from })
            : undefined
        }
        onStep={(direction) => changeWalk.step(direction, state.opened !== null)}
      />
    ) : null
  const remoteHost = artifactHost(id)
  // The pill says the agent host is away, so the window's notice leaves the bar alone.
  useSaysHostAway(offline && !states.error && remoteHost === null)
  if (offline && !states.error) {
    pill = (
      <Pill
        lead={hostName ? t('viewer.offline.named', { host: hostName }) : t('viewer.offline.local')}
        rest={<span>{t('viewer.offline.reconnecting')}</span>}
        keepRest
        mark={<span aria-hidden className="k-vs-pulse" />}
        actions={
          remoteHost !== null && !isWeb
            ? [
                {
                  label: t('viewer.offline.retryNow'),
                  quiet: true,
                  run: () =>
                    void window.kettu.hosts
                      .reconnect(remoteHost)
                      .catch((error: unknown) =>
                        console.error(`Could not reach ${remoteHost}`, error),
                      ),
                },
              ]
            : []
        }
      />
    )
  } else if (states.gone && summary?.deletedAt != null) {
    pill = (
      <Pill
        lead={t('viewer.deletedLead')}
        rest={<DeletedAgo deletedAt={summary.deletedAt} />}
        mark={
          <span aria-hidden className="avs-pill__icon">
            <Icon icon={Delete02Icon} size={15} />
          </span>
        }
        actions={[
          {
            label: t('menu.restore'),
            busy: restoring,
            run: () => restore(() => restoreArtifact(id)),
          },
        ]}
      />
    )
  } else if (shown && earlier !== null && head !== null && !comparing) {
    const record = versions?.find((v) => v.version === earlier)
    pill = (
      <Pill
        lead={t('viewer.earlierLead', { version: earlier, head })}
        rest={record ? <EarlierRest createdAt={record.createdAt} note={record.note} /> : null}
        actions={[
          {
            label: t('viewer.restoreVersion'),
            busy: restoring,
            restores: true,
            run: () =>
              restore(async () => {
                // No dialog: the version is written as the newest, which Undo takes back.
                const { version: made } = await host('artifacts.restoreVersion', {
                  id,
                  version: earlier,
                  baseVersion: head,
                })
                setViewerState(id, { version: null })
                toast(
                  t('history.restored', { version: earlier, made }),
                  {
                    label: t('edit.undo'),
                    onClick: () =>
                      void restoreVersion(id, head, made).catch((error: unknown) =>
                        toast(errorMessage(error), undefined, { tone: 'warning' }),
                      ),
                  },
                  { tone: 'success' },
                )
              }),
          },
          { label: t('viewer.backToLatest'), run: () => setViewerState(id, { version: null }) },
        ]}
      />
    )
  } else if (states.inTrash && summary?.deletedAt != null) {
    pill = (
      <Pill
        lead={t('viewer.inTrash')}
        rest={<DaysLeft deletedAt={summary.deletedAt} />}
        actions={[
          {
            label: t('menu.restore'),
            busy: restoring,
            restores: true,
            run: () => restore(() => restoreArtifact(id)),
          },
        ]}
      />
    )
  } else if (writer && latest && head !== null) {
    pill = (
      <Pill
        lead={writingLead(t, writer, head, doc?.pages ?? null)}
        rest={null}
        mark={<span aria-hidden className="k-vs-pulse" data-tone="writing" />}
        actions={
          panel?.panel === writer.sessionId
            ? []
            : [
                {
                  label: t('viewer.writing.openSession'),
                  quiet: true,
                  run: () => {
                    const session = useSessionsStore.getState().byId[writer.sessionId]
                    if (session) openSessionWithArtifact(session.id, session.projectPath, id)
                  },
                },
              ]
        }
      />
    )
  } else if (showing && latest && legacyCanvas && liveCanvas.legacy) {
    pill = (
      <Pill
        lead={t('board.legacy')}
        rest={null}
        actions={[
          {
            label: t('board.legacySplit'),
            run: () =>
              liveCanvas.start([{ op: 'set', id: 'canvas-1', key: 'name', value: 'Canvas 1' }]),
          },
        ]}
      />
    )
  } else if (changePill) {
    pill = changePill
  }

  // Chat opens the session writing it, or the one that wrote it last, with it beside the thread.
  const sessionId =
    artifact.presence?.sessions.find((s) => s.editing)?.sessionId ??
    (summary && summary.sessionId !== NO_SESSION ? summary.sessionId : null)
  const chatSession = useSessionsStore((s) => (sessionId ? (s.byId[sessionId] ?? null) : null))

  // A web page asks, and hands its errors to, the session it sits beside, or else the chat's.
  const besideSession = useSessionsStore((s) => (panel ? (s.byId[panel.panel] ?? null) : null))
  const target = besideSession ?? chatSession
  const sheetAgent = useMemo<SheetAgent | null>(() => {
    if (!target || !summary || !shown) return null
    const hostId = hostOfPath(target.projectPath)
    return {
      name: agentName(target.agentId, hostId),
      mark: <AgentMark agent={target.agentId} size={14} hostId={hostId} />,
      ask: () => toolsNow.current.askWhole(),
      fixErrors: (pages) =>
        handOffPageErrors({
          artifact: { id, title, version: shown.version, project: summary.project },
          pages,
          session: target.id,
        }),
    }
  }, [target, summary, shown, id, title])
  const targetName = target ? agentName(target.agentId, hostOfPath(target.projectPath)) : ''
  const repair = useCallback(
    (file: string | null, reason: string) => {
      if (!summary || !shown) return
      void handOffRepair({
        artifact: { id, title, version: shown.version, project: summary.project },
        file,
        reason,
        session: target?.id ?? null,
      })
        .then((sent) => {
          if (sent) toast(t('viewer.repairSent', { agent: targetName }))
        })
        .catch((error: unknown) => toast(errorMessage(error), undefined, { tone: 'warning' }))
    },
    [summary, shown, id, title, target, targetName, t],
  )
  const writerMark = writer ? (
    <AgentMark agent={writer.agentId} size={13} hostId={writer.hostId} mono dot={null} />
  ) : null
  // What a document or a deck marks while an agent writes it; a piece of another kind holds all.
  const writerName = writer && latest ? writer.name : null
  const writerPieces = writer?.pieces ?? null
  const docWriting = useMemo(() => {
    if (writerName === null) return null
    const section = writerPieces?.find((p) => p.kind === 'section')
    return {
      section: section?.kind === 'section' ? section.slug : null,
      tag: t('viewer.writing.tag', { agent: writerName }),
    }
  }, [writerName, writerPieces, t])
  const deckWriting = useMemo(() => {
    if (writerName === null) return null
    const slides = (writerPieces ?? []).flatMap((p) => (p.kind === 'slide' ? [p.number] : []))
    return slides.length ? slides : null
  }, [writerName, writerPieces])
  const waitingFor = offline
    ? hostName
      ? t('viewer.offline.waiting', { host: hostName })
      : t('viewer.offline.waitingLocal')
    : null
  const hasDoc = !!docShown
  const askWhole = useCallback(() => toolsNow.current.askWhole(), [])
  const canvasStates = useMemo<CanvasStates | null>(() => {
    if (!hasDoc) return null
    const mark = writer ? (
      <AgentMark agent={writer.agentId} size={13} hostId={writer.hostId} mono dot={null} />
    ) : null
    return {
      held: new Map(
        writer && latest && mark
          ? (writer.pieces ?? []).flatMap((piece) =>
              piece.kind === 'frame' ? [[piece.id, { name: writer.name, mark }] as const] : [],
            )
          : [],
      ),
      waitingFor,
      ask:
        target && summary
          ? {
              agent: targetName,
              mark: (
                <AgentMark
                  agent={target.agentId}
                  size={14}
                  hostId={hostOfPath(target.projectPath)}
                />
              ),
              whole: askWhole,
              repair,
            }
          : null,
    }
  }, [hasDoc, writer, latest, waitingFor, target, summary, targetName, askWhole, repair])

  let body: React.ReactNode
  let layout: 'float' | 'beside' = 'beside'
  let ground: 'dots' | 'plain' = 'plain'
  if (states.error === 'previewOnly') {
    body = <PreviewOnly id={id} title={title} summary={summary ?? null} />
  } else if (states.error) {
    if (kind === 'canvas' || kind === 'slides') ground = 'dots'
    // The shell stays: the kind's sketch, why, Retry or what else may open, and the agent's repair.
    const missing = states.error === 'missing'
    const shownNumber = picked ?? head
    const previous = shownNumber !== null && shownNumber > 1 ? shownNumber - 1 : null
    const reason = t(`viewer.error.${states.error}`)
    body = (
      <StageNote
        kind={kind}
        danger
        title={kind ? t(`viewer.failed.${kind}`) : t('viewer.errorTitle')}
        text={missing ? t('viewer.error.missing') : reason}
        quiet={
          summary && target && states.error !== 'notFound' ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                void handOffRepair({
                  artifact: {
                    id,
                    title,
                    version: shownNumber ?? summary.version,
                    project: summary.project,
                  },
                  file: null,
                  reason,
                  session: target.id,
                })
                  .then((sent) => {
                    if (sent) toast(t('viewer.repairSent', { agent: targetName }))
                  })
                  .catch((error: unknown) =>
                    toast(errorMessage(error), undefined, { tone: 'warning' }),
                  )
              }
            >
              {t('viewer.repair', { agent: targetName })}
            </Button>
          ) : null
        }
      >
        {missing ? (
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setViewerState(id, { right: 'history' })}
            >
              {t('menu.versionHistory')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => reportMissing(id, picked)}>
              {t('viewer.reportProblem')}
            </Button>
          </>
        ) : (
          states.error !== 'notFound' && (
            <Button size="sm" onClick={artifact.retry}>
              {t('viewer.retry')}
            </Button>
          )
        )}
        {previous !== null && states.error !== 'notFound' && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              artifact.retry()
              setViewerState(id, { version: previous })
            }}
          >
            {t('viewer.openVersion', { version: previous })}
          </Button>
        )}
      </StageNote>
    )
  } else if (artifact.stopped && !(url && webPage)) {
    body = (
      <ViewerEmpty title={t('viewer.stoppedTitle')} text={t('viewer.stoppedDescription')}>
        <Button variant="secondary" size="sm" onClick={artifact.restart}>
          {t('viewer.reload')}
        </Button>
      </ViewerEmpty>
    )
  } else if (url && shown) {
    const typed = !!summary?.type
    // A canvas document draws its own dots, which follow its camera.
    if (docShown) layout = 'float'
    else if (shown.canvas || isDeck) {
      layout = 'float'
      ground = 'dots'
    }
    body = (
      <>
        {docShown ? (
          <CanvasEditor
            artifactId={id}
            url={url}
            version={shown.version}
            loadFrom={shown.loadFrom}
            title={title}
            canvas={shownCanvas}
            files={shown.paths}
            readOnly={!latest}
            mode={mode}
            controls={controls}
            editor={latest ? (editor ?? undefined) : undefined}
            actions={canvasActions}
            agents={latest ? agents : []}
            following={followingNow}
            onFollowDone={() => setFollowing(null)}
            onViewPage={(page) => void host('artifacts.view', { id, page }).catch(() => {})}
            sessionName={(session) => noteAuthor(agents, session, t('board.note.agent'))}
            reloads={artifact.reloads}
            show={
              walkAsk?.frame
                ? {
                    pageId: walkAsk.frame,
                    seq: walkAsk.seq,
                    open: walkAsk.open,
                    flash: walkAsk.flash,
                  }
                : pageAsked
            }
            onShown={askShown}
            pill={pill !== null}
            changed={changedFrames}
            marks={walk?.marks}
            comments={frameComments}
            compare={compare}
            states={canvasStates}
          />
        ) : shown.canvas ? (
          <ArtifactSurface
            url={url}
            shown={shown}
            title={title}
            reloads={artifact.reloads}
            since={since}
            controls={controls}
            top={pill ? PILL_ROOM : 0}
            bottom={DOCK_ROOM}
            editor={latest ? (editor ?? undefined) : undefined}
            actions={actions}
            onPageChosen={choosePage}
          />
        ) : isDeck ? (
          <DeckSheet
            id={id}
            url={url}
            shown={shown}
            title={title}
            reloads={artifact.reloads}
            since={since}
            band={pill !== null}
            latest={latest}
            mode={mode}
            where={place.where}
            deck={deck ?? null}
            walk={sheetWalk}
            comments={{
              threads,
              shown: latest && (state.right === 'comments' || mode === 'comment'),
              draft: tools.docDraft,
              thread: tools.docThread,
            }}
            agent={sheetAgent}
            onAsk={(anchor) => toolsNow.current.askAnchor(anchor, null)}
            onPresent={(slide) => setPresenting(String(slide))}
            asked={walkAsk?.slide !== undefined ? walkAsk : pageAsked}
            onAsked={askShown}
            focusThread={docFocus}
            writing={
              writerName !== null && writerMark
                ? { slides: deckWriting, name: writerName, mark: writerMark }
                : null
            }
            compare={
              pageCompare && (earlier === null || comparing)
                ? {
                    from: pageCompare.before,
                    to: pageCompare.after,
                    showingBefore: comparing,
                    onChange: (before) => {
                      comparedSlide.current = before ? deckSlide : null
                      setViewerState(id, { version: before ? pageCompare.before : null })
                    },
                  }
                : null
            }
          />
        ) : isDocument ? (
          <DocumentSheet
            id={id}
            url={url}
            shown={shown}
            title={title}
            reloads={artifact.reloads}
            since={since}
            band={pill !== null}
            latest={latest}
            mode={mode}
            onMode={setMode}
            walk={sheetWalk}
            asked={walkAsk?.at !== undefined || walkAsk?.section !== undefined ? walkAsk : null}
            onAsked={askShown}
            onChangesShown={setDocChangesShown}
            comments={{
              threads,
              shown: latest && (state.right === 'comments' || mode === 'comment'),
              blocks: docBlocks,
              draft: tools.docDraft,
              thread: tools.docThread,
            }}
            agent={sheetAgent}
            onAsk={(anchor, at) =>
              toolsNow.current.askAnchor(anchor, at, docBlocks ? DOCUMENT_ENTRY : ARTIFACT_ENTRY)
            }
            onHeadings={setDocHeadings}
            focusThread={docFocus}
            writing={docWriting}
          />
        ) : typed ? (
          <div className="avs-paper avs-paper--typed">
            <ArtifactSurface
              url={url}
              shown={shown}
              title={title}
              reloads={artifact.reloads}
              since={since}
              controls={controls}
              top={0}
              editor={latest ? (editor ?? undefined) : undefined}
            />
          </div>
        ) : (
          <PageSheet
            id={id}
            url={url}
            shown={shown}
            title={title}
            reloads={artifact.reloads}
            since={since}
            editor={latest ? (editor ?? undefined) : undefined}
            band={pill !== null || comparing}
            before={earlier}
            stopped={artifact.stopped}
            onRestart={artifact.restart}
            onReload={artifact.reload}
            onBrowser={
              isWeb
                ? null
                : () =>
                    void window.kettu.artifacts
                      .openExternal(artifactRefOf(id), shown.version)
                      .catch((error: unknown) => console.error(`Could not open ${id}`, error))
            }
            compare={
              pageCompare && (earlier === null || comparing)
                ? {
                    from: pageCompare.before,
                    to: pageCompare.after,
                    showingBefore: comparing,
                    onChange: (before) =>
                      setViewerState(id, { version: before ? pageCompare.before : null }),
                  }
                : null
            }
            agent={sheetAgent}
            writer={writer && latest && writerMark ? { name: writer.name, mark: writerMark } : null}
          />
        )}
        {legacyCanvas && pageName && <LegacyCanvasDock controls={controls} />}
        {/* A document's own dock asks its session's agent; without one, this asks. */}
        {typed && latest && summary && !(isDocument && target) && (
          <AskDock onAsk={() => tools.askWhole()} />
        )}
      </>
    )
  } else {
    // The ground the canvas opens on, so nothing jumps when it arrives.
    if (kind === 'canvas' || kind === 'slides') ground = 'dots'
    body = (
      <Waiting
        since={since}
        id={id}
        look={kind === 'web' || kind === 'document' ? 'sheet' : 'card'}
      />
    )
  }

  // The page on screen after the title, for a canvas: a document's page, or the frame in focus.
  let page: BarPage | null = null
  if (showing && doc) {
    const current = doc.canvases.find((c) => c.id === state.page) ?? doc.canvases[0]
    if (current) {
      page = {
        name: current.name,
        items: [
          ...doc.canvases.map((c) => ({
            label: c.name,
            shortcut: String(doc.pages.filter((p) => p.canvas === c.id).length),
            checked: c.id === current.id,
            onSelect: () => setViewerState(id, { page: c.id, selection: [], opened: null }),
          })),
          {
            label: t('viewer.showPages'),
            divider: true,
            onSelect: () => setViewerState(id, { left: true }),
          },
        ],
      }
    }
  } else if (showing && pageName && shown?.canvas && canvasState.focused !== null) {
    const count = shown.canvas.pages.length
    page = {
      name: pageName(canvasState.focused),
      items: [
        ...Array.from({ length: count }, (_, i) => ({
          label: pageName(i),
          checked: i === canvasState.focused,
          onSelect: () => controls.commands?.focus(i),
        })),
        {
          label: t('canvas.backToCanvas'),
          divider: true,
          onSelect: () => controls.commands?.focus(null),
        },
      ],
    }
  }

  const present = (): void => {
    if (isDeck) {
      if (deck) setPresenting(String(Math.min(deckSlide, deck.slides.length)))
      return
    }
    if (!shown?.canvas) return
    if (docShown) {
      const target = state.opened ?? state.selection[0] ?? null
      const index = target ? shown.canvas.pages.findIndex((p) => p.id === target) : -1
      const first = shown.canvas.pages.findIndex((p) => {
        const placed = doc?.pages.find((d) => d.id === p.id)
        return placed && placed.canvas === (state.page ?? doc?.canvases[0]?.id)
      })
      const from = shown.canvas.pages[Math.max(0, index >= 0 ? index : first)]
      setPresenting(from?.id ?? null)
    } else setPresenting(String(canvasState.focused ?? canvasState.selected))
  }

  const presenceItems: MenuItem[] = agents.map((agent) => ({
    label: agent.name,
    logo: <AgentMark agent={agent.agentId} size={14} hostId={agent.hostId} />,
    checked: followingNow === agent.sessionId,
    onSelect: () => setFollowing(followingNow === agent.sessionId ? null : agent.sessionId),
  }))

  const [besideSlides, setBesideSlides] = useState<boolean | null>(null)
  // Waiting for the content: the shell shows, its cards hold placeholder rows.
  const opening = !showing && !states.error && !artifact.stopped
  const leftCard = useMemo(
    () =>
      showing && isDocument
        ? docHeadings > 0
          ? {
              title: (
                <>
                  {t('outline.title')}
                  <small className="ads-count">{t('outline.count', { count: docHeadings })}</small>
                </>
              ),
              // Open from six headings up, except beside a session; a right card folds it.
              byDefault: docHeadings >= 6 && place.where === 'main',
              open: rightKey !== null ? false : state.left,
              onOpenChange: (open: boolean) => {
                // The Outline comes back in place of a right card at every width.
                if (open && rightKey !== null) closeRight()
                setViewerState(id, { left: open })
              },
            }
          : null
        : showing && isDeck && deck
          ? {
              title: (
                <>
                  {t('deck.slides')}
                  <small className="ads-count">{deck.slides.length}</small>
                </>
              ),
              // Open in the main area; beside a session it waits to be asked for there, whatever
              // the main area last did with it.
              byDefault: place.where === 'main',
              open: place.where === 'main' ? state.left : besideSlides,
              onOpenChange: (open: boolean) =>
                place.where === 'main' ? setViewerState(id, { left: open }) : setBesideSlides(open),
            }
          : showing && docShown
            ? {
                title: doc
                  ? t('pages.heading', {
                      pages: doc.canvases.length,
                      frames: t('pages.frames', { count: doc.pages.length }),
                    })
                  : t('pages.title'),
                // Open by default where there is more than one page or many frames to find.
                byDefault: !!doc && (doc.canvases.length > 1 || doc.pages.length > 8),
                open: state.left,
                onOpenChange: (open: boolean) => setViewerState(id, { left: open }),
              }
            : opening && summary && kind !== 'web'
              ? {
                  title:
                    kind === 'document'
                      ? t('outline.title')
                      : kind === 'slides'
                        ? t('deck.slides')
                        : t('pages.title'),
                  // As each kind opens it once it shows, so nothing jumps when it does.
                  byDefault:
                    kind === 'canvas'
                      ? summary.canvas && summary.pages > 8
                      : kind === 'slides'
                        ? place.where === 'main'
                        : false,
                  open: state.left,
                  onOpenChange: (open: boolean) => setViewerState(id, { left: open }),
                }
              : null,
    [
      opening,
      summary,
      kind,
      showing,
      isDocument,
      isDeck,
      deck,
      docHeadings,
      rightKey,
      closeRight,
      place.where,
      docShown,
      doc,
      state.left,
      besideSlides,
      id,
      t,
    ],
  )

  const bar = (
    <ViewerBar
      where={place.where}
      kind={kind}
      title={title}
      page={page}
      version={
        shown
          ? {
              number: shown.version,
              at: versions?.find((v) => v.version === shown.version)?.createdAt ?? null,
            }
          : null
      }
      historyOpen={rightKey === 'history'}
      onVersion={toggleHistory}
      mode={mode}
      onMode={setMode}
      comments={threads?.filter((thread) => thread.resolvedAt === null).length ?? 0}
      modesOff={
        !showing
          ? t('viewer.modes.off')
          : states.inTrash || states.gone
            ? t('viewer.modes.deleted')
            : earlier !== null
              ? t('viewer.modes.earlier', { version: head })
              : null
      }
      editOff={
        offline
          ? hostName
            ? t('viewer.offline.editPaused', { host: hostName })
            : t('viewer.offline.editPausedLocal')
          : null
      }
      presence={
        showing ? (
          <PresenceFaces
            agents={panel ? agents.slice(0, 3) : agents}
            presence={artifact.presence}
            pageName={(pageId) =>
              pageId ? (doc?.pages.find((p) => p.id === pageId)?.name ?? null) : null
            }
            following={followingNow}
            onFollow={setFollowing}
            visitors={visitors}
          />
        ) : null
      }
      presenceItems={showing ? presenceItems : []}
      onChat={
        place.where === 'main' && chatSession
          ? () => openSessionWithArtifact(chatSession.id, chatSession.projectPath, id)
          : null
      }
      onPresent={showing && !states.gone && (shown?.canvas || (isDeck && deck)) ? present : null}
      onOpenMain={panel ? () => openArtifact(id) : null}
      share={
        showing && shown && shares && !states.gone && !states.inTrash
          ? { id, title, shown: shown.version, head: head ?? shown.version }
          : null
      }
      menu={
        summary
          ? {
              target: {
                id,
                title,
                version: shown?.version ?? summary.version,
                versions: summary.version,
                files: shown?.files ?? summary.files,
                sessionId: summary.sessionId,
                deletedAt: summary.deletedAt,
                type: summary.type,
              },
              options: {
                onReload: artifact.reload,
                historyOpen: rightKey === 'history',
                onVersionHistory: toggleHistory,
                onDeleted: place.where === 'main' ? closeArtifact : undefined,
                onDownloadPng:
                  renders && shown && !shown.canvas ? () => downloadPng(null) : undefined,
              },
            }
          : null
      }
    />
  )

  const shell = (
    <ArtifactShell
      where={place.where}
      bar={bar}
      layout={layout}
      ground={ground}
      left={leftCard}
      right={right}
      expanded={maximized}
    >
      <div ref={area} className="avs-stage" data-fault={states.gone ? 'deleted' : undefined}>
        {showing && <AgentCursorStyles />}
        {body}
        {showing && tools.overlay}
      </div>
      {pill && <ViewerSlot slot="pill">{pill}</ViewerSlot>}
      {opening && (
        <>
          <ViewerSlot slot="left">
            <SkeletonRows nested={kind === 'canvas'} />
          </ViewerSlot>
          <OpeningDock
            kind={
              kind === 'canvas' || kind === 'slides'
                ? 'canvas'
                : kind === 'document'
                  ? 'document'
                  : 'web'
            }
          />
        </>
      )}
    </ArtifactShell>
  )

  return (
    <div ref={frame} className="contents">
      {panel ? (
        <PaneBody aria-label={title || undefined} className="avs-pane">
          {shell}
        </PaneBody>
      ) : (
        <div className="avs-main">{shell}</div>
      )}
      {presenting !== null && url && isDeck && deck && (
        <DeckPresent
          artifactId={id}
          url={url}
          deck={deck}
          title={title}
          start={Number(presenting) || 1}
          onExit={(last) => {
            setDeckSlide(id, last)
            setPresenting(null)
          }}
        />
      )}
      {presenting !== null && url && shown && !isDeck && (
        <CanvasPresent
          artifactId={id}
          url={url}
          shown={shown}
          title={title}
          sheets={canvasSheets(
            docShown ? doc : null,
            shown.canvas?.pages ?? null,
            pageName ?? (() => title),
            title,
          )}
          start={presenting}
          onExit={() => setPresenting(null)}
        />
      )}
    </div>
  )
}

/** The room the pill and the dock take over a canvas of one file, which its fit keeps clear. */
const PILL_ROOM = 56
const DOCK_ROOM = 48

/**
 * The pill at the content's top: what shows instead of the latest version, or what happens to the
 * whole artifact, and what to do. `mark` takes the dot's place; a quiet action is a ghost button.
 */
function Pill({
  lead,
  rest,
  mark,
  keepRest = false,
  actions,
}: {
  lead: string
  rest: React.ReactNode
  mark?: React.ReactNode
  /** Keep the rest when narrow too, as a short word that something is under way. */
  keepRest?: boolean
  actions: Array<{
    label: string
    busy?: boolean
    restores?: boolean
    quiet?: boolean
    run: () => void
  }>
}) {
  const { tier } = useShell()
  return (
    <div role="status" className="avs-pill__in" data-actions={actions.length > 0 || undefined}>
      {mark ?? <span className="avs-pill__dot" aria-hidden />}
      <span className="avs-pill__text">
        <b>{lead}</b>
        {(keepRest || tier !== 'narrow') && rest}
      </span>
      {actions.map((action, i) => (
        <Button
          key={action.label}
          variant={i === 0 && !action.quiet ? 'secondary' : 'ghost'}
          size="sm"
          icon={action.restores ? <Icon icon={RotateLeft01Icon} size={14} /> : undefined}
          loading={action.busy}
          onClick={action.run}
        >
          {action.label}
        </Button>
      ))}
    </div>
  )
}

/** " · 52 min ago · Three onboarding directions", after "Version 1 of 3". */
function EarlierRest({ createdAt, note }: { createdAt: number; note: string | null }) {
  const now = useNow()
  return <span>{` · ${longAgo(createdAt, now)}${note ? ` · ${note}` : ''}`}</span>
}

/** " · just now", after "Deleted". */
function DeletedAgo({ deletedAt }: { deletedAt: number }) {
  const now = useNow()
  return <span>{` · ${longAgo(deletedAt, now)}`}</span>
}

/** What the writing pill says: the slide, section or frame the agent holds, else its next version. */
function writingLead(
  t: TFunction<['artifacts', 'common']>,
  writer: Writer,
  head: number,
  frames: readonly { id: string; name: string }[] | null,
): string {
  const piece = writer.pieces?.find((p) => p.kind !== 'whole')
  if (piece?.kind === 'slide') {
    return t('viewer.writing.slide', { agent: writer.name, number: piece.number })
  }
  if (piece?.kind === 'frame') {
    const name = frames?.find((f) => f.id === piece.id)?.name
    if (name) return t('viewer.writing.piece', { agent: writer.name, name })
  }
  if (piece?.kind === 'section') {
    return t('viewer.writing.section', { agent: writer.name })
  }
  return t('viewer.writing.version', { agent: writer.name, version: head + 1 })
}

function DaysLeft({ deletedAt }: { deletedAt: number }) {
  const { t } = useTranslation('artifacts')
  const now = useNow()
  return <span>{t('viewer.daysLeft', { count: daysLeft(deletedAt, now) })}</span>
}

/** A canvas of one file's dock: its zoom on the overview, or the pages around the one in focus. */
function LegacyCanvasDock({ controls }: { controls: CanvasControls }) {
  const { t } = useTranslation('artifacts')
  const state = useCanvasState(controls)
  const commands = controls.commands
  const focused = state.focused
  return (
    <ViewerSlot slot="dock">
      {focused === null ? (
        <>
          <DockButton
            label={t('canvas.zoomOut')}
            icon={MinusSignIcon}
            disabled={atMinZoom(state.zoom)}
            onClick={() => commands?.zoomStep(-1)}
          />
          <DockButton label={t('canvas.fitAll')} onClick={() => commands?.fitAll()}>
            <span className="avs-dock__pct">
              {t('canvas.zoom', { percent: Math.round(state.zoom * 100) })}
            </span>
          </DockButton>
          <DockButton
            label={t('canvas.zoomIn')}
            icon={PlusSignIcon}
            disabled={atMaxZoom(state.zoom)}
            onClick={() => commands?.zoomStep(1)}
          />
        </>
      ) : (
        <>
          <DockButton
            label={t('canvas.previous')}
            icon={ArrowLeft01Icon}
            disabled={focused === 0}
            onClick={() => commands?.focus(focused - 1)}
          />
          <span className="avs-dock__count">
            {t('canvas.counter', { number: focused + 1, count: state.count })}
          </span>
          <DockButton
            label={t('canvas.next')}
            icon={ArrowRight01Icon}
            disabled={focused === state.count - 1}
            onClick={() => commands?.focus(focused + 1)}
          />
          <DockRule />
          <DockButton
            label={t('canvas.backToCanvas')}
            icon={ArrowShrink01Icon}
            onClick={() => commands?.focus(null)}
          />
        </>
      )}
    </ViewerSlot>
  )
}
/** The dock while the content loads: what its kind will offer, dimmed and out of reach. */
function OpeningDock({ kind }: { kind: 'canvas' | 'document' | 'web' }) {
  const { t } = useTranslation('artifacts')
  const none = () => {}
  const { tier, leftCard: left } = useShell()
  const narrow = tier === 'narrow'
  const ask = (
    <>
      <DockRule />
      <DockButton label={t('ask.whole')} icon={SparklesIcon} disabled onClick={none}>
        {t('ask.short')}
      </DockButton>
    </>
  )
  return (
    <ViewerSlot slot="dock">
      {kind !== 'web' && left && (
        <>
          <DockButton
            label={t(kind === 'canvas' ? 'pages.title' : 'outline.title')}
            icon={SidebarLeftIcon}
            pressed={left.shown}
            onClick={() => left.setShown(!left.shown)}
          />
          <DockRule />
        </>
      )}
      <span className="avs-dock__off" aria-disabled>
        {kind === 'canvas' ? (
          <>
            {tier === 'wide' && (
              <DockButton label={t('canvas.fitWidth')} disabled onClick={none}>
                {t('canvas.fitWidth')}
              </DockButton>
            )}
            <DockButton label={t('canvas.zoomOut')} icon={MinusSignIcon} disabled onClick={none} />
            <span className="avs-dock__pct">{t('canvas.zoom', { percent: 100 })}</span>
            <DockButton label={t('canvas.zoomIn')} icon={PlusSignIcon} disabled onClick={none} />
          </>
        ) : kind === 'document' ? (
          <>
            {!narrow && (
              <DockButton label={t('doc.smaller')} icon={MinusSignIcon} disabled onClick={none} />
            )}
            <span className="avs-dock__pct">{t('doc.size', { percent: 100 })}</span>
            {!narrow && (
              <DockButton label={t('doc.larger')} icon={PlusSignIcon} disabled onClick={none} />
            )}
            {!narrow && ask}
          </>
        ) : (
          <>
            <DockButton label={t('sheet.width.label')} disabled onClick={none}>
              {t('sheet.width.fill')}
            </DockButton>
            <DockRule />
            <DockButton
              label={t('viewer.reload')}
              icon={ArrowReloadHorizontalIcon}
              disabled
              onClick={none}
            />
            {!narrow && (
              <DockButton
                label={t('viewer.openInBrowser')}
                icon={LinkSquare02Icon}
                disabled
                onClick={none}
              />
            )}
            {!narrow && ask}
          </>
        )}
      </span>
    </ViewerSlot>
  )
}

/** A document's or a deck's dock: asking an agent about the whole of it. */
function AskDock({ onAsk }: { onAsk: () => void }) {
  const { t } = useTranslation('artifacts')
  return (
    <ViewerSlot slot="dock">
      <DockButton label={t('ask.whole')} icon={SparklesIcon} onClick={onAsk}>
        {t('ask.short')}
      </DockButton>
    </ViewerSlot>
  )
}
