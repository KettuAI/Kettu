import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircleIcon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowShrink01Icon,
  Delete02Icon,
  LinkSquare02Icon,
  MinusSignIcon,
  PlusSignIcon,
  RefreshIcon,
  RotateLeft01Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { ARTIFACT_ENTRY } from '@shared/artifact-files'
import { NO_SESSION } from '@shared/artifacts'
import { Icon, type MenuItem } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { AgentCursorStyles } from '@renderer/components/affect/agent-cursors'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { toast } from '@renderer/components/ui/toast'
import { usePhoneWindow } from '@renderer/features/shell/narrow'
import { PaneSheet } from '@renderer/features/shell/panel-button'
import { artifactRefOf, errorMessage, host, learnArtifactHost } from '@renderer/lib/host'
import { useHostHas } from '@renderer/lib/host-features'
import { hostOfPath } from '@renderer/lib/host-paths'
import { longAgo } from '@renderer/lib/format'
import { isWeb } from '@renderer/lib/platform'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import {
  setViewerState,
  useViewerState,
  viewerStateOf,
  type RightCard,
  type ViewerMode,
} from '@renderer/stores/artifact-viewer'
import {
  restoreArtifact,
  restoreVersion,
  setPaneSelection,
  useArtifactsStore,
} from '@renderer/stores/artifacts'
import { useSessionsStore } from '@renderer/stores/sessions'
import {
  artifactPageShown,
  closeArtifact,
  openSessionWithArtifact,
  toggleSidePane,
  useViewStore,
} from '@renderer/stores/view'
import { anchorOf, pinsOf } from './anchors'
import { useArtifactShares } from './artifact-host'
import { atMaxZoom, atMinZoom } from './camera'
import { CanvasEditor } from './canvas-editor'
import { CanvasControls, useCanvasState } from './canvas-controls'
import type { PageActions } from './canvas-view'
import { CommentBox, CommentsPanel } from './comments'
import { EditPanel } from './edit-panel'
import { ArtifactEditor, useEditorState, type EditorMode } from './editor'
import { isEditable, modeKey } from './keys'
import { artifactKind, daysLeft } from './model'
import { Waiting } from './page-frame'
import { PresenceFaces } from './presence-faces'
import { Presenter } from './present'
import { PreviewOnly } from './preview-only'
import {
  canvasPageName,
  reportMissing,
  useArtifact,
  useArtifactStates,
  useListsRead,
} from './use-artifact'
import { useComments } from './use-comments'
import { staticCanvas, useCanvasDoc } from './use-canvas-doc'
import { clampSize, useDocActions } from './use-doc-actions'
import { noteAuthor, usePresentAgents, useVisitors } from './use-present-agents'
import { useVersions } from './use-versions'
import { VersionHistory } from './version-history'
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
  const [presenting, setPresenting] = useState<number | null>(null)
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
  // Publishing takes the account the host keeps, which the daemon has none of.
  const shares = useArtifactShares(id)
  // Only a desktop host renders a page apart from the window.
  const renders = useHostHas('thumbnails') === true
  const editor = useMemo(() => (url ? new ArtifactEditor(url.slice(0, -1)) : null), [url])
  useEffect(() => () => editor?.dispose(), [editor])
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
    const asked = panel ? s.sideArtifactPage[panel.panel] : undefined
    return asked?.artifactId === id ? asked : null
  })
  const showing = !!(url && shown) && !states.error && !states.gone && !artifact.stopped

  // The canvas document sets the editor's mode itself, as a frame it enters is picked in.
  useEffect(() => {
    if (!editor || docShown) return
    editor.setMode(editorMode(mode))
  }, [editor, mode, docShown])

  const pinsShown = latest && (state.right === 'comments' || mode === 'comment')
  useEffect(() => {
    if (!editor || !shown) return
    editor.setPins(pinsShown ? pinsOf(threads, shown) : () => [])
  }, [editor, shown, threads, pinsShown])

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
    () => ({ download: renders ? downloadPng : null, present: (index) => setPresenting(index) }),
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

  // The right card: an element picked in Edit shows its look; otherwise the card chosen.
  const propsShown =
    mode === 'edit' && editing.mode === 'select' && !!editing.picked && !!editor && !!head
  const chosen: RightCard | null =
    state.right === 'tweaks' && !docShown
      ? null
      : state.right === 'comments' && !summary
        ? null
        : state.right
  const rightKey = propsShown ? 'props' : chosen

  const setMode = useCallback(
    (next: ViewerMode) =>
      setViewerState(id, (s) => ({
        mode: next,
        // Comment opens the comments, and leaving it puts them away.
        right: next === 'comment' ? 'comments' : s.right === 'comments' ? null : s.right,
      })),
    [id],
  )
  const closeRight = useCallback(() => {
    if (rightKey === 'props') {
      editor?.clearPick()
      return
    }
    setViewerState(id, (s) => ({
      right: null,
      // Closing the history goes back to the latest version.
      version: s.right === 'history' ? null : s.version,
    }))
  }, [rightKey, editor, id])
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
      if (event.key !== 'Escape') return
      const now = viewerStateOf(id)
      if (editor?.escape()) {
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
  if (shown && earlier !== null && head !== null) {
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
              restore(() =>
                restoreVersion(id, earlier, head).then(() => setViewerState(id, { version: null })),
              ),
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
  }

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
  } else if (artifact.stopped) {
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
    else if (shown.canvas) {
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
            actions={docActions}
            agents={latest ? agents : []}
            following={followingNow}
            onFollowDone={() => setFollowing(null)}
            onViewPage={(page) => void host('artifacts.view', { id, page }).catch(() => {})}
            sessionName={(session) => noteAuthor(agents, session, t('board.note.agent'))}
            reloads={artifact.reloads}
            show={pageAsked}
            onShown={panel ? (seq) => artifactPageShown(panel.panel, seq) : undefined}
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
        ) : (
          <div className={cn('avs-paper', typed && 'avs-paper--typed')}>
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
        )}
        {legacyCanvas && pageName && <LegacyCanvasDock controls={controls} />}
        {!shown.canvas && !typed && (
          <PageDock
            onReload={artifact.reload}
            onBrowser={
              isWeb
                ? null
                : () =>
                    void window.kettu.artifacts
                      .openExternal(artifactRefOf(id), shown.version)
                      .catch((error: unknown) => console.error(`Could not open ${id}`, error))
            }
          />
        )}
        {editor && mode === 'comment' && editing.picked?.point && (
          <CommentBox
            key={`${editing.picked.point.x},${editing.picked.point.y}`}
            anchor={anchorOf(editing.picked, shown)}
            point={editing.picked.point}
            onCancel={() => editor.clearPick()}
            onSubmit={async (text) => {
              await host('artifacts.comment', {
                id,
                anchor: anchorOf(editing.picked!, shown),
                body: text,
              })
              editor.clearPick()
            }}
          />
        )}
      </>
    )
  } else {
    body = <Waiting since={since} />
  }

  let right: RightContent | null = null
  if (rightKey === 'props' && editor && shown && editing.picked) {
    right = {
      key: `props:${editing.picked.page}:${editing.picked.selection.path}:${editing.picked.selection.src}`,
      body: (
        <EditPanel
          id={id}
          version={shown.version}
          editable={states.inTrash ? 'deleted' : earlier !== null ? 'earlier' : 'yes'}
          picked={editing.picked}
          editor={editor}
        />
      ),
      onClose: closeRight,
    }
  } else if (rightKey === 'history') {
    right = {
      key: 'history',
      body: (
        <VersionHistory
          versions={versions}
          error={versionsError}
          shown={picked}
          onPick={(version) => setViewerState(id, { version: version === head ? null : version })}
        />
      ),
      onClose: closeRight,
    }
  } else if (rightKey === 'comments' && summary) {
    right = {
      key: 'comments',
      body: (
        <aside aria-label={t('comments.title')} className="k-av-side">
          <div className="k-av-side__head">
            <h2 className="k-av-side__title">{t('comments.title')}</h2>
          </div>
          <CommentsPanel
            artifact={{ id, title, version: head ?? summary.version, project: summary.project }}
            threads={threads}
            error={commentsError}
            preferred={[
              ...(artifact.presence?.sessions.filter((s) => s.editing).map((s) => s.sessionId) ??
                []),
              summary.sessionId,
            ]}
            onFocus={(thread) => {
              const number = thread.anchor.page?.number
              const index = shown?.canvas?.pages.findIndex((p) => p.number === number) ?? -1
              if (index >= 0) controls.commands?.focus(index)
            }}
          />
        </aside>
      ),
      onClose: closeRight,
    }
  } else if (rightKey === 'tweaks') {
    right = { key: 'tweaks', body: null, onClose: closeRight }
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

  // Chat opens the session writing it, or the one that wrote it last, with it beside the thread.
  const sessionId =
    artifact.presence?.sessions.find((s) => s.editing)?.sessionId ??
    (summary && summary.sessionId !== NO_SESSION ? summary.sessionId : null)
  const chatSession = useSessionsStore((s) => (sessionId ? (s.byId[sessionId] ?? null) : null))

  const present = (): void => {
    if (!shown?.canvas) return
    if (docShown) {
      const target = state.opened ?? state.selection[0] ?? null
      const index = target ? shown.canvas.pages.findIndex((p) => p.id === target) : -1
      const first = shown.canvas.pages.findIndex((p) => {
        const placed = doc?.pages.find((d) => d.id === p.id)
        return placed && placed.canvas === (state.page ?? doc?.canvases[0]?.id)
      })
      setPresenting(Math.max(0, index >= 0 ? index : first))
    } else setPresenting(canvasState.focused ?? canvasState.selected)
  }

  const presenceItems: MenuItem[] = agents.map((agent) => ({
    label: agent.name,
    logo: <AgentMark agent={agent.agentId} size={14} hostId={agent.hostId} />,
    checked: followingNow === agent.sessionId,
    onSelect: () => setFollowing(followingNow === agent.sessionId ? null : agent.sessionId),
  }))

  const leftCard = useMemo(
    () =>
      showing && docShown
        ? {
            title: t('board.canvases.menu'),
            byDefault: latest,
            open: state.left,
            onOpenChange: (open: boolean) => setViewerState(id, { left: open }),
          }
        : null,
    [showing, docShown, latest, state.left, id, t],
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
      onPresent={showing && shown?.canvas ? present : null}
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
      {presenting !== null && url && shown && (
        <Presenter
          url={url}
          version={shown.version}
          title={title}
          pages={shown.canvas?.pages ?? null}
          start={presenting}
          pageName={pageName ?? (() => title)}
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

/** A web page's dock: load it again, or open it in the browser. */
function PageDock({
  onReload,
  onBrowser,
}: {
  onReload: () => void
  onBrowser: (() => void) | null
}) {
  const { t } = useTranslation('artifacts')
  return (
    <ViewerSlot slot="dock">
      <DockButton label={t('viewer.reload')} icon={RefreshIcon} onClick={onReload} />
      {onBrowser && (
        <DockButton label={t('viewer.openInBrowser')} icon={LinkSquare02Icon} onClick={onBrowser} />
      )}
    </ViewerSlot>
  )
}
