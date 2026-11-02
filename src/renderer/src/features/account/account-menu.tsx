import type { KeyboardEvent, ReactNode } from 'react'
import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import {
  CheckIcon,
  ExternalLinkIcon,
  KeyboardIcon,
  LaptopIcon,
  LayersIcon,
  LogInIcon,
  LogOutIcon,
  MonitorIcon,
  PencilIcon,
  PlusIcon,
  SparkleIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { AgentStatus } from '@shared/agent-host'
import { RELEASES_URL, releaseUrl } from '@shared/updates'
import {
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuList,
  DropdownMenuRadioGroup,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from '@renderer/components/ui/dropdown-menu'
import { Spinner } from '@renderer/components/ui/spinner'
import { HostIcon } from '@renderer/features/settings/remote-parts'
import { deviceShape } from '@renderer/features/settings/remote-text'
import { connectionText, routeName } from '@renderer/features/settings/host-text'
import { Masked } from '@renderer/features/settings/controls'
import { LIMIT_FILL } from '@renderer/lib/plan-limit'
import { formatShortcut, isMod, isWeb } from '@renderer/lib/platform'
import { useAppInfo } from '@renderer/lib/use-app-info'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { cancelSignIn, signIn, signOut, useAccountStore } from '@renderer/stores/account'
import { useAgentsStore } from '@renderer/stores/agents'
import { switchHost } from '@renderer/stores/host-switch'
import { isAway, useHostsStore, useOtherHosts, type OtherHost } from '@renderer/stores/hosts'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import { useUpdatesStore } from '@renderer/stores/updates'
import { openSettings, showShortcuts, THIS_COMPUTER, useViewStore } from '@renderer/stores/view'
import { HarnessTile } from '@renderer/features/updates/update-parts'
import { AccountAvatar, IdentityName, SettingsGlyph } from './avatar'
import { chosenHost, limitRows, systemName, type Identity } from './model'
import { useThisComputerName } from './use-account'

const DOCS_URL = 'https://github.com/KettuAI/Kettu#readme'

/** A label over a group of the menu, such as "This window controls". */
function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <DropdownMenuLabel className="h-6.5 px-2 text-small font-medium text-tertiary">
      {children}
    </DropdownMenuLabel>
  )
}

const SEPARATOR = 'mx-0.75 my-1.25'

/**
 * The account menu, opened from the avatar or name: who you are, the host this window controls
 * (Mod+1 to Mod+9 while open), plan limits, the theme, and the ways to settings and help.
 */
export function AccountMenuContent({
  identity,
  onClose,
}: {
  identity: Identity
  onClose: () => void
}) {
  const { t } = useTranslation('sidebar')
  const hosts = useOtherHosts()
  const choices: (string | null)[] = [THIS_COMPUTER, ...hosts.map((h) => h.id)]

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // The web client lists no host to pick, and the browser keeps its own tab keys.
    if (isWeb || !isMod(event) || event.shiftKey || event.altKey) return
    const digit = /^Digit([1-9])$/.exec(event.code)?.[1]
    const choice = digit ? choices[Number(digit) - 1] : undefined
    if (choice === undefined) return
    event.preventDefault()
    event.stopPropagation()
    choose(choice, hosts)
    onClose()
  }

  return (
    <DropdownMenuContent
      side="top"
      align="start"
      sideOffset={6}
      alignOffset={6}
      onKeyDown={onKeyDown}
      className="w-75 max-w-[calc(100vw-2rem)] p-1.5"
    >
      <DropdownMenuList>
        <Profile identity={identity} />
        <DropdownMenuSeparator className={SEPARATOR} />
        {!isWeb && <HostChoices hosts={hosts} />}
        {!isWeb && <DropdownMenuSeparator className={SEPARATOR} />}
        <PlanLimits />
        <ThemeChoice />
        <DropdownMenuSeparator className={SEPARATOR} />
        <DropdownMenuItem onClick={() => openSettings()}>
          <SettingsGlyph />
          {t('account.settings')}
          <DropdownMenuShortcut>{formatShortcut('Mod+,')}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => showShortcuts(true)}>
          <KeyboardIcon />
          {t('account.shortcuts')}
          <DropdownMenuShortcut>{formatShortcut('Mod+/')}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <WhatsNewItem />
        <DropdownMenuItem render={<a href={DOCS_URL} target="_blank" rel="noreferrer" />}>
          <ExternalLinkIcon />
          {t('account.docs')}
        </DropdownMenuItem>
        <AccountAction />
        <VersionLine />
      </DropdownMenuList>
    </DropdownMenuContent>
  )
}

function choose(choice: string | null, hosts: readonly OtherHost[]): void {
  const host = hosts.find((h) => h.id === choice)
  switchHost(choice, host?.connection.state === 'connecting')
}

/** The avatar, name and email, with the account's page to edit them. */
function Profile({ identity }: { identity: Identity }) {
  const { t } = useTranslation('sidebar')
  const status = useAccountStore((s) => s.status)
  const manageUrl = status?.state === 'signed-in' ? status.manageUrl : null
  return (
    <div className="flex items-center gap-2.5 px-2 pt-2 pb-2.5">
      <AccountAvatar identity={identity} size={32} />
      <div className="flex min-w-0 flex-1 flex-col leading-[1.3]">
        <span className="truncate text-[13.5px] font-semibold text-primary">
          <IdentityName identity={identity} />
        </span>
        <span className="truncate text-small text-tertiary">
          {identity.email ? (
            <Masked revealable={false}>{identity.email}</Masked>
          ) : status?.state === 'signing-in' ? (
            t('account.signingIn')
          ) : (
            t('account.signedOutLine')
          )}
        </span>
      </div>
      {manageUrl && (
        <DropdownMenuItem
          aria-label={t('account.editProfile')}
          render={<a href={manageUrl} target="_blank" rel="noreferrer" />}
          className="grid size-6.5 min-h-0 shrink-0 place-items-center rounded-tile p-0 text-tertiary focus:text-primary"
        >
          <PencilIcon strokeWidth={1.35} className="size-2.75" />
        </DropdownMenuItem>
      )}
    </div>
  )
}

const HOST_ROW =
  'flex h-9.5 cursor-default items-center gap-2.5 rounded-lg px-2 outline-none select-none data-checked:bg-selected data-highlighted:bg-selected'

/** The hosts this window can control, Mod+1 to Mod+9 in order; every host while there are some. */
function HostChoices({ hosts }: { hosts: OtherHost[] }) {
  const { t } = useTranslation('sidebar')
  const { t: ts } = useTranslation('settings')
  const filter = useViewStore((s) => s.hostFilter)
  const model = useHostsStore((s) => s.status?.self.model ?? '')
  const selfName = useThisComputerName()
  const counts = useSessionsStore(
    useShallow((s) => {
      const byHost: Record<string, number> = {}
      for (const summary of Object.values(s.byId)) {
        const host = hostOfSession(summary)
        if (host !== null) byHost[host] = (byHost[host] ?? 0) + 1
      }
      return byHost
    }),
  )
  const now = useNow()
  const value =
    hosts.length === 0
      ? THIS_COMPUTER
      : (chosenHost(
          filter,
          hosts.map((h) => h.id),
        ) ?? 'all')
  const laptop = deviceShape({ kind: 'desktop', model }) === 'laptop'
  return (
    <DropdownMenuGroup>
      <GroupLabel>{t('account.controls')}</GroupLabel>
      <DropdownMenuRadioGroup
        value={value}
        onValueChange={(next: string) => choose(next === 'all' ? null : next, hosts)}
      >
        <HostRow
          value={THIS_COMPUTER}
          icon={laptop ? <LaptopIcon /> : <MonitorIcon />}
          name={selfName}
          line={
            <>
              <StateDot state="online" />
              {t('hosts.thisComputer')}
            </>
          }
          shortcut={formatShortcut('Mod+1')}
        />
        {hosts.map((host, index) => {
          const { state } = host.connection
          const line =
            state === 'online' ? (
              <>
                <StateDot state="online" />
                {t('account.hostLine', {
                  route: routeName(ts, host),
                  count: counts[host.id] ?? 0,
                })}
              </>
            ) : (
              <>
                {state === 'connecting' ? (
                  <Spinner className="size-2.5" />
                ) : (
                  <StateDot state="offline" />
                )}
                {connectionText(ts, host, now)}
              </>
            )
          return (
            <HostRow
              key={host.id}
              value={host.id}
              icon={<HostIcon platform={host.platform} />}
              name={host.name}
              line={line}
              away={isAway(host.connection)}
              // Mod+N still picks a host away; the row only stops advertising it.
              shortcut={
                index < 8 && !isAway(host.connection) ? formatShortcut(`Mod+${index + 2}`) : null
              }
            />
          )
        })}
        {hosts.length > 0 && (
          <HostRow
            value="all"
            icon={<LayersIcon />}
            name={t('hosts.all')}
            line={t('account.allHostsLine', { count: hosts.length + 1 })}
            shortcut={null}
          />
        )}
      </DropdownMenuRadioGroup>
      <DropdownMenuItem onClick={() => openSettings('hosts')}>
        <PlusIcon />
        {t('account.addHost')}
      </DropdownMenuItem>
    </DropdownMenuGroup>
  )
}

function StateDot({ state }: { state: 'online' | 'offline' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        state === 'online' ? 'bg-success' : 'bg-border-strong',
      )}
    />
  )
}

function HostRow({
  value,
  icon,
  name,
  line,
  shortcut,
  away,
}: {
  value: string
  icon: ReactNode
  name: string
  line: ReactNode
  shortcut: string | null
  away?: boolean
}) {
  return (
    <MenuPrimitive.RadioItem
      value={value}
      closeOnClick
      className={cn(HOST_ROW, away && 'opacity-55')}
    >
      <span
        aria-hidden
        className="grid size-7 shrink-0 place-items-center rounded-tile bg-subtle text-icon shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)] [&_svg]:size-3.75 [&_svg]:stroke-[1.3]"
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col leading-[1.25]">
        <span className="truncate text-control text-primary">{name}</span>
        <span className="flex min-w-0 items-center gap-1.25 truncate text-caption text-tertiary">
          {line}
        </span>
      </span>
      {shortcut && <span className="text-caption text-tertiary tabular">{shortcut}</span>}
      <span className="flex w-3.5 justify-center">
        <MenuPrimitive.RadioItemIndicator>
          <CheckIcon strokeWidth={1.8} className="size-3.25 text-primary" />
        </MenuPrimitive.RadioItemIndicator>
      </span>
    </MenuPrimitive.RadioItem>
  )
}

/** Each agent's fullest plan window, colored by the one rule for plan limits. */
function PlanLimits() {
  const { t } = useTranslation('sidebar')
  const agents = useAgentsWithLimits()
  const rows = limitRows(agents, useNow())
  if (rows.length === 0) return null
  return (
    <>
      <DropdownMenuGroup>
        <GroupLabel>{t('account.limits')}</GroupLabel>
        <div className="px-2 pb-1">
          {rows.map((row) => (
            <div key={row.agentId} className="flex h-6.5 items-center gap-2">
              <HarnessTile agentId={row.agentId} size={14} />
              <span className="min-w-0 flex-1 truncate text-hint text-secondary">{row.label}</span>
              <span
                aria-hidden
                className="h-1 w-16 shrink-0 overflow-hidden rounded-xs bg-border-soft"
              >
                <span
                  className={cn('block h-full', LIMIT_FILL[row.level])}
                  style={{ width: `${Math.min(100, row.percent)}%` }}
                />
              </span>
              <span className="w-7.5 shrink-0 text-right text-caption text-primary tabular">
                {row.percent}%
              </span>
            </div>
          ))}
        </div>
      </DropdownMenuGroup>
      <DropdownMenuSeparator className={SEPARATOR} />
    </>
  )
}

function useAgentsWithLimits(): AgentStatus[] {
  return useAgentsStore(
    useShallow((s) =>
      s.order.map((id) => s.byId[id]).filter((a): a is AgentStatus => !!a && a.limits.length > 0),
    ),
  )
}

const THEMES = ['system', 'light', 'dark'] as const

/** System, Light or Dark, as segments that keep the menu open. */
function ThemeChoice() {
  const { t } = useTranslation('sidebar')
  const theme = useSettingsStore((s) => s.settings.appearance.theme)
  return (
    <div className="px-1.5 pt-1 pb-1.5">
      <DropdownMenuRadioGroup
        value={theme}
        onValueChange={(next: (typeof THEMES)[number]) =>
          void useSettingsStore
            .getState()
            .update({ appearance: { theme: next } })
            .catch((error: unknown) => console.warn('Could not change the theme', error))
        }
        aria-label={t('account.theme')}
        className="flex gap-0.5 rounded-tile bg-segment-track p-0.5"
      >
        {THEMES.map((value) => (
          <MenuPrimitive.RadioItem
            key={value}
            value={value}
            closeOnClick={false}
            className="flex h-6 flex-1 cursor-default items-center justify-center rounded-md text-small font-medium text-tertiary outline-none select-none data-checked:bg-segment-thumb data-checked:text-primary data-checked:shadow-segment data-highlighted:not-data-checked:bg-hover data-highlighted:not-data-checked:text-secondary"
          >
            {t(`account.themes.${value}`)}
          </MenuPrimitive.RadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </div>
  )
}

/** What's new in the newest version: the update on offer, or the one running. */
function WhatsNewItem() {
  const { t } = useTranslation('sidebar')
  const status = useUpdatesStore((s) => s.status)
  const state = status?.state
  const latest = state && 'version' in state ? state.version : (status?.current ?? null)
  return (
    <DropdownMenuItem
      render={
        <a href={latest ? releaseUrl(latest) : RELEASES_URL} target="_blank" rel="noreferrer" />
      }
    >
      <SparkleIcon />
      {t('account.whatsNew')}
      {latest && <span className="ml-auto pl-4 text-hint text-tertiary tabular">{latest}</span>}
    </DropdownMenuItem>
  )
}

/** Signing out of the Kettu account, which remote access through the cloud uses; or in. */
function AccountAction() {
  const { t } = useTranslation('sidebar')
  const status = useAccountStore((s) => s.status)
  if (isWeb || !status) return null
  return (
    <>
      <DropdownMenuSeparator className={SEPARATOR} />
      {status.state === 'signed-in' ? (
        <DropdownMenuItem onClick={() => void signOut()}>
          <LogOutIcon />
          {t('account.signOut')}
        </DropdownMenuItem>
      ) : status.state === 'signing-in' ? (
        <DropdownMenuItem onClick={() => void cancelSignIn()}>
          <LogInIcon />
          {t('account.cancelSignIn')}
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem onClick={() => void signIn()}>
          <LogInIcon />
          {t('account.signIn')}
        </DropdownMenuItem>
      )}
    </>
  )
}

/** "Kettu 0.0.9" and the computer and its system, read when the menu opens. */
function VersionLine() {
  const info = useAppInfo()
  const name = useThisComputerName()
  if (!info) return <div className="h-5.5" />
  return (
    <div className="flex gap-2 px-2 pt-1.5 pb-0.5 text-[11px] text-tertiary">
      <span className="flex-1 truncate">Kettu {info.version}</span>
      <span className="truncate">
        {name} · {systemName(info.system)}
      </span>
    </div>
  )
}
