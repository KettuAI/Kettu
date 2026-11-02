import { useEffect, useState, type ReactNode } from 'react'
import { MonitorSmartphoneIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { DropdownMenu, DropdownMenuTrigger } from '@renderer/components/ui/dropdown-menu'
import { Kbd } from '@renderer/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { routeName } from '@renderer/features/settings/host-text'
import { formatShortcut, isWeb } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { useAccountStore } from '@renderer/stores/account'
import { otherHosts, useHostsStore, useOtherHost } from '@renderer/stores/hosts'
import { useRemoteStore } from '@renderer/stores/remote'
import { setSettingsDot } from '@renderer/stores/updates'
import { openSettings, THIS_COMPUTER, useViewStore } from '@renderer/stores/view'
import { AccountMenuContent } from './account-menu'
import { AccountAvatar, IdentityName, SettingsGlyph } from './avatar'
import { identityOf } from './model'
import { useSettingsAttention, useThisComputerName } from './use-account'

/** The host this window controls, as the row's second line names it. */
function useHostLine(): string {
  const { t } = useTranslation('sidebar')
  const { t: ts } = useTranslation('settings')
  const filter = useViewStore((s) => s.hostFilter)
  const host = useOtherHost(filter === null || filter === THIS_COMPUTER ? null : filter)
  const others = useHostsStore((s) => otherHosts(s).length)
  const self = useThisComputerName()
  if (host) return `${host.name} · ${routeName(ts, host)}`
  if (filter === null && others > 0) return t('hosts.all')
  return self
}

/**
 * The sidebar footer's account row: who you are and the host this window controls, which open the
 * account menu, then remote access and Settings, each with its own click.
 */
export function AccountRow() {
  const { t } = useTranslation('sidebar')
  const identity = identityOf(useAccountStore((s) => s.status))
  const line = useHostLine()
  const self = useThisComputerName()
  const [open, setOpen] = useState(false)
  const settingsOpen = useViewStore((s) => s.settings.open)
  // Opening Settings is looking at what its dot pointed to.
  useEffect(() => {
    if (settingsOpen) setSettingsDot(false)
  }, [settingsOpen])
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          'flex h-10 shrink-0 items-center gap-2.25 rounded-tile pr-1 transition-colors duration-(--duration-fast)',
          open ? 'bg-selected' : 'has-[>[data-account-trigger]:hover]:bg-hover',
        )}
      >
        <DropdownMenuTrigger
          data-account-trigger=""
          aria-description={t('account.menuLabel')}
          className="flex h-full min-w-0 flex-1 items-center gap-2.25 rounded-tile pl-2 text-left outline-none focus-visible:focus-ring"
        >
          <AccountAvatar identity={identity} size={24} />
          <span className="flex min-w-0 flex-1 flex-col leading-[1.2]">
            {/* The web client signs in to no account, so it names the host it shows. */}
            <span className="truncate text-control font-medium text-primary">
              {isWeb ? self : <IdentityName identity={identity} />}
            </span>
            {!isWeb && (
              <span className="truncate text-caption leading-[1.2] text-tertiary">{line}</span>
            )}
          </span>
        </DropdownMenuTrigger>
        <RemoteButton />
        <SettingsButton />
      </div>
      <AccountMenuContent identity={identity} onClose={() => setOpen(false)} />
    </DropdownMenu>
  )
}

function RowButton({
  label,
  tooltip,
  onClick,
  dot,
  children,
}: {
  label: string
  tooltip: ReactNode
  onClick: () => void
  dot?: ReactNode
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            onClick={onClick}
            className="relative grid size-7 shrink-0 place-items-center rounded-tile text-icon outline-none hover:bg-hover hover:text-primary focus-visible:focus-ring [&_svg]:size-4"
          />
        }
      >
        {children}
        {dot}
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}

/** Remote access, with a green dot while a paired phone or computer is online. */
function RemoteButton() {
  const { t } = useTranslation('sidebar')
  const devices = useRemoteStore((s) => s.status?.devices.length ?? 0)
  const online = useRemoteStore((s) => (s.status?.online.length ?? 0) > 0)
  const label = t('account.remote', { count: devices })
  return (
    <RowButton
      label={label}
      tooltip={label}
      onClick={() => openSettings('remote')}
      dot={
        online && (
          <span
            aria-hidden
            className="absolute right-1.25 bottom-1.5 size-1.5 rounded-full bg-success shadow-[0_0_0_1.5px_var(--bg-sidebar)]"
          />
        )
      }
    >
      <MonitorSmartphoneIcon strokeWidth={1.3} />
    </RowButton>
  )
}

/** Settings, with a fox dot while something there needs you. */
function SettingsButton() {
  const { t } = useTranslation('sidebar')
  const attention = useSettingsAttention()
  const label = attention ? t('account.settingsAttention') : t('account.settings')
  return (
    <RowButton
      label={label}
      tooltip={
        <>
          {t('account.settings')}
          <Kbd>{formatShortcut('Mod+,')}</Kbd>
        </>
      }
      onClick={() => openSettings()}
      dot={
        attention && (
          <span
            aria-hidden
            className="absolute top-1.25 right-1.25 size-1.5 rounded-full bg-attention-dot shadow-[0_0_0_1.5px_var(--bg-sidebar)]"
          />
        )
      }
    >
      <SettingsGlyph />
    </RowButton>
  )
}
