import { Alert02Icon } from '@hugeicons/core-free-icons'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { KnownExpiry } from '@shared/prompt-cache'
import { BackgroundDots, TurnDots } from '@renderer/features/session/turn-dots'
import { Glyph } from '@renderer/features/shell/glyph'
import { cn } from '@renderer/lib/utils'
import { CacheRing } from './cache-status'
import { backgroundText, hasNamedBackground, type RowStatus } from './row-status'

/**
 * One status per row, by priority: waiting for you, error, running (the turn's nine dots), running
 * on in the background, starting, prompt cache expiring, unread (App Shell's blue dot). Its 16 px
 * slot stays when there is none, so a status appearing never moves the title.
 */
export function SessionIndicator({
  status,
  expiring,
  className,
}: {
  status: RowStatus
  /** The session's prompt cache, in its last minutes. */
  expiring: KnownExpiry | null
  className?: string
}) {
  const { t } = useTranslation('sidebar')

  let mark = null
  if (status.waiting > 0) {
    mark = (
      <span
        role="img"
        aria-label={t('indicator.waiting', { count: status.waiting })}
        className="size-2 rounded-full bg-attention-dot shadow-[0_0_0_3px_var(--attention-halo)]"
      />
    )
  } else if (status.failed) {
    mark = (
      <span role="img" aria-label={t('indicator.error')} className="grid text-danger">
        <Glyph icon={Alert02Icon} size={14} />
      </span>
    )
  } else if (status.running) {
    mark = (
      <span role="img" aria-label={t('indicator.running')} className="grid">
        <TurnDots phase="working" />
      </span>
    )
  } else if (status.background) {
    const label = hasNamedBackground(status.background)
      ? t('indicator.background', { work: backgroundText(t, status.background) })
      : t('indicator.backgroundUnnamed')
    mark = (
      <span role="img" aria-label={label} title={label} className="grid">
        <BackgroundDots />
      </span>
    )
  } else if (status.starting) {
    mark = (
      <span role="img" aria-label={t('indicator.starting')} className="grid">
        <TurnDots phase="thinking" />
      </span>
    )
  } else if (expiring) {
    mark = <CacheRing cache={expiring} />
  } else if (status.unread) {
    mark = (
      <span
        role="img"
        aria-label={t('indicator.unread')}
        className="size-1.5 rounded-full bg-(--accent)"
      />
    )
  }

  return (
    <span
      className={cn(
        'ml-auto grid size-4 shrink-0 place-items-center transition-opacity duration-(--duration-fast)',
        className,
      )}
    >
      {mark}
    </span>
  )
}

/**
 * What a row shows after its caret. On plain rows this fades out under the hover tools through a
 * mask; on badged rows its end slot expands on hover so badges slide clear of the tools
 * (styles/affect.css).
 */
export function RowBody({ children }: { children: ReactNode }) {
  return (
    <span className="kettu-row-body flex min-w-0 flex-1 items-center gap-2 self-stretch">
      {children}
    </span>
  )
}

/**
 * The end of a row: its host and status. A project's row keeps the room of its tools here, so they
 * show in its place without moving what comes before.
 */
export function RowEnd({ children }: { children: ReactNode }) {
  return (
    <span className="kettu-row-end ml-auto flex shrink-0 items-center justify-end gap-2 transition-opacity duration-(--duration-fast)">
      {children}
    </span>
  )
}
