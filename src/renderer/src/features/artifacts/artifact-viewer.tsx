import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeftIcon,
  ChevronLeftIcon,
  CircleAlertIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  HistoryIcon,
  PlayIcon,
  TrashIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { backTo } from '@renderer/app/history'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@renderer/components/ui/empty'
import { Tabs, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import { toast } from '@renderer/components/ui/toast'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { NoDrag, TopBar } from '@renderer/features/shell/top-bar'
import { errorMessage, host } from '@renderer/lib/host'
import { useHostHas } from '@renderer/lib/host-features'
import { isWeb } from '@renderer/lib/platform'
import { restoreArtifact, restoreVersion } from '@renderer/stores/artifacts'
import { closeArtifact, useViewStore } from '@renderer/stores/view'
import { anchorOf, pinsOf } from './anchors'
import { ArtifactMenuItems } from './artifact-menu'
import { ShareButton } from './share-popover'
import { CanvasControls, useCanvasState } from './canvas-controls'
import type { PageActions } from './canvas-view'
import { CommentBox, CommentsPanel } from './comments'
import { EditPanel } from './edit-panel'
import { ArtifactEditor, useEditorState } from './editor'
import { isEditable, isModeKey } from './keys'
import { Waiting } from './page-frame'
import { Presenter } from './present'
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
  Presence,
  StatusBar,
  VersionChip,
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
  const { t } = useTranslation('artifacts')
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
  const latest = !!shown && head !== null && shown.version === head && !states.inTrash
  // Comment mode shows the comments, unless the history was chosen over them.
  const shownPanel: Panel | null =
    editing.mode === 'comment' && panel !== 'history' ? 'comments' : panel
  const pinsShown = latest && (shownPanel === 'comments' || editing.mode === 'comment')

  useEffect(() => {
    if (!editor || !shown) return
    editor.setPins(pinsShown ? pinsOf(threads, shown) : () => [])
  }, [editor, shown, threads, pinsShown])

  // Only the latest version, outside Recently deleted, is commented on and edited; a new version
  // arriving keeps the mode.
  const leftLatest = earlier !== null || states.inTrash
  useEffect(() => {
    if (leftLatest) editor?.setMode(null)
  }, [leftLatest, editor])

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
      if (editor && editor.get().mode) editor.setMode(null)
      else leaveArtifact()
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
  if (states.error) {
    body = (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CircleAlertIcon className="text-danger" />
          </EmptyMedia>
          <EmptyTitle>{t('viewer.errorTitle')}</EmptyTitle>
          <EmptyDescription>{t(`viewer.error.${states.error}`)}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" size="compact" onClick={artifact.retry}>
            {t('viewer.retry')}
          </Button>
        </EmptyContent>
      </Empty>
    )
  } else if (states.gone) {
    body = (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TrashIcon />
          </EmptyMedia>
          <EmptyTitle>{t('viewer.goneTitle')}</EmptyTitle>
          <EmptyDescription>{t('viewer.goneDescription')}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row justify-center">
          <Button
            variant="outline"
            size="compact"
            onClick={() => void restoreArtifact(id).catch(failed)}
          >
            {t('menu.restore')}
          </Button>
          <Button variant="outline" size="compact" onClick={leaveArtifact}>
            <ArrowLeftIcon data-icon="inline-start" />
            {t('viewer.back')}
          </Button>
        </EmptyContent>
      </Empty>
    )
  } else if (artifact.stopped) {
    body = (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyTitle>{t('viewer.stoppedTitle')}</EmptyTitle>
          <EmptyDescription>{t('viewer.stoppedDescription')}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" size="compact" onClick={artifact.restart}>
            {t('viewer.reload')}
          </Button>
        </EmptyContent>
      </Empty>
    )
  } else if (url && shown) {
    body = (
      <>
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
        <EditToolbar editor={latest ? editor : null} controls={shown.canvas ? controls : null} />
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
  const tabs = (
    <Tabs value={shownPanel} onValueChange={(next) => choosePanel(next as Panel)}>
      <TabsList className="mx-3 mt-2.5 mb-2">
        <TabsTrigger value="history">{t('viewer.history')}</TabsTrigger>
        <TabsTrigger value="comments">
          {t('comments.title')}
          {threads && threads.some((thread) => thread.resolvedAt === null) && (
            <span className="text-tertiary tabular-nums">
              {threads.filter((thread) => thread.resolvedAt === null).length}
            </span>
          )}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  )
  const editingPicked = editing.mode === 'select' && editing.picked && editor && shown && head
  let column: React.ReactNode = null
  if (editingPicked) {
    column = (
      <EditPanel
        key={`${editing.picked!.page}:${editing.picked!.selection.src}:${shown.version}`}
        id={id}
        version={shown.version}
        head={head}
        editable={states.inTrash ? 'deleted' : shown.version !== head ? 'earlier' : 'yes'}
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
        header={tabs}
      />
    )
  } else if (shownPanel === 'comments' && summary) {
    column = (
      <aside
        aria-label={t('comments.title')}
        className="flex w-80 shrink-0 animate-in flex-col bg-app shadow-[inset_1px_0_0_var(--border-subtle)] fade-in duration-(--duration-fast)"
      >
        {tabs}
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar className="gap-2 pr-2.5 pl-3">
        <NoDrag className="min-w-0 gap-2">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={leaveArtifact}
                  className="flex h-7 shrink-0 items-center gap-1 rounded-tile pr-2 pl-1 text-lede text-tertiary outline-none transition-colors duration-(--duration-fast) hover:bg-hover hover:text-secondary focus-ring"
                />
              }
            >
              <ChevronLeftIcon className="size-4" />
              {backToList ? t('page.title') : t('viewer.back')}
            </TooltipTrigger>
            <TooltipContent>
              {backToList ? t('page.backToArtifacts') : t('viewer.back')}{' '}
              <span className="opacity-60">Esc</span>
            </TooltipContent>
          </Tooltip>
          <span aria-hidden className="text-border-strong">
            /
          </span>
          <ViewerTitle title={title} controls={controls} pageName={showing ? pageName : null} />
          {shown && (
            <VersionChip
              version={shown.version}
              at={versions?.find((v) => v.version === shown.version)?.createdAt ?? null}
              open={historyOpen}
              onClick={() => (historyOpen ? closeHistory() : setHistoryOpen(true))}
            />
          )}
        </NoDrag>
        <span className="min-w-2 flex-1" />
        {showing && (
          <NoDrag className="min-w-0 shrink-0 gap-2">
            <Presence id={id} presence={artifact.presence} deleted={summary?.deletedAt != null} />
            {pageName && <CanvasBarControls controls={controls} pageName={pageName} zoom={false} />}
            {/* A type's viewer presents its content itself, as a deck does. */}
            {shown && !summary?.type && (
              <Button
                variant="quiet"
                size="sm"
                onClick={() => setPresenting(shown.canvas ? canvasState.selected : 0)}
                className="h-7.5 gap-1.5 rounded-tile px-2.5 text-control font-normal text-secondary"
              >
                <PlayIcon data-icon="inline-start" />
                {t('viewer.present')}
              </Button>
            )}
            {shown && shares && (
              <ShareButton
                id={id}
                title={title}
                shown={shown.version}
                head={head ?? shown.version}
              />
            )}
            {/* The web client shows it in a browser already; a type's viewer needs Kettu. */}
            {shown && !isWeb && !summary?.type && (
              <BarButton
                label={t('viewer.openInBrowser')}
                onClick={() =>
                  void window.kettu.artifacts
                    .openExternal(id, shown.version)
                    .catch((error: unknown) => console.error(`Could not open ${id}`, error))
                }
              >
                <ExternalLinkIcon />
              </BarButton>
            )}
            <BarButton
              label={t('viewer.history')}
              pressed={historyOpen}
              onClick={() => (historyOpen ? closeHistory() : setHistoryOpen(true))}
            >
              <HistoryIcon />
            </BarButton>
            {summary && (
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="quiet"
                            size="icon-sm"
                            aria-label={t('viewer.more')}
                            className="size-7.5 rounded-tile text-secondary"
                          />
                        }
                      />
                    }
                  >
                    <EllipsisIcon />
                  </TooltipTrigger>
                  <TooltipContent>{t('viewer.more')}</TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="end" className="min-w-55">
                  <ArtifactMenuItems
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
                    onVersionHistory={() => (historyOpen ? closeHistory() : setHistoryOpen(true))}
                    onDeleted={closeArtifact}
                    onDownloadPng={
                      renders && shown && !shown.canvas ? () => downloadPng(null) : undefined
                    }
                  />
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </NoDrag>
        )}
      </TopBar>
      <div className="flex min-h-0 flex-1">
        <div ref={area} className="relative min-w-0 flex-1 bg-sidebar">
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
