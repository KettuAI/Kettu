import type { ReactNode } from 'react'
import { CircleArrowUpIcon, CircleCheckIcon, ExternalLinkIcon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { Progress } from '@renderer/components/ui/progress'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { errorMessage } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { useUpdatesStore } from '@renderer/stores/updates'
import { openSettings } from '@renderer/stores/view'
import { appUpdateRow, type AppUpdateNotice } from './app-updates'

interface NoticeCardProps {
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
  /** The card's one action, a small secondary button. */
  action?: ReactNode
  /** A line under the words, such as a download's progress. */
  below?: ReactNode
  onDismiss?: () => void
  /** Stops what the notice shows, in the dismiss button's place, which then always shows. */
  onCancel?: () => void
}

/** A notice in the sidebar footer: a raised card above Settings. */
export function NoticeCard({
  icon,
  text,
  label,
  detail,
  onOpen,
  action,
  below,
  onDismiss,
  onCancel,
}: NoticeCardProps) {
  const { t } = useTranslation('updates')
  const close = onCancel ?? onDismiss
  const closeLabel = onCancel ? t('notice.cancel') : t('notice.dismiss')
  return (
    <div
      data-notice=""
      className="group/notice relative animate-in fade-in slide-in-from-bottom-1 animation-duration-(--duration-slow) ease-out-quint"
    >
      <div
        className={cn(
          'relative flex min-h-11 items-center gap-2 rounded-xl bg-surface py-1.5 pr-1.5 pl-3 shadow-card transition-shadow duration-(--duration-fast)',
          onOpen && 'has-[>[data-notice-hit]:hover]:shadow-outline-hover',
        )}
      >
        {/* Buttons cannot nest, so the card opens through a button laid under its content. */}
        {onOpen && (
          <Tooltip disabled={!detail}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  data-notice-hit=""
                  aria-label={label}
                  aria-description={detail ?? undefined}
                  onClick={onOpen}
                  className="absolute inset-0 rounded-xl outline-none focus-ring"
                />
              }
              delay={500}
            />
            <TooltipContent side="top" align="start" className="max-w-64">
              {detail}
            </TooltipContent>
          </Tooltip>
        )}
        <span className="pointer-events-none relative grid size-3.5 shrink-0 place-items-center">
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
    else void window.overbench.updates.dismiss()
  }

  const run = () => {
    switch (row.action) {
      case 'restart':
        void window.overbench.updates.restart()
        break
      case 'update':
        void window.overbench.updates
          .download()
          .catch((error: unknown) =>
            console.warn(`Could not download the update: ${errorMessage(error)}`),
          )
        break
    }
  }

  // A download in progress is cancelled from the card's corner, so it has no action of its own.
  const action =
    row.action === 'cancel' ? null : row.href ? (
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
      <Button variant="outline" size="xs" onClick={run}>
        {row.actionLabel}
      </Button>
    )

  return (
    <NoticeCard
      icon={
        notice.kind === 'updated' ? (
          <CircleCheckIcon className="size-3.5 text-success" />
        ) : (
          <CircleArrowUpIcon className="size-3.5 text-info" />
        )
      }
      text={
        row.versionFirst ? (
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
        notice.kind === 'downloading' && (
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
        )
      }
      onOpen={() => openSettings('about')}
      action={action}
      onDismiss={row.dismissible ? dismiss : undefined}
      onCancel={row.action === 'cancel' ? () => void window.overbench.updates.cancel() : undefined}
    />
  )
}
