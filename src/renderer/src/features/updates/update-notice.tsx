import type { ReactNode } from 'react'
import { CircleArrowUpIcon, CircleCheckIcon, ExternalLinkIcon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { releaseUrl, type UpdateStatus } from '@shared/updates'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { Progress } from '@renderer/components/ui/progress'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { errorMessage } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { useUpdatesStore } from '@renderer/stores/updates'

type Notice =
  | { kind: 'ready'; version: string }
  | { kind: 'available'; version: string }
  | { kind: 'link'; version: string; downloadUrl: string | null }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'updated'; version: string }

/** Which notice the footer shows, if any: only when there is something to do. */
function noticeFor(status: UpdateStatus | null, updatedSeen: boolean): Notice | null {
  if (!status) return null
  const { state } = status
  if (state.kind === 'downloading' && state.manual && status.dismissed !== state.version)
    return { kind: 'downloading', version: state.version, percent: state.percent }
  if (state.kind === 'ready' && status.dismissed !== state.version)
    return { kind: 'ready', version: state.version }
  if (state.kind === 'available' && status.dismissed !== state.version) {
    return state.mode === 'install'
      ? { kind: 'available', version: state.version }
      : { kind: 'link', version: state.version, downloadUrl: state.downloadUrl }
  }
  if (status.updatedFrom && !updatedSeen) return { kind: 'updated', version: status.current }
  return null
}

interface NoticeCardProps {
  /** The full text the card explains on hover. */
  tooltip: string
  /** Called when the corner dismiss button is pressed. */
  onDismiss?: () => void
  /** Replaces the dismiss button while a download runs, and stays visible. */
  onCancel?: () => void
  /** Set when the card itself opens something; it is a button then. */
  onClick?: () => void
  /** The card's row: its mark or icon, words and value. */
  children: ReactNode
}

/** The footer's raised notice card, with its tooltip and corner dismiss button. */
export function NoticeCard({ tooltip, onDismiss, onCancel, onClick, children }: NoticeCardProps) {
  const { t } = useTranslation('updates')
  const row =
    'flex min-h-9 items-center gap-2 rounded-[8px] bg-card pr-1.5 pl-2.5 text-xs shadow-card'
  const card = onClick ? (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        row,
        'w-full text-left outline-none transition-colors duration-(--duration-fast) hover:bg-hover focus-ring',
      )}
    >
      {children}
    </button>
  ) : (
    <div className={row}>{children}</div>
  )

  const close = onCancel ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="outline"
            size="icon-xs"
            aria-label={t('notice.cancel')}
            onClick={onCancel}
            className="absolute -top-2 -right-1.5 size-4 rounded-full text-icon hover:text-primary"
          />
        }
      >
        <XIcon />
      </TooltipTrigger>
      <TooltipContent side="top">{t('notice.cancel')}</TooltipContent>
    </Tooltip>
  ) : (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="outline"
            size="icon-xs"
            aria-label={t('notice.dismiss')}
            onClick={onDismiss}
            className="absolute -top-2 -right-1.5 size-4 rounded-full text-icon opacity-0 transition-opacity duration-(--duration-fast) group-focus-within/update:opacity-100 group-hover/update:opacity-100 hover:text-primary focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
          />
        }
      >
        <XIcon />
      </TooltipTrigger>
      <TooltipContent side="top">{t('notice.dismiss')}</TooltipContent>
    </Tooltip>
  )

  // The corner button is a sibling of the card, so its own tooltip replaces the card's.
  return (
    <div
      role="status"
      className="group/update relative animate-in not-first:mt-1.5 animation-duration-(--duration-slow) ease-out-quint fade-in slide-in-from-bottom-1"
    >
      <Tooltip>
        <TooltipTrigger render={card} delay={500} />
        <TooltipContent side="top" align="start" className="max-w-64">
          {tooltip}
        </TooltipContent>
      </Tooltip>
      {onCancel || onDismiss ? close : null}
    </div>
  )
}

/** The update notice: a raised, neutral row in the sidebar footer, above Settings. */
export function UpdateNotice() {
  const { t } = useTranslation('updates')
  const status = useUpdatesStore((s) => s.status)
  const updatedDismissed = useUpdatesStore((s) => s.updatedDismissed)
  const notice = noticeFor(status, updatedDismissed)
  if (!notice) return null

  const dismiss = () => {
    if (notice.kind === 'updated') useUpdatesStore.setState({ updatedDismissed: true })
    else void window.overbench.updates.dismiss()
  }

  const download = () => {
    void window.overbench.updates
      .download()
      .catch((error: unknown) =>
        console.warn(`Could not download the update: ${errorMessage(error)}`),
      )
  }

  const version = (
    <span className="shrink-0 font-mono text-meta text-tertiary tabular">{notice.version}</span>
  )

  const tooltip =
    notice.kind === 'ready'
      ? t('notice.readyTooltip', { version: notice.version })
      : notice.kind === 'available'
        ? t('notice.updateTooltip', { version: notice.version })
        : notice.kind === 'downloading'
          ? t('notice.downloadingTooltip', { version: notice.version })
          : notice.kind === 'link'
            ? t('notice.availableTooltip', { version: notice.version })
            : t('notice.updatedTooltip', { version: notice.version })

  return (
    <NoticeCard
      tooltip={tooltip}
      onDismiss={notice.kind === 'downloading' ? undefined : dismiss}
      onCancel={
        notice.kind === 'downloading' ? () => void window.overbench.updates.cancel() : undefined
      }
    >
      {notice.kind === 'updated' ? (
        <CircleCheckIcon className="size-[15px] shrink-0 text-success" />
      ) : (
        <CircleArrowUpIcon className="size-[15px] shrink-0 text-info" />
      )}
      {notice.kind === 'downloading' ? (
        <span className="flex min-w-0 flex-1 flex-col gap-1 py-0.5">
          <span className="@container/notice flex min-w-0 items-baseline gap-1.5 whitespace-nowrap">
            <span className="truncate font-medium @max-[4.5rem]/notice:sr-only">
              {t('notice.downloading')}
            </span>
            {version}
          </span>
          <span className="flex items-center gap-2">
            <Progress
              value={notice.percent}
              aria-label={t('notice.downloadProgress')}
              className="min-w-0 flex-1"
            />
            <span className="w-8 shrink-0 text-right font-mono text-meta text-tertiary tabular">
              {notice.percent}%
            </span>
          </span>
        </span>
      ) : (
        <span className="@container/notice flex min-w-0 flex-1 items-baseline gap-1.5 whitespace-nowrap">
          {notice.kind === 'ready' && (
            <>
              <span className="truncate font-medium @max-[7.5rem]/notice:sr-only">
                {t('notice.ready')}
              </span>
              {version}
            </>
          )}
          {(notice.kind === 'available' || notice.kind === 'link') && (
            <>
              {version}
              <span className="truncate font-medium @max-[5rem]/notice:sr-only">
                {t('notice.available')}
              </span>
            </>
          )}
          {notice.kind === 'updated' && (
            <>
              <span className="truncate font-medium @max-[6.5rem]/notice:sr-only">
                {t('notice.updatedTo')}
              </span>
              {version}
            </>
          )}
        </span>
      )}
      <span className="inline-flex shrink-0 items-center gap-0.5">
        {notice.kind === 'ready' && (
          <Button
            variant="outline"
            size="xs"
            onClick={() => void window.overbench.updates.restart()}
          >
            {t('notice.restart')}
          </Button>
        )}
        {notice.kind === 'available' && (
          <Button variant="outline" size="xs" onClick={download}>
            {t('notice.update')}
          </Button>
        )}
        {notice.kind === 'link' && (
          <a
            href={notice.downloadUrl ?? releaseUrl(notice.version)}
            target="_blank"
            rel="noreferrer"
            className={cn(buttonVariants({ variant: 'outline', size: 'xs' }))}
          >
            <ExternalLinkIcon data-icon="inline-start" />
            {t('notice.download')}
          </a>
        )}
        {notice.kind === 'updated' && (
          <a
            href={releaseUrl(notice.version)}
            target="_blank"
            rel="noreferrer"
            className={cn(buttonVariants({ variant: 'ghost', size: 'xs' }))}
          >
            {t('notice.whatsNew')}
          </a>
        )}
      </span>
    </NoticeCard>
  )
}
