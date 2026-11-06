import { useEffect } from 'react'
import { Settings01Icon, UserIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Icon, type AppShellProps } from '@renderer/components/affect/app-shell'
import { routeName } from '@renderer/features/settings/host-text'
import { formatShortcut, isWeb } from '@renderer/lib/platform'
import { useAccountStore } from '@renderer/stores/account'
import { otherHosts, useHostsStore, useOtherHost } from '@renderer/stores/hosts'
import { useSettingsStore } from '@renderer/stores/settings'
import { setSettingsDot } from '@renderer/stores/updates'
import { openSettings, THIS_COMPUTER, useViewStore } from '@renderer/stores/view'
import { AccountMenu } from './account-menu'
import { RemoteButton } from './remote-button'
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
 * The sidebar's account row for App Shell: who you are over the host this window controls, which
 * open the account menu, then remote access and the Settings gear, each with its own click.
 */
export function useAccountShell(): Pick<
  AppShellProps,
  'user' | 'userMenu' | 'userAction' | 'userTools'
> {
  const { t } = useTranslation('sidebar')
  const identity = identityOf(useAccountStore((s) => s.status))
  const hidden = useSettingsStore((s) => s.settings.privacy.hideAccount)
  const line = useHostLine()
  const self = useThisComputerName()
  const attention = useSettingsAttention()
  const settingsOpen = useViewStore((s) => s.settings.open)
  // Opening Settings is looking at what its dot pointed to.
  useEffect(() => {
    if (settingsOpen) setSettingsDot(false)
  }, [settingsOpen])

  // The web client signs in to no account, so it names the host it shows.
  const name = isWeb
    ? self
    : !identity.name
      ? t('account.signedOut')
      : hidden
        ? MASK
        : identity.name
  const person = isWeb || !identity.name || hidden
  return {
    user: {
      name,
      meta: isWeb ? undefined : line,
      avatar: !person && identity.avatar ? identity.avatar : undefined,
      mark: person ? (
        <span className="ui-as-user__initials">
          <Icon icon={UserIcon} size={12} />
        </span>
      ) : undefined,
    },
    userMenu: (close) => <AccountMenu identity={identity} close={close} />,
    userAction: {
      icon: Settings01Icon,
      label: attention ? t('account.settingsAttention') : t('account.settings'),
      shortcut: formatShortcut('Mod+,'),
      onClick: () => openSettings(),
      dot: attention,
    },
    userTools: <RemoteButton />,
  }
}

// A hidden account's name, as the masked values elsewhere show it.
const MASK = '•'.repeat(8)
