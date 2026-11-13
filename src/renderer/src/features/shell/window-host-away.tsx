import type { ReactNode } from 'react'
import { WifiDisconnected01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { connectionText } from '@renderer/features/settings/host-text'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useWindowHostAway } from '@renderer/stores/window-host'
import { Glyph } from './glyph'
import { HostAwayAction } from './host-away-action'

/**
 * The notice a global page shows while the host the window is narrowed to is not connected: what
 * the page shows is what was last read from it, or nothing when it never answered.
 */
export function WindowHostAway({ read, className }: { read: boolean; className?: string }) {
  const { t } = useTranslation('shell')
  const { t: ts } = useTranslation('settings')
  const host = useWindowHostAway()
  const now = useNow()
  if (!host) return null
  return (
    <div
      role="status"
      className={cn(
        'flex items-center gap-3 rounded-[12px] bg-(--tone-amber-fill) py-2.5 pr-2.5 pl-4 shadow-[inset_0_0_0_0.5px_var(--tone-amber-edge)]',
        className,
      )}
    >
      <Glyph icon={WifiDisconnected01Icon} className="shrink-0 text-(--tone-amber)" />
      <span className="grid min-h-8 min-w-0 flex-1 content-center">
        <b className="text-[13px] leading-5 font-medium text-primary">
          {t('windowHost.away', { name: host.name, state: connectionText(ts, host, now) })}
        </b>
        <small className="text-xs text-secondary">
          {t(read ? 'windowHost.lastRead' : 'windowHost.nothingRead')}
        </small>
      </span>
      <HostAwayAction connection={host.connection} className="shrink-0" />
    </div>
  )
}

/** What a page shows of a host that is away: greyed, and out of reach of the pointer and keys. */
export function AwayContent({ away, children }: { away: boolean; children: ReactNode }) {
  return (
    <div inert={away} className={cn('transition-opacity', away && 'opacity-50')}>
      {children}
    </div>
  )
}
