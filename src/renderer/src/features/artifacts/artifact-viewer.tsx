import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircleIcon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowShrink01Icon,
  Delete02Icon,
  MinusSignIcon,
  PlusSignIcon,
  RotateLeft01Icon,
  SparklesIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
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
import { PaneSheet } from '@renderer/features/shell/panel-button'
import { artifactRefOf, errorMessage, host, learnArtifactHost } from '@renderer/lib/host'
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
import { setDeckSlide, useDeckSlide } from '@renderer/stores/artifact-deck'
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
  MAIN_ARTIFACT_PANEL,
  openSessionWithArtifact,
  toggleSidePane,
  useViewStore,
} from '@renderer/stores/view'
import { anchorOf } from './anchors'
import { useArtifactShares } from './artifact-host'
import { useArrivedChange } from './use-arrived-change'
import { atMaxZoom, atMinZoom } from './camera'
import { CanvasEditor } from './canvas-editor'
import { CanvasControls, useCanvasState } from './canvas-controls'
import { changeCount } from './change-words'
import type { PageActions } from './canvas-view'
import { DeckPresent } from './deck-present'
import { DeckSheet } from './deck-sheet'
import { DocumentSheet } from './document-sheet'
import { ArtifactEditor, useEditorState, type EditorMode } from './editor'
import { isEditable, modeKey } from './keys'
import { artifactKind, daysLeft } from './model'
import { handOffPageErrors } from './page-error-handoff'
import { Waiting } from './page-frame'
import { ChangePill, PageSheet, type SheetAgent } from './page-sheet'
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
import { useChangedFrames } from './use-changed-frames'
import { noteAuthor, usePresentAgents, useVisitors } from './use-present-agents'
import { useVersions } from './use-versions'
import { canvasContent, useViewerTools, type ToolContent } from './viewer-tools'
import { ViewerBar, type BarPage } from './viewer-bar'
import { ArtifactSurface, ViewerEmpty } from './viewer-parts'
import { ArtifactShell, DockButton, DockRule, ViewerSlot, type RightContent } from './viewer-shell'
import { useShell } from './viewer-shell-context'
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
  const earlier = picked !== null && head !== null && picked < head ? picked : null
  const title = summary?.title ?? shown?.title ?? ''
  const kind = summary ? artifactKind(summary) : null
  // A web page: one page of its own, neither a canvas nor a typed document or deck.
  const webPage = !!shown && !shown.canvas && !summary?.type
  const isDocument = !!shown && summary?.type === 'document'
  const isDeck = !!shown && summary?.type === 'slides'
  const arrived = useArrivedChange(id, head, webPage || isDocument || isDeck)
  // A document and a deck mark what changed and step through it on their own pill.
  const docArrived = isDocument ? arrived : null
  const deck = useDeck(id, isDeck && shown ? shown.version : null)
  const deckSlide = useDeckSlide(id)
  // An agent's newest version, which what it changed compares with the version before: a frame,
  // the web page, a slide.
  const lastWrite = versions?.[0] ?? null
  const agentWrite =
    lastWrite && lastWrite.author !== null && lastWrite.version > 1 && lastWrite.version === head
      ? { before: lastWrite.version - 1, after: lastWrite.version }
      : null
  const pageChanges = useChanges(
    id,
    agentWrite?.before ?? null,
    agentWrite?.after ?? null,
    (webPage || isDeck) && agentWrite !== null,
  )
  // A web page compares when the agent changed it at all, a deck when it changed the slide shown.
  const pageCompare =
    agentWrite && pageChanges && changeCount(pageChanges).count > 0
      ? webPage ||
        (isDeck &&
          pageChanges.kind === 'slides' &&
          pageChanges.slides.some((s) => s.number === deckSlide))
        ? agentWrite
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
  // Pins and the picked outline take the theme's colors, again when the color mode changes.
  const dark = useDark()
  useEffect(() => editor?.restyle(), [editor, dark])
  const editing = useEditorState(editor)
  const { threads, error: commentsError } = useComments(id)
  // A version just written counts as the latest while it loads, so editing goes on across it.
  const latest = !!shown && earlier === null && !states.inTrash
  // Comment and Edit act on the latest version only; elsewhere the viewer only shows.
  const mode: ViewerMode = latest ? state.mode : 'view'
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
  const visitors = useVisitors(id)
  const followingNow = following && agents.some((a) => a.sessionId === following) ? following : null
  const pageAsked = useViewStore((s) => {
    const asked = s.sideArtifactPage[panel?.panel ?? MAIN_ARTIFACT_PANEL]
    return asked?.artifactId === id ? asked : null
  })
  const showing = !!(url && shown) && !states.error && !states.gone && !artifact.stopped

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
  // Which frames count as changed: those the latest version changed against the one before.
  const changedFrames = useChangedFrames(id, docShown && shown ? shown.version : null)
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
    editable: states.inTrash ? 'deleted' : earlier !== null ? 'earlier' : 'yes',
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
  const agentBefore = agentWrite?.before ?? null
  const compare = useMemo(
    () => (latest && agentBefore !== null ? { before: agentBefore, after: agentBefore + 1 } : null),
    [latest, agentBefore],
  )
  const right: RightContent | null =
    tools.right ??
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
  const closeRight = useCallback(() => rightNow.current?.onClose(), [])
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

  // The pill at the content's top: an earlier version, Recently deleted, or an old canvas.
  let pill: React.ReactNode = null
  const changePill = arrived ? (
    <ChangePill
      to={arrived.to}
      changes={arrived.changes}
      onDismiss={() => {
        if (comparing) setViewerState(id, { version: null })
        arrived.dismiss()
      }}
    />
  ) : null
  if (comparing) {
    // The dock's switch and the sheet's tag say which version this is.
    pill = changePill
  } else if (shown && earlier !== null && head !== null) {
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
  } else if (changePill && earlier === null && !isDocument && !isDeck) {
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

  let body: React.ReactNode
  let layout: 'float' | 'beside' = 'beside'
  let ground: 'dots' | 'plain' = 'plain'
  if (states.error === 'previewOnly') {
    body = <PreviewOnly id={id} title={title} summary={summary ?? null} />
  } else if (states.error === 'missing') {
    // Trying again reads the same missing files; an earlier version may still have its own.
    body = (
      <ViewerEmpty
        icon={AlertCircleIcon}
        danger
        title={t('viewer.missingTitle')}
        text={t('viewer.error.missing')}
      >
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
      </ViewerEmpty>
    )
  } else if (states.error) {
    body = (
      <ViewerEmpty
        icon={AlertCircleIcon}
        danger
        title={t('viewer.errorTitle')}
        text={t(`viewer.error.${states.error}`)}
      >
        <Button variant="secondary" size="sm" onClick={artifact.retry}>
          {t('viewer.retry')}
        </Button>
      </ViewerEmpty>
    )
  } else if (states.gone) {
    body = (
      <ViewerEmpty
        icon={Delete02Icon}
        title={t('viewer.goneTitle')}
        text={t('viewer.goneDescription')}
      >
        {place.where === 'main' && (
          <Button
            variant="secondary"
            size="sm"
            icon={<Icon icon={ArrowLeft01Icon} size={14} />}
            onClick={closeArtifact}
          >
            {t('viewer.back')}
          </Button>
        )}
        <Button size="sm" loading={restoring} onClick={() => restore(() => restoreArtifact(id))}>
          {t('menu.restore')}
        </Button>
      </ViewerEmpty>
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
            show={pageAsked}
            onShown={(seq) => artifactPageShown(panel?.panel ?? MAIN_ARTIFACT_PANEL, seq)}
            changed={changedFrames}
            comments={frameComments}
            compare={compare}
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
            arrived={latest ? arrived : null}
            comments={{
              threads,
              shown: latest && (state.right === 'comments' || mode === 'comment'),
              draft: tools.docDraft,
              thread: tools.docThread,
            }}
            agent={sheetAgent}
            onAsk={(anchor) => toolsNow.current.askAnchor(anchor, null)}
            onPresent={(slide) => setPresenting(String(slide))}
            asked={pageAsked}
            onAsked={(seq) => artifactPageShown(panel?.panel ?? MAIN_ARTIFACT_PANEL, seq)}
            focusThread={docFocus}
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
            arrived={docArrived}
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
          />
        )}
        {legacyCanvas && pageName && <LegacyCanvasDock controls={controls} />}
        {typed && latest && summary && <AskDock onAsk={() => tools.askWhole()} />}
      </>
    )
  } else {
    body = <Waiting since={since} />
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
            : null,
    [
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
          : states.inTrash
            ? t('viewer.modes.deleted')
            : earlier !== null
              ? t('viewer.modes.earlier', { version: head })
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
      onPresent={showing && (shown?.canvas || (isDeck && deck)) ? present : null}
      share={
        showing && shown && shares
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
      panel={
        panel
          ? {
              maximized,
              onExpand: phone ? null : () => setMaximized(!maximized),
              onClose: () => toggleSidePane(panel.panel, 'artifact', false),
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
      <div ref={area} className="avs-stage">
        {showing && <AgentCursorStyles />}
        {body}
        {showing && tools.overlay}
      </div>
      {pill && <ViewerSlot slot="pill">{pill}</ViewerSlot>}
    </ArtifactShell>
  )

  return (
    <div ref={frame} className="contents">
      {panel ? (
        <PaneSheet
          pane="artifact"
          maximized={maximized}
          aria-label={title || undefined}
          className="avs-pane"
        >
          {shell}
        </PaneSheet>
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

/** The pill at the content's top: what shows instead of the latest version, and what to do. */
function Pill({
  lead,
  rest,
  actions,
}: {
  lead: string
  rest: React.ReactNode
  actions: Array<{ label: string; busy?: boolean; restores?: boolean; run: () => void }>
}) {
  const { tier } = useShell()
  return (
    <div role="status" className="avs-pill__in">
      <span className="avs-pill__dot" aria-hidden />
      <span className="avs-pill__text">
        <b>{lead}</b>
        {tier !== 'narrow' && rest}
      </span>
      {actions.map((action, i) => (
        <Button
          key={action.label}
          variant={i === 0 ? 'secondary' : 'ghost'}
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
