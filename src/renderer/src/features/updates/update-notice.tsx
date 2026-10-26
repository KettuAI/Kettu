import { useContext, useId, type ReactNode } from 'react'
import { CircleArrowUpIcon, CircleCheckIcon, ExternalLinkIcon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { Progress } from '@renderer/components/ui/progress'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { CloseNoticesContext } from '@renderer/features/sidebar/notices'
import { errorMessage } from '@renderer/lib/host'
import { useUpdatesStore } from '@renderer/stores/updates'
import { openSettings } from '@renderer/stores/view'
import { appUpdateRow, type AppUpdateNotice } from './app-updates'

interface NoticeRowProps {
  /** The 16 px icon or agent mark. */
  icon: ReactNode
  /** The first line; it wraps, never inside a version. */
  text: ReactNode
  /** The first line as one string, the row's name. */
  label: string
  /** The muted second line. */
  detail: ReactNode
  /** Opens what the row is about, and closes the popover. */
  onOpen?: () => void
  /** The row's small outline action. */
  action?: ReactNode
  onDismiss?: () => void
}

/** A row in the sidebar's notices popover. */
export function NoticeRow({
  icon,
  text,
  label,
  detail,
  onOpen,
  action,
  onDismiss,
}: NoticeRowProps) {
  const { t } = useTranslation('updates')
  const close = useContext(CloseNoticesContext)
  const detailId = useId()
  return (
    <div
      data-notice-row=""
      className="group/notice relative rounded-lg px-2 py-1.5 transition-colors duration-(--duration-fast) has-[>[data-row-hit]:hover]:bg-hover"
    >
      {/* Buttons cannot nest, so the row opens through a button laid under its content. */}
      {onOpen && (
        <button
          type="button"
          data-row-hit=""
          aria-label={label}
          aria-describedby={detailId}
          onClick={() => {
            close()
            onOpen()
          }}
          className="absolute inset-0 rounded-lg outline-none focus-ring"
        />
      )}
      <div className="pointer-events-none relative grid grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-x-2">
        <span className="flex h-5 items-center justify-center">{icon}</span>
        <span className="text-ui font-medium">{text}</span>
        <span className="pointer-events-auto flex h-5 shrink-0 items-center gap-0.5">
          {action}
          {onDismiss && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t('notice.dismiss')}
                    onClick={onDismiss}
                    className="text-icon opacity-0 transition-opacity duration-(--duration-fast) group-focus-within/notice:opacity-100 group-hover/notice:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                  />
                }
              >
                <XIcon />
              </TooltipTrigger>
              <TooltipContent>{t('notice.dismiss')}</TooltipContent>
            </Tooltip>
          )}
        </span>
        <span id={detailId} className="col-span-2 col-start-2 text-xs text-secondary">
          {detail}
        </span>
      </div>
    </div>
  )
}

/** A version beside a notice's words, which never breaks across lines. */
export function NoticeVersion({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-meta font-normal whitespace-nowrap text-tertiary tabular">
      {children}
    </span>
  )
}

/** The app's update notice as a row: an update ready, on offer, downloading or just installed. */
export function UpdateNoticeRow({ notice }: { notice: AppUpdateNotice }) {
  const { t } = useTranslation('updates')
  const close = useContext(CloseNoticesContext)
  const row = appUpdateRow(notice)
  const version = <NoticeVersion>{notice.version}</NoticeVersion>

  const dismiss = () => {
    if (notice.kind === 'updated') useUpdatesStore.setState({ updatedDismissed: true })
    else void window.overbench.updates.dismiss()
  }

  const run = () => {
    switch (row.action) {
      case 'restart':
        close()
        void window.overbench.updates.restart()
        break
      case 'update':
        void window.overbench.updates
          .download()
          .catch((error: unknown) =>
            console.warn(`Could not download the update: ${errorMessage(error)}`),
          )
        break
      case 'cancel':
        void window.overbench.updates.cancel()
        break
    }
  }

  const action = row.href ? (
    <a
      href={row.href}
      target="_blank"
      rel="noreferrer"
      onClick={close}
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
    <NoticeRow
      icon={
        notice.kind === 'updated' ? (
          <CircleCheckIcon className="size-4 text-success" />
        ) : (
          <CircleArrowUpIcon className="size-4 text-info" />
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
      detail={
        notice.kind === 'downloading' ? (
          <span className="flex items-center gap-2 py-1">
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
          row.detail
        )
      }
      onOpen={() => openSettings('about')}
      action={action}
      onDismiss={row.dismissible ? dismiss : undefined}
    />
  )
}
