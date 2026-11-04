import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  CircleAlertIcon,
  EllipsisIcon,
  Maximize2Icon,
  MessageSquareIcon,
  Minimize2Icon,
  MousePointer2Icon,
  RotateCwIcon,
  TrashIcon,
  XIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ARTIFACT_ENTRY } from '@shared/artifact-files'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { PanelButton } from '@renderer/features/shell/panel-button'
import { SHEET } from '@renderer/features/shell/sheet'
import { CornerControls } from '@renderer/features/shell/top-bar'
import { hasBand } from '@renderer/lib/platform'
import { host } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { restoreArtifact, setPaneSelection, useArtifactsStore } from '@renderer/stores/artifacts'
import { openArtifact, toggleSidePane, useViewStore } from '@renderer/stores/view'
import { anchorOf, pinsOf } from './anchors'
import { ArtifactMenuItems } from './artifact-menu'
import { CanvasControls } from './canvas-controls'
import { CommentBox } from './comments'
import { ArtifactEditor, useEditorState } from './editor'
import { Waiting } from './page-frame'
import { canvasPageName, useArtifact, useArtifactStates, useListsRead } from './use-artifact'
import { useComments } from './use-comments'
import { ArtifactSurface, CanvasBarControls, Presence } from './viewer-parts'

const PRESSED = 'aria-pressed:bg-selected aria-pressed:text-foreground'

/**
 * An artifact beside the thread, opened from a tool call's row, so the page reloads in view while
 * the agent keeps changing it. Esc leaves a focused page and never closes the pane.
 */
export default function ArtifactPane({
  projectPath,
  id,
  maximized,
}: {
  projectPath: string
  id: string
  maximized: boolean
}) {
  const { t } = useTranslation(['artifacts', 'common', 'files'])
  const [since] = useState(() => performance.now())
  const artifact = useArtifact(id, null)
  const listsRead = useListsRead()
  const states = useArtifactStates(artifact, listsRead)
  const controls = useMemo(() => new CanvasControls(), [])
  const cornered = useViewStore((s) => s.sidebarCollapsed) && maximized && !hasBand
  const { summary, shown, url } = artifact
  const title = summary?.title ?? shown?.title ?? ''
  const close = (): void => toggleSidePane(projectPath, 'artifact', false)
  const showing = !!(url && shown) && !states.error && !states.gone && !artifact.stopped
  const editor = useMemo(() => (url ? new ArtifactEditor(url.slice(0, -1)) : null), [url])
  useEffect(() => () => editor?.dispose(), [editor])
  const editing = useEditorState(editor)
  const latest = !!shown && !!summary && shown.version === summary.version && !states.inTrash
  const { threads } = useComments(editing.mode === 'comment' ? id : null)

  useEffect(() => {
    if (!latest) editor?.setMode(null)
  }, [latest, editor])

  useEffect(() => {
    if (!editor || !shown) return
    editor.setPins(editing.mode === 'comment' ? pinsOf(threads, shown) : () => [])
  }, [editor, shown, threads, editing.mode])

  // What is picked here is the context the composer beside it offers, until something else is.
  useEffect(() => {
    if (editing.mode !== 'select' || !editing.picked || !shown) return
    setPaneSelection({
      projectPath,
      artifactId: id,
      title,
      anchor: anchorOf(editing.picked, shown),
    })
  }, [editing.mode, editing.picked, shown, projectPath, id, title])
  const choosePage = useCallback(
    (index: number) => {
      const page = shown?.canvas?.pages[index]
      if (!page || !shown) return
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
      if (useArtifactsStore.getState().paneSelection?.artifactId === id) setPaneSelection(null)
    },
    [id],
  )

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
  } else if (states.gone || states.inTrash) {
    body = (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TrashIcon />
          </EmptyMedia>
          <EmptyTitle>{t('viewer.goneTitle')}</EmptyTitle>
          <EmptyDescription>{t('viewer.goneDescription')}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            variant="outline"
            size="compact"
            onClick={() => void restoreArtifact(id).catch((e: unknown) => console.error(e))}
          >
            {t('menu.restore')}
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
      <ArtifactSurface
        url={url}
        shown={shown}
        title={title}
        reloads={artifact.reloads}
        since={since}
        controls={controls}
        top={0}
        editor={latest ? (editor ?? undefined) : undefined}
        onPageChosen={choosePage}
      />
    )
  } else {
    body = <Waiting since={since} />
  }

  return (
    <section
      aria-label={title || undefined}
      className={cn(
        'flex h-full min-h-0 animate-in flex-col fade-in animation-duration-(--duration-fast)',
        SHEET,
        maximized && 'absolute inset-0 z-10',
      )}
    >
      {/* A window drag region, as the other panes' headers; its controls opt out. */}
      <div
        className={cn(
          'app-region-drag flex h-top-bar shrink-0 items-center gap-0.5 pr-2 pl-3 shadow-[inset_0_calc(-1*var(--hairline))_0_var(--border-subtle)]',
          cornered && 'pl-(--corner-inset)',
        )}
      >
        {cornered && <CornerControls className="mr-1" />}
        <span className="min-w-0 truncate pr-1.5 text-ui font-medium">{title}</span>
        {shown && (
          <span className="shrink-0 text-xs text-secondary tabular-nums">
            {t('viewer.version', { version: shown.version })}
          </span>
        )}
        <span className="min-w-2 flex-1" />
        {showing && (
          <span className="app-region-no-drag flex min-w-0 items-center gap-0.5">
            <Presence
              id={id}
              presence={artifact.presence}
              deleted={summary?.deletedAt != null}
              size="pane"
            />
            {shown?.canvas && (
              <CanvasBarControls
                controls={controls}
                pageName={canvasPageName(shown, (number) => t('canvas.page', { number }))}
                size="pane"
                zoom={false}
              />
            )}
            {latest && editor && (
              <>
                <PanelButton
                  label={t('tools.select')}
                  shortcut="V"
                  pressed={editing.mode === 'select'}
                  className={PRESSED}
                  onClick={() => editor.toggle('select')}
                >
                  <MousePointer2Icon />
                </PanelButton>
                <PanelButton
                  label={t('tools.comment')}
                  shortcut="C"
                  pressed={editing.mode === 'comment'}
                  className={PRESSED}
                  onClick={() => editor.toggle('comment')}
                >
                  <MessageSquareIcon />
                </PanelButton>
              </>
            )}
            <PanelButton label={t('viewer.reload')} onClick={artifact.reload}>
              <RotateCwIcon />
            </PanelButton>
            {summary && (
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <DropdownMenuTrigger
                        render={
                          <Button variant="quiet" size="icon-xs" aria-label={t('viewer.more')} />
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
                    }}
                    onVersionHistory={() => openArtifact(id, { history: true })}
                  />
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </span>
        )}
        <PanelButton
          label={maximized ? t('files:panel.restore') : t('files:panel.maximize')}
          onClick={() => useViewStore.setState({ sidePaneMaximized: !maximized })}
        >
          {maximized ? <Minimize2Icon /> : <Maximize2Icon />}
        </PanelButton>
        <PanelButton label={t('common:actions.close')} onClick={close}>
          <XIcon />
        </PanelButton>
      </div>
      <div className="relative min-h-0 flex-1 bg-background">
        {body}
        {editor && shown && editing.mode === 'comment' && editing.picked?.point && (
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
      </div>
    </section>
  )
}
