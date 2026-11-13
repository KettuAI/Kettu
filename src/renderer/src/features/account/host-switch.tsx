import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Spinner } from '@renderer/components/ui/spinner'
import { useOtherHost } from '@renderer/stores/hosts'
import { cancelHostSwitch, useHostSwitchStore } from '@renderer/stores/host-switch'

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
    if (!switching) return
    // In the capture phase, before a running turn's Esc to stop it, which then sees it prevented.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
      // Only where Esc has nothing else to do: the page itself or the sidebar.
      const at = document.activeElement
      if (at && at !== document.body && !at.closest('.ui-as-side')) return
      event.preventDefault()
      cancelHostSwitch()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [switching])

  if (!switching || !host || !connecting) return null
  return (
    <div
      role="status"
      className="mb-1.5 flex h-8 shrink-0 items-center gap-2 rounded-[10px] bg-(--shell-card) px-2.5 text-small text-(--shell-muted) shadow-(--shell-card-shadow) motion-safe:animate-in motion-safe:fade-in motion-safe:animation-duration-(--duration-fast)"
    >
      <Spinner className="size-3 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {t('account.connecting', { name: host.name })}
      </span>
      <button
        type="button"
        onClick={cancelHostSwitch}
        aria-label={t('account.cancelSwitch')}
        className="rounded-xs text-(--shell-faint) outline-none hover:text-(--shell-ink) focus-visible:focus-ring"
      >
        {t('account.escKey')}
      </button>
    </div>
  )
}
