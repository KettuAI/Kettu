import { type KeyboardEvent, type ReactNode } from 'react'
import {
  Add01Icon,
  Book02Icon,
  ComputerIcon,
  HelpCircleIcon,
  KeyboardIcon,
  LaptopIcon,
  Layers01Icon,
  Login01Icon,
  Logout01Icon,
  Moon02Icon,
  News01Icon,
  PaintBoardIcon,
  Settings01Icon,
  Sun03Icon,
  UserIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { RELEASES_URL, releaseUrl } from '@shared/updates'
import { Icon } from '@renderer/components/affect/app-shell'
import { ProfileMenu, type ProfileMenuItem } from '@renderer/components/affect/profile-menu'
import { SegmentedControl } from '@renderer/components/affect/segmented-control'
import { HostIcon } from '@renderer/features/settings/remote-parts'
import { deviceShape } from '@renderer/features/settings/remote-text'
import { useCloudOff } from '@renderer/lib/cloud'
import { formatShortcut, isHosted, isMod, isWeb } from '@renderer/lib/platform'
import { useAppInfo } from '@renderer/lib/use-app-info'
import { cancelSignIn, signIn, signOut, useAccountStore } from '@renderer/stores/account'
import { switchHost } from '@renderer/stores/host-switch'
import { isAway, useHostsStore, useOtherHosts, type OtherHost } from '@renderer/stores/hosts'
import { useOverlayPresence } from '@renderer/stores/overlays'
import { useSettingsStore } from '@renderer/stores/settings'
import { useUpdatesStore } from '@renderer/stores/updates'
import { openSettings, showShortcuts, THIS_COMPUTER, useViewStore } from '@renderer/stores/view'
import { chosenHost, systemName, type Identity } from './model'
import { useMenuClose } from './menu-close'
import { useThisComputerName } from './use-account'
import { useStarMenuItem } from '@renderer/features/github-star/use-star'

const DOCS_URL = 'https://github.com/KettuAI/Kettu#readme'

/** An http(s) page in the system browser, as the app opens every outside link. */
function openPage(url: string): void {
  window.open(url, '_blank', 'noreferrer')
}

/**
 * The account menu on affectUI's Profile Menu, opened from the account row: who you are, which
 * edits the profile, the hosts this window controls (Mod+1 to Mod+9 while open), then color mode,
 * Settings, Help on a second card, and signing in or out. The plan limits are the ring's beside it.
 */
export function AccountMenu({ identity, close }: { identity: Identity; close: () => void }) {
  const { t } = useTranslation('sidebar')
  const hosts = useOtherHosts()
  const choices: (string | null)[] = [THIS_COMPUTER, ...hosts.map((h) => h.id)]
  const status = useAccountStore((s) => s.status)
  const hidden = useSettingsStore((s) => s.settings.privacy.hideAccount)
  const cloudOff = useCloudOff()
  const selfName = useThisComputerName()
  const info = useAppInfo()
  const hostItems = useHostItems(hosts, close)
  const help = useHelpItems(close)
  useOverlayPresence(true, { dismissible: true })
  useMenuClose(close)

  const then = (run: () => void) => () => {
    close()
    run()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // The web client lists no host to pick, and the browser keeps its own tab keys.
    if (isWeb || !isMod(event) || event.shiftKey || event.altKey) return
    const digit = /^Digit([1-9])$/.exec(event.code)?.[1]
    const choice = digit ? choices[Number(digit) - 1] : undefined
    if (choice === undefined) return
    event.preventDefault()
    event.stopPropagation()
    choose(choice, hosts)
    close()
  }

  const manageUrl = status?.state === 'signed-in' ? status.manageUrl : null
  // The header edits the profile; not while signed out, self-hosted or with the account hidden.
  const editProfile =
    manageUrl && !cloudOff && !hidden ? then(() => openPage(manageUrl)) : undefined
  const account: ProfileMenuItem[] =
    (isWeb && !isHosted) || cloudOff || !status
      ? []
      : status.state === 'signed-in'
        ? [
            {
              id: 'sign-out',
              label: t(isHosted ? 'account.signOutHosted' : 'account.signOut'),
              icon: <MenuIcon icon={Logout01Icon} />,
              divider: true,
              onSelect: then(() => void signOut()),
            },
          ]
        : [
            {
              id: 'sign-in',
              label:
                status.state === 'signing-in' ? t('account.cancelSignIn') : t('account.signIn'),
              icon: <MenuIcon icon={Login01Icon} />,
              divider: true,
              onSelect: then(
                () => void (status.state === 'signing-in' ? cancelSignIn() : signIn()),
              ),
            },
          ]

  const items: ProfileMenuItem[] = [
    ...hostItems,
    {
      id: 'mode',
      label: t('account.theme'),
      control: <ColorMode />,
      divider: hostItems.length > 0,
    },
    {
      id: 'settings',
      label: t('account.settings'),
      icon: <MenuIcon icon={Settings01Icon} />,
      shortcut: formatShortcut('Mod+,'),
      divider: true,
      onSelect: then(() => openSettings()),
    },
    {
      id: 'help',
      label: t('account.help'),
      icon: <MenuIcon icon={HelpCircleIcon} />,
      submenu: help,
    },
    ...account,
  ]

  const email = identity.email
    ? hidden
      ? '•'.repeat(8)
      : identity.email
    : status?.state === 'signing-in'
      ? t('account.signingIn')
      : t('account.signedOutLine')

  // Self-hosted, the card names this computer and its system in place of the account.
  const selfHosted = info
    ? t('account.selfHostedLine', { system: systemName(info.system) })
    : t('account.selfHosted')

  return (
    <div role="presentation" onKeyDown={onKeyDown} className="kettu-account">
      <ProfileMenu
        className="kettu-account__card"
        name={
          cloudOff
            ? selfName
            : !identity.name
              ? t('account.signedOut')
              : hidden
                ? '•'.repeat(8)
                : identity.name
        }
        email={cloudOff ? selfHosted : email}
        avatar={<Avatar identity={identity} hidden={hidden} />}
        items={items}
        labels={{ menu: t('account.menuLabel') }}
        onUser={editProfile}
        userLabel={t('account.editProfile')}
      />
    </div>
  )
}

function MenuIcon({ icon }: { icon: Parameters<typeof Icon>[0]['icon'] }) {
  return <Icon icon={icon} size={16} />
}

/** A host's icon, with a dot at its corner while the host is online or being reached. */
function HostMark({ icon, state }: { icon: ReactNode; state?: 'online' | 'connecting' }) {
  return (
    <span className="kettu-host-mark">
      {icon}
      {state && <span aria-hidden className="kettu-host-mark__dot" data-state={state} />}
    </span>
  )
}

function choose(choice: string | null, hosts: readonly OtherHost[]): void {
  const host = hosts.find((h) => h.id === choice)
  switchHost(choice, host?.connection.state === 'connecting')
}

/** The account's picture or initial, or a person while signed out or hidden. */
function Avatar({ identity, hidden }: { identity: Identity; hidden: boolean }) {
  if (identity.avatar && !hidden) return <img src={identity.avatar} alt="" draggable={false} />
  return (
    <span className="kettu-account__avatar">
      {identity.initial && !hidden ? identity.initial : <Icon icon={UserIcon} size={18} />}
    </span>
  )
}

/**
 * The hosts this window can control, Mod+1 to Mod+9 in order, each with whether it is reached;
 * every host side by side while there are others; and adding one.
 */
function useHostItems(hosts: OtherHost[], close: () => void): ProfileMenuItem[] {
  const { t } = useTranslation('sidebar')
  const { t: ts } = useTranslation('settings')
  const filter = useViewStore((s) => s.hostFilter)
  const model = useHostsStore((s) => s.status?.self.model ?? '')
  const selfName = useThisComputerName()
  if (isWeb) return []
  const value =
    hosts.length === 0
      ? THIS_COMPUTER
      : (chosenHost(
          filter,
          hosts.map((h) => h.id),
        ) ?? 'all')
  const pick = (choice: string | null) => () => {
    close()
    choose(choice, hosts)
  }
  const laptop = deviceShape({ kind: 'desktop', model }) === 'laptop'
  return [
    { id: 'hosts', label: t('account.hosts'), heading: true },
    {
      id: 'host:self',
      label: selfName,
      icon: <HostMark icon={<MenuIcon icon={laptop ? LaptopIcon : ComputerIcon} />} />,
      checked: value === THIS_COMPUTER,
      shortcut: formatShortcut('Mod+1'),
      onSelect: pick(THIS_COMPUTER),
    },
    ...hosts.map((host, index): ProfileMenuItem => {
      const state = host.connection.state
      const away = isAway(host.connection)
      const connecting = state === 'connecting'
      return {
        id: `host:${host.id}`,
        label: host.name,
        icon: (
          <HostMark
            icon={<HostIcon platform={host.platform} className="size-4" />}
            state={connecting ? 'connecting' : away ? undefined : 'online'}
          />
        ),
        checked: value === host.id,
        // Mod+N still picks a host away; the row only stops advertising it.
        shortcut:
          index < 8 && !away && !connecting ? formatShortcut(`Mod+${index + 2}`) : undefined,
        note: connecting
          ? ts('hosts.state.connecting')
          : away
            ? ts('hosts.state.offline')
            : undefined,
        tone: away ? 'away' : undefined,
        onSelect: pick(host.id),
      }
    }),
    ...(hosts.length > 0
      ? [
          {
            id: 'host:all',
            label: t('hosts.all'),
            icon: <MenuIcon icon={Layers01Icon} />,
            checked: value === 'all',
            onSelect: pick(null),
          },
        ]
      : []),
    {
      id: 'add-host',
      label: t('account.addHost'),
      icon: <MenuIcon icon={Add01Icon} />,
      tone: 'quiet',
      onSelect: () => {
        close()
        openSettings('hosts')
      },
    },
  ]
}

/** Help's card: the keyboard shortcuts, what's new, the docs, and the version and computer. */
function useHelpItems(close: () => void): ProfileMenuItem[] {
  const { t } = useTranslation('sidebar')
  const status = useUpdatesStore((s) => s.status)
  const info = useAppInfo()
  const name = useThisComputerName()
  const state = status?.state
  const latest = state && 'version' in state ? state.version : (status?.current ?? null)
  const star = useStarMenuItem()
  return [
    {
      id: 'shortcuts',
      label: t('account.shortcuts'),
      icon: <MenuIcon icon={KeyboardIcon} />,
      shortcut: formatShortcut('Mod+/'),
      onSelect: () => {
        close()
        showShortcuts(true)
      },
    },
    {
      id: 'whats-new',
      label: t('account.whatsNew'),
      icon: <MenuIcon icon={News01Icon} />,
      shortcut: latest ?? undefined,
      onSelect: () => {
        close()
        openPage(latest ? releaseUrl(latest) : RELEASES_URL)
      },
    },
    {
      id: 'docs',
      label: t('account.docs'),
      icon: <MenuIcon icon={Book02Icon} />,
      onSelect: () => {
        close()
        openPage(DOCS_URL)
      },
    },
    star,
    ...(info
      ? [
          {
            id: 'version',
            label: `Kettu ${info.version} · ${name} · ${systemName(info.system)}`,
            heading: true,
            divider: true,
          },
        ]
      : []),
  ]
}

const THEMES = ['system', 'light', 'dark'] as const
type Theme = (typeof THEMES)[number]

const THEME_ICONS = { system: ComputerIcon, light: Sun03Icon, dark: Moon02Icon } as const

/** System, Light or Dark: a menu row with the choices as icons at its end. */
function ColorMode() {
  const { t } = useTranslation('sidebar')
  const theme = useSettingsStore((s) => s.settings.appearance.theme)
  const choose = (next: Theme) =>
    void useSettingsStore
      .getState()
      .update({ appearance: { theme: next } })
      .catch((error: unknown) => console.warn('Could not change the theme', error))
  return (
    <div className="kettu-theme-row">
      <span className="ui-pmc__icon">
        <MenuIcon icon={PaintBoardIcon} />
      </span>
      <span className="kettu-theme-row__label">{t('account.theme')}</span>
      <SegmentedControl<Theme>
        aria-label={t('account.theme')}
        variant="tray"
        size="sm"
        value={theme}
        onChange={choose}
        options={THEMES.map((value) => ({
          value,
          icon: <Icon icon={THEME_ICONS[value]} size={14} />,
          ariaLabel: t(`account.themes.${value}`),
        }))}
      />
    </div>
  )
}
