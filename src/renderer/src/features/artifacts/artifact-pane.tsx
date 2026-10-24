import { useMemo, useState } from 'react'
import {
  CircleAlertIcon,
  EllipsisIcon,
  Maximize2Icon,
  Minimize2Icon,
  RefreshCwIcon,
  TrashIcon,
  XIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
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
import { SidebarToggle } from '@renderer/features/shell/top-bar'
import { isMac } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { restoreArtifact } from '@renderer/stores/artifacts'
import { openArtifact, toggleSidePane, useViewStore } from '@renderer/stores/view'
import { ArtifactMenuItems } from './artifact-menu'
import { CanvasControls } from './canvas-controls'
import { Waiting } from './page-frame'
import { canvasPageName, useArtifact, useArtifactStates, useListsRead } from './use-artifact'
import { ArtifactSurface, CanvasBarControls, Presence } from './viewer-parts'

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
  const cornered = useViewStore((s) => s.sidebarCollapsed) && maximized
  const { summary, shown, url } = artifact
  const title = summary?.title ?? shown?.title ?? ''
  const close = (): void => toggleSidePane(projectPath, 'artifact', false)
  const showing = !!(url && shown) && !states.error && !states.gone && !artifact.stopped

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
      />
    )
  } else {
    body = <Waiting since={since} />
  }

  return (
    <section
      aria-label={title || undefined}
      className={cn(
        'flex h-full min-h-0 animate-in flex-col bg-sidebar fade-in animation-duration-(--duration-fast)',
        maximized && 'absolute inset-0 z-10',
      )}
    >
      {/* A window drag region, as the other panes' headers; its controls opt out. */}
      <div
        className={cn(
          'app-region-drag flex h-top-bar shrink-0 items-center gap-0.5 pr-2 pl-3 shadow-[inset_0_calc(-1*var(--hairline))_0_var(--border-subtle)]',
          cornered && (isMac ? 'pl-[calc(32px+var(--traffic-lights))]' : 'pl-2'),
          !isMac && 'pr-[calc(100vw-env(titlebar-area-x,0px)-env(titlebar-area-width,100vw)+8px)]',
        )}
      >
        {cornered && <SidebarToggle className="mr-1" />}
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
            <PanelButton label={t('viewer.reload')} onClick={artifact.reload}>
              <RefreshCwIcon />
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
      <div className="relative min-h-0 flex-1 bg-background">{body}</div>
    </section>
  )
}
