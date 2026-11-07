import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircleIcon,
  ArrowLeft01Icon,
  Cancel01Icon,
  Clock01Icon,
  Delete02Icon,
  LinkSquare02Icon,
  PlayIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { backTo } from '@renderer/app/history'
import { Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { SegmentedControl } from '@renderer/components/affect/segmented-control'
import { toast } from '@renderer/components/ui/toast'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { NoDrag, TopBar } from '@renderer/features/shell/top-bar'
import { errorMessage, host } from '@renderer/lib/host'
import { useHostHas } from '@renderer/lib/host-features'
import { isWeb } from '@renderer/lib/platform'
import { restoreArtifact, restoreVersion } from '@renderer/stores/artifacts'
import { closeArtifact, useViewStore } from '@renderer/stores/view'
import { AgentCursorStyles } from '@renderer/components/affect/agent-cursors'
import { anchorOf, pinsOf } from './anchors'
import { CanvasEditor, type DocPageActions } from './canvas-editor'
import { docLayout } from './canvas-model'
import { handOff } from './handoff'
import { PresenceFaces } from './presence-faces'
import { usePresentAgents } from './use-present-agents'
import { staticCanvas, useCanvasDoc } from './use-canvas-doc'
import { ArtifactMoreButton } from './artifact-menu'
import { ShareButton } from './share-popover'
import { CanvasControls, useCanvasState } from './canvas-controls'
import type { PageActions } from './canvas-view'
import { CommentBox, CommentsPanel } from './comments'
import { EditPanel } from './edit-panel'
import { ArtifactEditor, useEditorState } from './editor'
import { isEditable, isModeKey } from './keys'
import { KIND_ICON } from './kinds'
import { artifactKind } from './model'
import { Waiting } from './page-frame'
import { Presenter } from './present'
import { PreviewOnly } from './preview-only'
import { canvasPageName, useArtifact, useArtifactStates, useListsRead } from './use-artifact'
import { useComments } from './use-comments'
import { useVersions } from './use-versions'
import { VersionHistory } from './version-history'
import {
  ArtifactSurface,
  BarButton,
  CanvasBarControls,
  DaysLeft,
  EarlierDetails,
  EditToolbar,
  StatusBar,
  VersionChip,
  ViewerEmpty,
  ViewerTitle,
} from './viewer-parts'

/** The bar over the page, for an earlier version or one in Recently deleted, and a gap under it. */
const BAR_ROOM = 64
/** The floating toolbar under a canvas, beyond the room a fit already leaves. */
const TOOLBAR_ROOM = 32

/** The viewer's Back: to what the main area showed before the artifact. */
function leaveArtifact(): void {
  const { main } = useViewStore.getState()
  if (main.kind === 'artifact') backTo(main.back, closeArtifact)
}

type Panel = 'history' | 'comments'

/** A page's size for its image: a canvas page's own, or a single page at the area's. */
function clampSize(width: number, height: number): { width: number; height: number } {
  const clamp = (n: number) => Math.min(8_000, Math.max(64, Math.round(n)))
  return { width: clamp(width), height: clamp(height) }
}

/**
 * An artifact in the main area, live, away from the app and the machine: a single page at the
 * area's size, or a canvas of its pages; beside it, on request, its version history.
 */
export default function ArtifactViewer({ id, history }: { id: string; history: boolean }) {
  const { t } = useTranslation(['artifacts', 'common'])
  const [picked, setPicked] = useState<number | null>(null)
  const [panel, setPanel] = useState<Panel | null>(history ? 'history' : null)
  const historyOpen = panel === 'history'
  const setHistoryOpen = (open: boolean) => setPanel(open ? 'history' : null)
  const [presenting, setPresenting] = useState<number | null>(null)
  const area = useRef<HTMLDivElement>(null)
  const [since] = useState(() => performance.now())
  const artifact = useArtifact(id, picked)
  const listsRead = useListsRead()
  const controls = useMemo(() => new CanvasControls(), [])
  const { summary, shown, url } = artifact
  const head = summary?.version ?? null
  const { versions, error: versionsError } = useVersions(id, head)
  const backToList = useViewStore(
    (s) => s.main.kind === 'artifact' && s.main.back.kind === 'artifacts',
  )
  const states = useArtifactStates(artifact, listsRead)
  const earlier = picked !== null && head !== null && picked < head ? picked : null
  const title = summary?.title ?? shown?.title ?? ''
  // Publishing takes the account the host keeps, which the daemon has none of.
  const shares = useHostHas('sharing') === true
  // Only a desktop host renders a page apart from the window.
  const renders = useHostHas('thumbnails') === true
  const editor = useMemo(() => (url ? new ArtifactEditor(url.slice(0, -1)) : null), [url])
  useEffect(() => () => editor?.dispose(), [editor])
  const editing = useEditorState(editor)
  const { threads, error: commentsError } = useComments(id)
  const canvasState = useCanvasState(controls)
  // A version just written counts as the latest while it loads, so editing goes on across it.
  const latest = !!shown && earlier === null && !states.inTrash
  // A canvas document: the latest is edited live on the host, an earlier one only shown.
  const docShown = shown?.doc ?? null
  const legacyCanvas = !!shown?.canvas && !docShown
  const liveCanvas = useCanvasDoc(id, latest && (!!docShown || legacyCanvas))
  const shownCanvas = useMemo(
    () => (latest || !docShown ? liveCanvas : staticCanvas(docShown)),
    [latest, docShown, liveCanvas],
  )
  const [following, setFollowing] = useState<string | null>(null)
  const agents = usePresentAgents(artifact.presence, summary?.deletedAt != null)
  const followingNow = following && agents.some((a) => a.sessionId === following) ? following : null
  const pageTitle = useCallback(
    (page: string | null) =>
      page ? (shownCanvas.doc?.pages.find((p) => p.id === page)?.name ?? null) : null,
    [shownCanvas.doc],
  )
  // Comment mode shows the comments, unless the history was chosen over them.
  const shownPanel: Panel | null =
    editing.mode === 'comment' && panel !== 'history' ? 'comments' : panel
  const pinsShown = latest && (shownPanel === 'comments' || editing.mode === 'comment')

  useEffect(() => {
    if (!editor || !shown) return
    editor.setPins(pinsShown ? pinsOf(threads, shown) : () => [])
  }, [editor, shown, threads, pinsShown])

  // Only the latest version, outside Recently deleted, is commented on and edited; a new version
  // arriving keeps the mode. A canvas is in select mode unless another is chosen, while a single
  // page, or a canvas page in focus, stays live for its own clicks.
  const leftLatest = earlier !== null || states.inTrash
  const selects = !!shown?.canvas && !docShown && canvasState.focused === null
  useEffect(() => {
    if (!editor) return
    editor.setBase(!leftLatest && selects ? 'select' : null)
    if (leftLatest) editor.setMode(null)
  }, [leftLatest, selects, editor])

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
        .png(id, shown.version, page ? { group: page.group, index: page.index } : null, size, name)
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
  // A canvas document's pages by their place in reading order, which present and PNG number.
  const indexOf = useCallback(
    (pageId: string) => shown?.canvas?.pages.findIndex((p) => p.id === pageId) ?? -1,
    [shown],
  )
  const docActions = useMemo<DocPageActions>(
    () => ({
      download: renders
        ? (page) => {
            const index = indexOf(page.id)
            if (index >= 0) downloadPng(index)
          }
        : null,
      present: (page) => setPresenting(Math.max(0, indexOf(page.id))),
      handOff: (ids) => {
        const doc = shownCanvas.doc
        if (!doc || !summary || !shown) return
        const first = ids[0]
        const canvas =
          doc.pages.find((p) => p.id === first)?.canvas ??
          doc.notes.find((n) => n.id === first)?.canvas ??
          doc.sections.find((x) => x.id === first)?.canvas ??
          doc.canvases[0]!.id
        const session =
          agents.find((a) => a.doing && a.doing !== 'read')?.sessionId ?? summary.sessionId ?? null
        void handOff({
          artifact: { id, title, version: shown.version, project: summary.project },
          layout: docLayout(doc, canvas),
          ids,
          session: session || null,
        })
          .then((sent) => {
            if (sent) toast(t('board.handedOff'), undefined, { tone: 'success' })
          })
          .catch((error: unknown) =>
            toast(t('board.handOffFailed', { error: errorMessage(error) }), undefined, {
              tone: 'warning',
            }),
          )
      },
    }),
    [renders, indexOf, downloadPng, shownCanvas.doc, summary, shown, agents, id, title, t],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // Keys typed in the page stay there; Esc goes back only from the app's own page.
      if (event.defaultPrevented || isEditable(event.target)) return
      const modeKey = isModeKey(event)
      if (modeKey && editor && latest) {
        event.preventDefault()
        editor.toggle(modeKey)
        return
      }
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (!editor?.escape()) leaveArtifact()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [editor, latest])

  const failed = (error: unknown): void => console.error(`Could not change ${id}`, error)

  let bar: React.ReactNode = null
  if (shown && earlier !== null && head !== null) {
    const record = versions?.find((v) => v.version === earlier)
    bar = (
      <StatusBar
        lead={t('viewer.earlierLead', { version: earlier, head })}
        rest={record ? <EarlierDetails createdAt={record.createdAt} note={record.note} /> : null}
        action={t('viewer.restoreVersion')}
        onAction={() => restoreVersion(id, earlier, head).then(() => setPicked(null), failed)}
      />
    )
  } else if (states.inTrash && summary?.deletedAt != null) {
    bar = (
      <StatusBar
        lead={t('viewer.inTrash')}
        rest={<DaysLeft deletedAt={summary.deletedAt} />}
        action={t('menu.restore')}
        onAction={() => void restoreArtifact(id).catch(failed)}
      />
    )
  }

  let body: React.ReactNode
  if (states.error === 'previewOnly') {
    body = <PreviewOnly summary={summary ?? null} />
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
        <Button
          variant="secondary"
          size="sm"
          icon={<Icon icon={ArrowLeft01Icon} size={14} />}
          onClick={leaveArtifact}
        >
          {t('viewer.back')}
        </Button>
        <Button size="sm" onClick={() => void restoreArtifact(id).catch(failed)}>
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
    if (!bar && latest && legacyCanvas && liveCanvas.legacy) {
      bar = (
        <StatusBar
          lead={t('board.legacy')}
          rest={null}
          action={t('board.legacySplit')}
          onAction={() => {
            const sheet = 'canvas-1'
            liveCanvas.start([{ op: 'set', id: sheet, key: 'name', value: 'Canvas 1' }])
          }}
        />
      )
    }
    body = (
      <>
        {docShown ? (
          <CanvasEditor
            artifactId={id}
            url={url}
            version={shown.version}
            title={title}
            canvas={shownCanvas}
            files={shown.paths}
            readOnly={!latest}
            controls={controls}
            top={bar ? BAR_ROOM : 0}
            editor={latest ? (editor ?? undefined) : undefined}
            actions={docActions}
            agents={latest ? agents : []}
            following={followingNow}
            onFollowDone={() => setFollowing(null)}
            onViewPage={(page) => void host('artifacts.view', { id, page }).catch(() => {})}
            sessionName={(session) =>
              agents.find((a) => a.sessionId === session)?.name ?? t('board.note.you')
            }
            reloads={artifact.reloads}
          />
        ) : (
          <ArtifactSurface
            url={url}
            shown={shown}
            title={title}
            reloads={artifact.reloads}
            since={since}
            controls={controls}
            top={bar ? BAR_ROOM : 0}
            bottom={TOOLBAR_ROOM}
            onEscape={leaveArtifact}
            editor={latest ? (editor ?? undefined) : undefined}
            actions={actions}
          />
        )}
        {!docShown && (
          <EditToolbar
            editor={latest ? editor : null}
            controls={shown.canvas ? controls : null}
            aside={!!summary?.type}
          />
        )}
        {editor && editing.mode === 'comment' && editing.picked?.point && (
          <CommentBox
            key={`${editing.picked.point.x},${editing.picked.point.y}`}
            anchor={anchorOf(editing.picked, shown)}
            point={editing.picked.point}
            onCancel={() => editor.clearPick()}
            onSubmit={async (body) => {
              await host('artifacts.comment', {
                id,
                anchor: anchorOf(editing.picked!, shown),
                body,
              })
              editor.clearPick()
            }}
          />
        )}
        {bar}
      </>
    )
  } else {
    body = <Waiting since={since} />
  }

  const showing = !!(url && shown) && !states.error && !states.gone && !artifact.stopped
  const closeHistory = () => {
    setHistoryOpen(false)
    setPicked(null)
  }
  const choosePanel = (next: Panel) => {
    if (next !== 'history') setPicked(null)
    setPanel(next)
  }
  // Closing the column leaves comment mode too, which would show the comments again.
  const closeColumn = () => {
    closeHistory()
    if (editing.mode === 'comment') editor?.toggle('comment')
  }
  const openThreads = threads?.filter((thread) => thread.resolvedAt === null).length ?? 0
  const sideHead = (
    <div className="k-av-side__head">
      <SegmentedControl<Panel>
        kind="tabs"
        variant="tray"
        size="sm"
        aria-label={t('viewer.sideLabel')}
        value={shownPanel ?? undefined}
        onChange={choosePanel}
        options={[
          { value: 'history', label: t('viewer.history') },
          {
            value: 'comments',
            label: t('comments.title'),
            count: openThreads > 0 ? openThreads : undefined,
          },
        ]}
      />
      <BarButton
        label={t('common:actions.close')}
        size="group"
        icon={Cancel01Icon}
        onClick={closeColumn}
      />
    </div>
  )
  const editingPicked = editing.mode === 'select' && editing.picked && editor && shown && head
  let column: React.ReactNode = null
  if (editingPicked) {
    column = (
      <EditPanel
        key={`${editing.picked!.page}:${editing.picked!.selection.path}:${editing.picked!.selection.src}`}
        id={id}
        version={shown.version}
        editable={states.inTrash ? 'deleted' : earlier !== null ? 'earlier' : 'yes'}
        picked={editing.picked!}
        editor={editor}
      />
    )
  } else if (shownPanel === 'history') {
    column = (
      <VersionHistory
        versions={versions}
        error={versionsError}
        shown={picked}
        onPick={(version) => setPicked(version === head ? null : version)}
        header={sideHead}
      />
    )
  } else if (shownPanel === 'comments' && summary) {
    column = (
      <aside aria-label={t('comments.title')} className="k-av-side">
        {sideHead}
        <CommentsPanel
          artifact={{ id, title, version: head ?? summary.version, project: summary.project }}
          threads={threads}
          error={commentsError}
          preferred={[
            ...(artifact.presence?.sessions.filter((s) => s.editing).map((s) => s.sessionId) ?? []),
            summary.sessionId,
          ]}
          onFocus={(thread) => {
            const number = thread.anchor.page?.number
            const index = shown?.canvas?.pages.findIndex((p) => p.number === number) ?? -1
            if (index >= 0) controls.commands?.focus(index)
          }}
        />
      </aside>
    )
  }
  const kind = summary ? artifactKind(summary) : null
  const toggleHistory = () => (historyOpen ? closeHistory() : setHistoryOpen(true))

  return (
    <div className="k-av">
      <TopBar>
        <NoDrag className="k-av__crumbs">
          <Tooltip>
            <TooltipTrigger
              render={<button type="button" onClick={leaveArtifact} className="k-av__back" />}
            >
              <Icon icon={ArrowLeft01Icon} size={15} />
              {backToList ? t('page.title') : t('viewer.back')}
            </TooltipTrigger>
            <TooltipContent>
              {backToList ? t('page.backToArtifacts') : t('viewer.back')}{' '}
              <span className="opacity-60">Esc</span>
            </TooltipContent>
          </Tooltip>
          {(kind || title) && <i aria-hidden>/</i>}
          {kind && (
            <span aria-hidden className="k-av__mark" data-kind={kind}>
              <Icon icon={KIND_ICON[kind]} size={15} />
            </span>
          )}
          <ViewerTitle title={title} controls={controls} pageName={showing ? pageName : null} />
          {shown && (
            <VersionChip
              version={shown.version}
              at={versions?.find((v) => v.version === shown.version)?.createdAt ?? null}
              open={historyOpen}
              onClick={toggleHistory}
            />
          )}
          {summary && (
            <ArtifactMoreButton
              target={{
                id,
                title,
                version: shown?.version ?? summary.version,
                versions: summary.version,
                files: shown?.files ?? summary.files,
                sessionId: summary.sessionId,
                deletedAt: summary.deletedAt,
                type: summary.type,
              }}
              onReload={artifact.reload}
              historyOpen={historyOpen}
              onVersionHistory={toggleHistory}
              onDeleted={closeArtifact}
              onDownloadPng={
                renders && shown && !shown.canvas ? () => downloadPng(null) : undefined
              }
            />
          )}
        </NoDrag>
        <span className="k-av__gap" />
        {showing && (
          <NoDrag className="k-av__tools">
            <AgentCursorStyles />
            <PresenceFaces
              agents={agents}
              presence={artifact.presence}
              pageName={pageTitle}
              following={followingNow}
              onFollow={setFollowing}
            />
            {pageName && <CanvasBarControls controls={controls} pageName={pageName} />}
            {/* A type's viewer presents its content itself, as a deck does. */}
            {shown && !summary?.type && (
              <BarButton
                label={t('viewer.present')}
                icon={PlayIcon}
                onClick={() => setPresenting(shown.canvas ? canvasState.selected : 0)}
              />
            )}
            {/* The web client shows it in a browser already; a type's viewer needs Kettu. */}
            {shown && !isWeb && !summary?.type && (
              <BarButton
                label={t('viewer.openInBrowser')}
                icon={LinkSquare02Icon}
                onClick={() =>
                  void window.kettu.artifacts
                    .openExternal(id, shown.version)
                    .catch((error: unknown) => console.error(`Could not open ${id}`, error))
                }
              />
            )}
            <BarButton
              label={t('viewer.history')}
              icon={Clock01Icon}
              pressed={historyOpen}
              onClick={toggleHistory}
            />
            {shown && shares && (
              <ShareButton
                id={id}
                title={title}
                shown={shown.version}
                head={head ?? shown.version}
              />
            )}
          </NoDrag>
        )}
      </TopBar>
      <div className="k-av__body">
        <div ref={area} className="k-av__area">
          {body}
        </div>
        {column}
      </div>
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
