import { useState, type ComponentProps } from 'react'
import { RefreshIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/lib/utils'
import { refreshWebCache } from './cache-refresh'

type ButtonVariant = ComponentProps<typeof Button>['variant']
type ButtonSize = ComponentProps<typeof Button>['size']

function currentWebVersion(): string | null {
  if (typeof window === 'undefined') return null
  return window.kettu?.clientVersion ?? null
}

/**
 * Lightweight button that triggers a non-destructive web cache refresh, used on fallback screens
 * where Settings is unreachable (pairing failures, sign-in, disconnect banners).
 */
export function RefreshCacheButton({
  variant = 'secondary',
  size = 'sm',
  className,
  onRefresh = refreshWebCache,
}: {
  variant?: ButtonVariant
  size?: ButtonSize
  className?: string
  onRefresh?: () => Promise<void> | void
}) {
  const { t } = useTranslation('web')
  const [busy, setBusy] = useState(false)

  const handleClick = (): void => {
    if (busy) return
    setBusy(true)
    void Promise.resolve(onRefresh()).catch(() => setBusy(false))
  }

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      disabled={busy}
      title={t('cache.hint')}
      className={className}
      onClick={handleClick}
    >
      {busy ? (
        <Spinner data-icon="inline-start" className={size === 'xs' ? 'size-3' : undefined} />
      ) : (
        <HugeiconsIcon
          icon={RefreshIcon}
          size={size === 'xs' ? 14 : 15}
          strokeWidth={1.9}
          data-icon="inline-start"
          aria-hidden
        />
      )}
      {t(busy ? 'cache.refreshing' : 'cache.refresh')}
    </Button>
  )
}

/**
 * Subtle footer row with the running web version (when available) and a non-destructive cache
 * refresh link for pairing, sign-in, and launch-error fallback screens.
 */
export function RefreshCacheFooter({
  version = currentWebVersion(),
  className,
  onRefresh = refreshWebCache,
}: {
  version?: string | null
  className?: string
  onRefresh?: () => Promise<void> | void
}) {
  const { t } = useTranslation('web')
  const [busy, setBusy] = useState(false)

  const handleClick = (): void => {
    if (busy) return
    setBusy(true)
    void Promise.resolve(onRefresh()).catch(() => setBusy(false))
  }

  return (
    <p
      className={cn(
        'flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-secondary',
        className,
      )}
    >
      {version && <span className="tabular-nums">{t('cache.version', { version })}</span>}
      {version && <span aria-hidden>·</span>}
      <Button
        type="button"
        variant="link"
        size="xs"
        disabled={busy}
        title={t('cache.hint')}
        className="h-auto p-0"
        onClick={handleClick}
      >
        {busy && <Spinner data-icon="inline-start" className="size-3" />}
        {t(busy ? 'cache.refreshing' : 'cache.refresh')}
      </Button>
    </p>
  )
}
