import { cloneElement, type ReactElement, type ReactNode, type Ref } from 'react'
import { CircleArrowUpIcon, CircleCheckIcon, ExternalLinkIcon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { Progress } from '@renderer/components/ui/progress'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { errorMessage } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { useUpdatesStore } from '@renderer/stores/updates'
import { appUpdateRow, cardAction, type AppUpdateAction, type AppUpdateNotice } from './app-updates'

interface NoticeCardProps {
  /** The card itself, which a popover beside it anchors to. */
  ref?: Ref<HTMLDivElement>
  /** The 14 px icon or agent mark. */
  icon: ReactNode
  /** The words and the version; they wrap, never inside a version. */
  text: ReactNode
  /** The words as one string, the card's name. */
  label: string
  /** What the notice is about, in the card's tooltip. */
  detail?: string | null
  /** Opens what the notice is about. */
  onOpen?: () => void
  /** Wraps the card's button, such as the trigger of a popover beside the card. */
  opener?: ReactElement<{ render?: ReactElement }>
  /** The card's one action, a small secondary button. */
  action?: ReactNode
  /** A line under the words, such as a download's progress. */
  below?: ReactNode
  onDismiss?: () => void
  /** Stops what the notice shows, in the dismiss button's place, which then always shows. */
  onCancel?: () => void
  /** The cancel button's name; "Cancel update" by default. */
  cancelLabel?: string
}

/** A notice in the sidebar footer: a raised card above Settings. */
export function NoticeCard({
  ref,
  icon,
  text,
  label,
  detail,
  onOpen,
  opener,
  action,
  below,
  onDismiss,
  onCancel,
  cancelLabel,
}: NoticeCardProps) {
  const { t } = useTranslation('updates')
  const close = onCancel ?? onDismiss
  const closeLabel = onCancel ? (cancelLabel ?? t('notice.cancel')) : t('notice.dismiss')
  const opens = !!(onOpen || opener)
  const hit = (
    <button
      type="button"
      data-notice-hit=""
      aria-label={label}
      aria-description={detail ?? undefined}
      onClick={onOpen}
      className="absolute inset-0 rounded-xl outline-none focus-ring"
    />
  )
  return (
    <div
      data-notice=""
      className="group/notice relative animate-in fade-in slide-in-from-bottom-1 animation-duration-(--duration-slow) ease-out-quint"
    >
      <div
        ref={ref}
        className={cn(
          'relative flex min-h-11 items-center gap-2 rounded-xl bg-surface py-1.5 pr-1.5 pl-3 shadow-card transition-shadow duration-(--duration-fast)',
          opens &&
            'has-[>[data-notice-hit]:hover]:shadow-outline-hover has-data-popup-open:shadow-outline-hover',
        )}
      >
        {/* Buttons cannot nest, so the card opens through a button laid under its content. */}
        {opens && (
          <Tooltip disabled={!detail}>
            <TooltipTrigger
              render={opener ? cloneElement(opener, { render: hit }) : hit}
              delay={500}
            />
            <TooltipContent side="top" align="start" className="max-w-64">
              {detail}
            </TooltipContent>
          </Tooltip>
        )}
        {/* Beside a second line the icon keeps to the first. */}
        <span
          className={cn(
            'pointer-events-none relative grid size-3.5 shrink-0 place-items-center',
            below && 'mt-0.75 self-start',
          )}
        >
          {icon}
        </span>
        <span className="pointer-events-none relative flex min-w-0 flex-1 flex-col gap-1 py-0.5">
          <span className="text-command leading-4 font-medium text-pretty">{text}</span>
          {below}
        </span>
        {action && <span className="relative flex shrink-0 items-center">{action}</span>}
      </div>
      {close && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="icon-xs"
                aria-label={closeLabel}
                onClick={close}
                className={cn(
                  'absolute -top-1.5 -right-1.5 size-5 rounded-full text-icon hover:text-primary [&_svg:not([class*=size-])]:size-3',
                  !onCancel &&
                    'opacity-0 transition-opacity duration-(--duration-fast) group-focus-within/notice:opacity-100 group-hover/notice:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100',
                )}
              />
            }
          >
            <XIcon />
          </TooltipTrigger>
          <TooltipContent>{closeLabel}</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

/** A version beside a notice's words, which never breaks across lines. */
export function NoticeVersion({ children }: { children: ReactNode }) {
  return <span className="font-normal whitespace-nowrap text-tertiary tabular">{children}</span>
}

/** The app's update notice as a card: an update ready, on offer, downloading or just installed. */
export function UpdateNoticeCard({ notice }: { notice: AppUpdateNotice }) {
  const { t } = useTranslation('updates')
  const row = appUpdateRow(notice)
  const version = <NoticeVersion>{notice.version}</NoticeVersion>

  const dismiss = () => {
    if (notice.kind === 'updated') useUpdatesStore.setState({ updatedDismissed: true })
    else void window.kettu.updates.dismiss()
  }

  const run = (action: AppUpdateAction | null) => {
    switch (action) {
      case 'restart':
        void window.kettu.updates.restart()
        break
      case 'update':
        void window.kettu.updates
          .download()
          .catch((error: unknown) =>
            console.warn(`Could not download the update: ${errorMessage(error)}`),
          )
        break
      case 'download':
      case 'whats-new':
        if (row.href) window.open(row.href, '_blank', 'noopener')
        break
    }
  }
  const hit = cardAction(row)

  // A download in progress is cancelled from the card's corner, so it has no action of its own.
  const action =
    row.action === null || row.action === 'cancel' ? null : row.href ? (
      <a
        href={row.href}
        target="_blank"
        rel="noreferrer"
        className={buttonVariants({ variant: 'outline', size: 'xs' })}
      >
        {row.action === 'download' && <ExternalLinkIcon data-icon="inline-start" />}
        {row.actionLabel}
      </a>
    ) : (
      <Button size="xs" onClick={() => run(row.action)}>
        {row.actionLabel}
      </Button>
    )

  return (
    <NoticeCard
      icon={
        notice.kind === 'updated' ? (
          <CircleCheckIcon className="size-3.5 text-success" />
        ) : notice.kind === 'moving' ? (
          <Spinner aria-hidden className="size-3.5 text-info" />
        ) : (
          <CircleArrowUpIcon className="size-3.5 text-info" />
        )
      }
      text={
        notice.kind === 'moving' ? (
          row.words
        ) : row.versionFirst ? (
          <>
            {version} {row.words}
          </>
        ) : (
          <>
            {row.words} {version}
          </>
        )
      }
      label={row.label}
      detail={row.detail}
      below={
        notice.kind === 'downloading' ? (
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
        ) : (
          row.note && <span className="text-meta leading-4 text-tertiary">{row.note}</span>
        )
      }
      onOpen={hit ? () => run(hit) : undefined}
      action={action}
      onDismiss={row.dismissible ? dismiss : undefined}
      onCancel={row.action === 'cancel' ? () => void window.kettu.updates.cancel() : undefined}
    />
  )
}
