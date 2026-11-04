import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeftIcon,
  ChevronLeftIcon,
  CircleAlertIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  HistoryIcon,
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { NoDrag, TopBar } from '@renderer/features/shell/top-bar'
import { useHostHas } from '@renderer/lib/host-features'
import { isWeb } from '@renderer/lib/platform'
import { restoreArtifact, restoreVersion } from '@renderer/stores/artifacts'
import { closeArtifact, useViewStore } from '@renderer/stores/view'
import { ArtifactMenuItems } from './artifact-menu'
import { ShareButton } from './share-popover'
import { CanvasControls } from './canvas-controls'
import { isEditable } from './keys'
import { Waiting } from './page-frame'
import { canvasPageName, useArtifact, useArtifactStates, useListsRead } from './use-artifact'
import { useVersions } from './use-versions'
import { VersionHistory } from './version-history'
import {
  ArtifactSurface,
  BarButton,
  CanvasBarControls,
  DaysLeft,
  EarlierDetails,
  Presence,
  StatusBar,
  VersionChip,
  ViewerTitle,
  ZoomPill,
} from './viewer-parts'

/** The bar over the page, for an earlier version or one in Recently deleted, and a gap under it. */
const BAR_ROOM = 64

/** The viewer's Back: to what the main area showed before the artifact. */
function leaveArtifact(): void {
  const { main } = useViewStore.getState()
  if (main.kind === 'artifact') backTo(main.back, closeArtifact)
}

/**
 * An artifact in the main area, live, away from the app and the machine: a single page at the
 * area's size, or a canvas of its pages; beside it, on request, its version history.
 */
export default function ArtifactViewer({ id, history }: { id: string; history: boolean }) {
  const { t } = useTranslation('artifacts')
  const [picked, setPicked] = useState<number | null>(null)
  const [historyOpen, setHistoryOpen] = useState(history)
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // Keys typed in the page stay there; Esc goes back only from the app's own page.
      if (event.key !== 'Escape' || event.defaultPrevented || isEditable(event.target)) return
      event.preventDefault()
      leaveArtifact()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

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
          onEscape={leaveArtifact}
        />
        {shown.canvas && <ZoomPill controls={controls} />}
        {bar}
      </>
    )
  } else {
    body = <Waiting since={since} />
  }

  const showing = !!(url && shown) && !states.error && !states.gone && !artifact.stopped
  const pageName = shown?.canvas
    ? canvasPageName(shown, (number) => t('canvas.page', { number }))
    : null
  const closeHistory = () => {
    setHistoryOpen(false)
    setPicked(null)
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
                      sessionId: summary.sessionId,
                      deletedAt: summary.deletedAt,
                      type: summary.type,
                    }}
                    onReload={artifact.reload}
                    historyOpen={historyOpen}
                    onVersionHistory={() => (historyOpen ? closeHistory() : setHistoryOpen(true))}
                    onDeleted={closeArtifact}
                  />
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </NoDrag>
        )}
      </TopBar>
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1 bg-sidebar">{body}</div>
        {historyOpen && (
          <VersionHistory
            versions={versions}
            error={versionsError}
            shown={picked}
            onPick={(version) => setPicked(version === head ? null : version)}
          />
        )}
      </div>
    </div>
  )
}
