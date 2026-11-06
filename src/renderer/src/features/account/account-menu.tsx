import { useEffect, type KeyboardEvent } from 'react'
import {
  Add01Icon,
  ArrowRight01Icon,
  Book02Icon,
  ComputerIcon,
  HelpCircleIcon,
  KeyboardIcon,
  LaptopIcon,
  Layers01Icon,
  Login01Icon,
  Logout01Icon,
  News01Icon,
  Settings01Icon,
  UserEdit01Icon,
  UserIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { AgentStatus } from '@shared/agent-host'
import { RELEASES_URL, releaseUrl } from '@shared/updates'
import { Icon } from '@renderer/components/affect/app-shell'
import { ProfileMenu, type ProfileMenuItem } from '@renderer/components/affect/profile-menu'
import { SegmentedControl } from '@renderer/components/affect/segmented-control'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { HostIcon } from '@renderer/features/settings/remote-parts'
import { deviceShape } from '@renderer/features/settings/remote-text'
import { limitReaders } from '@renderer/features/sidebar/plan-usage'
import { errorMessage } from '@renderer/lib/host'
import { formatShortcut, isMod, isWeb } from '@renderer/lib/platform'
import { useAppInfo } from '@renderer/lib/use-app-info'
import { useNow } from '@renderer/lib/use-now'
import { cancelSignIn, signIn, signOut, useAccountStore } from '@renderer/stores/account'
import { useAgentsStore } from '@renderer/stores/agents'
import { switchHost } from '@renderer/stores/host-switch'
import { isAway, useHostsStore, useOtherHosts, type OtherHost } from '@renderer/stores/hosts'
import { useSettingsStore } from '@renderer/stores/settings'
import { refreshLimits } from '@renderer/stores/usage'
import { useUpdatesStore } from '@renderer/stores/updates'
import {
  openSettings,
  openUsage,
  showShortcuts,
  THIS_COMPUTER,
  useViewStore,
} from '@renderer/stores/view'
import { chosenHost, planCards, systemName, type Identity, type PlanCard } from './model'
import { useThisComputerName } from './use-account'

const DOCS_URL = 'https://github.com/KettuAI/Kettu#readme'

/** Reads the plan limits the menu lists again; the host asks each agent at most once a minute. */
function readLimits(): void {
  const { order, byId } = useAgentsStore.getState()
  for (const agentId of limitReaders(order.flatMap((id) => byId[id] ?? []))) {
    refreshLimits(agentId).catch((error: unknown) =>
      console.warn(`Could not read the plan limits: ${errorMessage(error)}`),
    )
  }
}

/** An http(s) page in the system browser, as the app opens every outside link. */
function openPage(url: string): void {
  window.open(url, '_blank', 'noreferrer')
}

/**
 * The account menu on affectUI's Profile Menu, opened from the account row: who you are, the hosts
 * this window controls (Mod+1 to Mod+9 while open), color mode, Settings, Help on a second card,
 * signing in or out, and the plan limits as the card's last row.
 */
export function AccountMenu({ identity, close }: { identity: Identity; close: () => void }) {
  const { t } = useTranslation('sidebar')
  const hosts = useOtherHosts()
  const choices: (string | null)[] = [THIS_COMPUTER, ...hosts.map((h) => h.id)]
  const status = useAccountStore((s) => s.status)
  const hidden = useSettingsStore((s) => s.settings.privacy.hideAccount)
  const hostItems = useHostItems(hosts, close)
  const help = useHelpItems(close)
  useEffect(readLimits, [])

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
  const account: ProfileMenuItem[] =
    isWeb || !status
      ? []
      : status.state === 'signed-in'
        ? [
            ...(manageUrl
              ? [
                  {
                    id: 'profile',
                    label: t('account.editProfile'),
                    icon: <MenuIcon icon={UserEdit01Icon} />,
                    divider: true,
                    onSelect: then(() => openPage(manageUrl)),
                  },
                ]
              : []),
            {
              id: 'sign-out',
              label: t('account.signOut'),
              icon: <MenuIcon icon={Logout01Icon} />,
              divider: !manageUrl,
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

  return (
    <div role="presentation" onKeyDown={onKeyDown} className="kettu-account">
      <ProfileMenu
        className="kettu-account__card"
        name={!identity.name ? t('account.signedOut') : hidden ? '•'.repeat(8) : identity.name}
        email={email}
        avatar={<Avatar identity={identity} hidden={hidden} />}
        items={items}
        footer={<PlanLimits close={close} />}
        labels={{ menu: t('account.menuLabel') }}
      />
    </div>
  )
}

function MenuIcon({ icon }: { icon: Parameters<typeof Icon>[0]['icon'] }) {
  return <Icon icon={icon} size={16} />
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
      icon: <MenuIcon icon={laptop ? LaptopIcon : ComputerIcon} />,
      checked: value === THIS_COMPUTER,
      shortcut: formatShortcut('Mod+1'),
      onSelect: pick(THIS_COMPUTER),
    },
    ...hosts.map((host, index): ProfileMenuItem => {
      const state = host.connection.state
      const away = isAway(host.connection)
      return {
        id: `host:${host.id}`,
        label: host.name,
        icon: <HostIcon platform={host.platform} className="size-4" />,
        checked: value === host.id,
        // Mod+N still picks a host away; the row only stops advertising it.
        shortcut: index < 8 && !away ? formatShortcut(`Mod+${index + 2}`) : undefined,
        badge:
          state === 'connecting'
            ? ts('hosts.state.connecting')
            : away
              ? ts('hosts.state.offline')
              : undefined,
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

/** System, Light or Dark, as one menu row's segmented control. */
function ColorMode() {
  const { t } = useTranslation('sidebar')
  const theme = useSettingsStore((s) => s.settings.appearance.theme)
  const choose = (next: Theme) =>
    void useSettingsStore
      .getState()
      .update({ appearance: { theme: next } })
      .catch((error: unknown) => console.warn('Could not change the theme', error))
  return (
    <SegmentedControl<Theme>
      aria-label={t('account.theme')}
      variant="tray"
      size="lg"
      fullWidth
      value={theme}
      onChange={choose}
      options={THEMES.map((value) => ({ value, label: t(`account.themes.${value}`) }))}
    />
  )
}

/** Every account's plan windows as bars, the card's last row; its head opens Usage. */
function PlanLimits({ close }: { close: () => void }) {
  const { t } = useTranslation('sidebar')
  const cards = planCards(useAgentsWithLimits(), useNow())
  if (cards.length === 0) return null
  return (
    <div className="kettu-plans">
      <button
        type="button"
        className="kettu-plans__head"
        onClick={() => {
          close()
          openUsage()
        }}
      >
        <span>{t('account.limits')}</span>
        <span className="kettu-plans__link">
          {t('account.usage')}
          <Icon icon={ArrowRight01Icon} size={14} />
        </span>
      </button>
      {cards.map((card) => (
        <PlanRow key={card.key} card={card} />
      ))}
    </div>
  )
}

/** A bar's color by how much is used, in the context ring's four levels. */
const barLevel = (percent: number) =>
  percent < 50 ? 'ok' : percent < 75 ? 'mid' : percent < 90 ? 'high' : 'full'

const WINDOW_KEY = { five_hour: 'fiveHour', seven_day: 'sevenDay', monthly: 'monthly' } as const

function PlanRow({ card }: { card: PlanCard }) {
  const { t } = useTranslation('sidebar')
  const windows = card.windows.map((w) => ({
    ...w,
    label: t(`account.window.${WINDOW_KEY[w.window]}`),
  }))
  const name = windows
    .map((w) =>
      w.percent === null
        ? w.label
        : t('account.limitUsed', { window: w.label, percent: w.percent }),
    )
    .join(', ')
  return (
    <div
      className="kettu-plan"
      aria-label={`${card.name}${card.tier ? ` ${card.tier}` : ''}: ${name}`}
    >
      <span className="kettu-plan__who">
        <AgentMark agent={card.agentId} size={16} />
        <b>{card.name}</b>
        {card.tier && <span className="kettu-plan__tier">{card.tier}</span>}
      </span>
      <span className="kettu-plan__windows">
        {windows.map((w) => (
          <span
            key={w.window}
            className="kettu-plan-window"
            data-level={w.percent === null ? undefined : barLevel(w.percent)}
          >
            <span className="kettu-plan-window__label">{w.label}</span>
            <span className="kettu-plan-window__bar">
              <span style={{ width: `${w.percent ?? 0}%` }} />
            </span>
            <span className="kettu-plan-window__value">
              {w.percent === null ? '–' : `${w.percent}%`}
            </span>
          </span>
        ))}
      </span>
    </div>
  )
}

function useAgentsWithLimits(): AgentStatus[] {
  return useAgentsStore(
    useShallow((s) =>
      s.order
        .map((id) => s.byId[id])
        .filter(
          (a): a is AgentStatus =>
            !!a && a.registered !== false && !a.disabled && a.limits.length > 0,
        ),
    ),
  )
}
