import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Spinner } from '@renderer/components/ui/spinner'
import { useOtherHost } from '@renderer/stores/hosts'
import {
  cancelHostSwitch,
  hostSwitchSettled,
  useHostSwitchStore,
} from '@renderer/stores/host-switch'

/**
 * A slim bar over the sidebar's list while the host the window switched to connects; the account
 * row already names that host. Esc goes back to the host before.
 */
export function HostSwitchBar() {
  const { t } = useTranslation('sidebar')
  const switching = useHostSwitchStore((s) => s.switching)
  const host = useOtherHost(switching?.hostId ?? null)
  const connecting = host?.connection.state === 'connecting'

  useEffect(() => {
    if (switching && !connecting) hostSwitchSettled()
  }, [switching, connecting])

  useEffect(() => {
    if (!switching) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      // Only where Esc has nothing else to do: the page itself or the sidebar.
      const at = document.activeElement
      if (at && at !== document.body && !at.closest('[data-slot=sidebar]')) return
      event.preventDefault()
      cancelHostSwitch()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [switching])

  if (!switching || !host || !connecting) return null
  return (
    <div
      role="status"
      className="mb-1.5 flex h-7.5 shrink-0 items-center gap-2 rounded-tile bg-surface px-2.5 text-small text-secondary shadow-card motion-safe:animate-in motion-safe:fade-in motion-safe:animation-duration-(--duration-fast)"
    >
      <Spinner className="size-3 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {t('account.connecting', { name: host.name })}
      </span>
      <button
        type="button"
        onClick={cancelHostSwitch}
        aria-label={t('account.cancelSwitch')}
        className="rounded-xs text-tertiary outline-none hover:text-secondary focus-visible:focus-ring"
      >
        esc
      </button>
    </div>
  )
}
