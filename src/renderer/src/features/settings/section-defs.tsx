import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AiBrain01Icon,
  Archive01Icon,
  ComputerTerminal01Icon,
  DashboardSquare02Icon,
  GitBranchIcon,
  Globe02Icon,
  InformationCircleIcon,
  Notification01Icon,
  PackageIcon,
  PaintBoardIcon,
  PieChartIcon,
  ServerStack02Icon,
  Setting07Icon,
  Settings02Icon,
  Share08Icon,
  UserCircleIcon,
  Wifi01Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { AgentStatus, SessionSummary } from '@shared/agent-host'
import type { ArtifactConsentRow } from '@shared/artifact-capabilities'
import { originLabel } from '@shared/browser'
import { USER_FONT_ROLES } from '@shared/settings'
import type { AgentId, HarnessId } from '@shared/thread'
import { programHere } from '@renderer/features/agents/harness-problem'
import { useCloudOff } from '@renderer/lib/cloud'
import { basename, mediumAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useHostContext, useHostHas } from '@renderer/lib/host-features'
import {
  formatShortcut,
  isHosted,
  isMac,
  isRelayPage,
  isWeb,
  isWindows,
  platform,
} from '@renderer/lib/platform'
import { useAppInfo } from '@renderer/lib/use-app-info'
import { agentName, awaitsPackage, harnessStatuses, usableAgents } from '@renderer/stores/agents'
import { useAccountStore } from '@renderer/stores/account'
import { useDebugStore } from '@renderer/stores/debug'
import { artifactListShown, useArtifactsStore } from '@renderer/stores/artifacts'
import { useProjectsStore } from '@renderer/stores/projects'
import { archivedSessions, sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import { loadHosts, useHostsStore } from '@renderer/stores/hosts'
import { useWebHostStore } from '@renderer/stores/web-host'
import { useHostScope } from '@renderer/stores/host-scope'
import { useUpdatesStore } from '@renderer/stores/updates'
import { openAgentSettings, openHarnessSettings, openSettingsItem } from '@renderer/stores/view'
import { pageRow } from '@renderer/features/sidebar/sidebar-pages'
import { AboutHero, AutomaticUpdates, DownloadSource, NoUpdates, UpdateRow } from './about-section'
import { useIdleSessionRows } from './idle-sessions'
import { IslandSwitch } from './island-row'
import { useIslandDescription } from './island-state'
import { useWorkflowRows } from './workflow-settings'
import {
  AgentListItem,
  AgentPage,
  AgentsFooter,
  AgentsGroupActions,
  NoAgents,
} from './agents-section'
import {
  EnvironmentFooter,
  HarnessGroupActions,
  HarnessListItem,
  HarnessPage,
} from './harness-section'
import { ArchivedRow } from './archived-section'
import { CloudSwitchRow, OtherConnections } from './cloud-section'
import { useCloudOffHere } from './use-cloud-off-here'
import { useGitHubOnly } from './use-github-only'
import { DebugModeRow } from './debug-mode'
import { FontFamily, UserFont } from './font-family'
import { ConsentRow, ConsentsState } from './artifacts-section'
import { EmptyCard, GroupNote } from './rows'
import { BROUGHT_SHOWN, useBroughtSites } from './brought-sites'
import { BringSignInsRow, BroughtMoreRow, BroughtSiteRow } from './sign-ins-rows'
import { HostPage } from './host-page'
import { hostLine, platformName, webHostLine } from './host-text'
import { AccountHostRow, AccountHostsActions, AccountHostsState } from './host-account'
import { useDiscoveredHosts } from './use-discovered'
import { AddHostButton, HostRow, HostsLoading, HostsNote, SelfRow } from './hosts-section'
import { DevicePage } from './remote-device'
import { DirectPortField, FoundAddresses, OwnAddresses } from './remote-direct'
import { DirectSwitch, DiscoverableSwitch } from './remote-relay'
import { RelayChoices, RelayNote } from './remote-relay-choice'
import { relayInUse } from './relay-text'
import {
  AddDeviceButton,
  DeviceRow,
  HostNameField,
  NoDevices,
  PlainKeyNote,
  RemoteSwitchRow,
  ResetRemote,
  StaleNote,
  TerminalSwitch,
} from './remote-section'
import { deviceLine } from './remote-text'
import {
  AutoPublishSwitch,
  KettuSharingAccount,
  KettuStorage,
  NoSharing,
  PublishedRow,
  SharingAccount,
  SharingPending,
} from './sharing-section'
import { useLoginItemStatus } from './use-login-item'
import { environmentText } from './environment-text'
import {
  AccountNote,
  AccountRow,
  DeviceUsage,
  PlanName,
  PointsBalance,
  StorageUsage,
  SubscriptionState,
} from './account-section'
import type { GroupDef, RowDef, SectionDef } from './model'
import {
  AllowedSiteRow,
  AllowedSitesState,
  BackgroundFetch,
  ClearBrowsingData,
  ColorMode,
  ConfirmLinks,
  DataFolderActions,
  DetailedRecords,
  LogsFolderActions,
  DataFolderText,
  DefaultAgent,
  EffortControl,
  FontSize,
  GeneralSwitch,
  LightModelChoice,
  GhTool,
  GitTool,
  Language,
  NewSessionListChoice,
  NotificationPreview,
  NotificationSwitch,
  OpenAtLogin,
  OpenLinksIn,
  OutlineSummaries,
  Proxy,
  RecordSteps,
  ReduceMotion,
  RememberedSitesList,
  RemoveAll,
  ReportProblem,
  SendKey,
  ShellPicker,
  SidebarHover,
  WebNotificationsNote,
  TextSize,
  WorktreeLocation,
  Zoom,
} from './sections'
import { useAllowedSites } from './allowed-sites'
import { SidebarCard } from './sidebar-pages'
import { ThemeTiles } from './theme-section'
import { ClearRecord, FromComputer, LogRow, SidebarEnd, SyncLogs } from './usage-section'
import { BrowserNameField, ForgetHost, OtherWebHosts, WebHostRow } from './web-host-section'

// The sections of the Settings page as data, so search and the match counts read the same rows
// the page draws.

function group(id: string, label: string, extra?: Omit<GroupDef, 'id' | 'label'>): GroupDef {
  return { id, label, ...extra }
}

export function useGeneralSection(): SectionDef {
  const { t } = useTranslation('settings')
  const input = group('input', t('general.groups.input'))
  // Devices reach the computer only while Kettu runs, so remote access holds it on.
  const remoteOn = useSettingsStore((s) => s.settings.remote.enabled)
  const sessions = group('sessions', t('general.groups.sessions'), {
    note: remoteOn && <GroupNote>{t('general.background.lockedByRemote')}</GroupNote>,
    noteFor: 'background',
  })
  const thread = group('thread', t('general.groups.thread'))
  const startup = group('startup', t('general.groups.startup'))
  const cloud = group('cloud', t('general.groups.cloud'), {
    note: <GroupNote>{t('general.cloud.note')}</GroupNote>,
  })
  const loginItem = useLoginItemStatus()
  const openAtLoginDescription = loginItem
    ? !loginItem.available
      ? t('general.openAtLogin.unavailable')
      : loginItem.requiresApproval
        ? t('general.openAtLogin.approval')
        : t('general.openAtLogin.description')
    : t('general.openAtLogin.description')
  return {
    id: 'general',
    title: t('sections.general'),
    description: t('pages.general'),
    icon: Settings02Icon,
    rows: [
      {
        id: 'language',
        setting: 'general.language',
        group: input,
        render: () => <Language />,
      },
      {
        id: 'send-key',
        setting: 'general.send-key',
        group: input,
        render: () => <SendKey />,
      },
      {
        id: 'default-agent',
        setting: 'general.default-agent',
        group: sessions,
        render: () => <DefaultAgent />,
      },
      {
        id: 'new-session-list',
        setting: 'general.new-session-list',
        group: sessions,
        render: () => <NewSessionListChoice />,
      },
      {
        id: 'restore',
        setting: 'general.restore',
        group: sessions,
        render: () => (
          <GeneralSwitch field="restoreLastSession" label={t('general.restore.name')} />
        ),
      },
      {
        id: 'confirm-quit',
        setting: 'general.confirm-quit',
        group: sessions,
        render: () => (
          <GeneralSwitch field="confirmQuitWhileRunning" label={t('general.confirmQuit.name')} />
        ),
      },
      {
        id: 'session-titles',
        setting: 'general.session-titles',
        group: sessions,
        render: () => (
          <GeneralSwitch field="sessionTitles" label={t('general.sessionTitles.name')} />
        ),
      },
      {
        id: 'continue-after-limit',
        setting: 'general.continue-after-limit',
        group: sessions,
        render: () => (
          <GeneralSwitch field="continueAfterLimit" label={t('general.continueAfterLimit.name')} />
        ),
      },
      {
        id: 'prompt-suggestions',
        setting: 'general.prompt-suggestions',
        group: sessions,
        render: () => (
          <GeneralSwitch field="promptSuggestions" label={t('general.promptSuggestions.name')} />
        ),
      },
      {
        id: 'agent-passwords',
        setting: 'general.agent-passwords',
        group: sessions,
        render: () => (
          <GeneralSwitch field="agentPasswords" label={t('general.agentPasswords.name')} />
        ),
      },
      {
        id: 'light-model',
        setting: 'general.light-model',
        group: sessions,
        render: () => <LightModelChoice label={t('general.lightModel.name')} />,
      },
      {
        id: 'background',
        setting: 'general.background',
        group: sessions,
        render: () => (
          <GeneralSwitch
            field="background"
            label={t('general.background.name')}
            disabled={remoteOn}
          />
        ),
      },
      {
        id: 'outline-summaries',
        setting: 'general.outline-summaries',
        group: thread,
        render: () => <OutlineSummaries label={t('general.outlineSummaries.name')} />,
      },
      {
        id: 'open-at-login',
        setting: 'general.open-at-login',
        description: openAtLoginDescription,
        group: startup,
        render: () => (
          <OpenAtLogin label={t('general.openAtLogin.name')} disabled={!loginItem?.available} />
        ),
      },
      {
        id: 'cloud',
        setting: 'general.cloud',
        group: cloud,
        layout: 'custom',
        render: () => <CloudSwitchRow />,
      },
      {
        id: 'other-connections',
        setting: 'general.other-connections',
        group: cloud,
        layout: 'block',
        render: (text) => <OtherConnections text={text} />,
      },
    ],
  }
}

export function useAppearanceSection(): SectionDef {
  const { t } = useTranslation('settings')
  const scale = group('scale', t('appearance.groups.scale'))
  const fonts = group('fonts', t('appearance.groups.fonts'))
  const sidebar = group('sidebar', t('appearance.groups.sidebar'), {
    card: (rows) => <SidebarCard rows={rows} />,
  })
  const sidebarOrder = useHostScope().useSettingsStore((s) => s.settings.appearance.sidebarOrder)
  const zoomKeys = [formatShortcut('Mod+='), formatShortcut('Mod+-')] as const
  const zoomDescription = t('appearance.zoom.description', {
    zoomIn: zoomKeys[0],
    zoomOut: zoomKeys[1],
  })
  return {
    id: 'appearance',
    title: t('sections.appearance'),
    description: t('pages.appearance'),
    icon: PaintBoardIcon,
    rows: [
      {
        id: 'theme',
        setting: 'appearance.theme',
        group: group('theme', t('appearance.groups.theme'), {
          actions: <ColorMode />,
          plain: true,
        }),
        layout: 'custom',
        render: () => <ThemeTiles />,
      },
      {
        id: 'color-mode',
        setting: 'appearance.color-mode',
        searchOnly: true,
        render: () => null,
      },
      {
        id: 'zoom',
        setting: 'appearance.zoom',
        description: zoomDescription,
        group: scale,
        render: () => <Zoom />,
      },
      {
        id: 'text-size',
        setting: 'appearance.text-size',
        group: scale,
        layout: 'bare',
        render: (text) => <TextSize label={text} />,
      },
      ...USER_FONT_ROLES.map((role) => ({
        id: `font-${role}`,
        setting: `appearance.font-${role}` as const,
        group: fonts,
        render: () => <UserFont role={role} label={t(`appearance.fonts.${role}.name`)} />,
      })),
      {
        id: 'sidebar-hover',
        setting: 'appearance.sidebar-hover',
        group: sidebar,
        render: () => <SidebarHover label={t('appearance.sidebarHover.name')} />,
      },
      // Drawn by the group's card, which puts them in the sidebar's order.
      ...sidebarOrder.map((page) => ({
        id: pageRow(page),
        setting: `appearance.sidebar-${page}` as const,
        group: sidebar,
        render: () => null,
      })),
      {
        id: 'effort-control',
        setting: 'appearance.effort-control',
        group: group('model-menu', t('appearance.groups.modelMenu')),
        render: () => <EffortControl />,
      },
      {
        id: 'reduce-motion',
        setting: 'appearance.reduce-motion',
        group: group('motion', t('appearance.groups.motion')),
        render: () => <ReduceMotion />,
      },
    ],
  }
}

export function useNotificationsSection(): SectionDef {
  const { t } = useTranslation('settings')
  const onHost = useHostContext()
  const when = group('when', t('notifications.groups.when'))
  const how = group('how', t('notifications.groups.how'))
  const islandDescription = useIslandDescription()
  const rows: RowDef[] = [
    {
      id: 'preview',
      setting: 'notifications.preview',
      // The preview stands on the page with its test button, as a notification would.
      group: group('preview', t('notifications.groups.preview'), {
        unlabeled: true,
        plain: true,
        note: (
          <>
            <GroupNote>{t(isWeb ? 'notifications.footerWeb' : 'notifications.footer')}</GroupNote>
            {isWeb && <WebNotificationsNote />}
          </>
        ),
      }),
      layout: 'custom',
      render: () => <NotificationPreview />,
    },
    {
      id: 'permission',
      setting: 'notifications.permission',
      group: when,
      render: () => (
        <NotificationSwitch field="permission" label={t('notifications.permission.name')} />
      ),
    },
    {
      id: 'turn-ended',
      setting: 'notifications.turn-ended',
      group: when,
      render: () => (
        <NotificationSwitch field="turnEnded" label={t('notifications.turnEnded.name')} />
      ),
    },
    {
      id: 'routines',
      setting: 'notifications.routines',
      group: when,
      render: () => (
        <NotificationSwitch field="routines" label={t('notifications.routines.name')} />
      ),
    },
    {
      id: 'error',
      setting: 'notifications.error',
      group: when,
      render: () => <NotificationSwitch field="error" label={t('notifications.error.name')} />,
    },
    // Kettu's own update and the agents' plan limits are the desktop app's to say.
    ...(isWeb
      ? []
      : [
          {
            id: 'updates',
            setting: 'notifications.updates' as const,
            group: when,
            render: () => (
              <NotificationSwitch field="updates" label={t('notifications.updates.name')} />
            ),
          },
          {
            id: 'plan-limits',
            setting: 'notifications.plan-limits' as const,
            group: when,
            render: () => (
              <NotificationSwitch field="planLimits" label={t('notifications.planLimits.name')} />
            ),
          },
        ]),
    {
      id: 'sound',
      setting: 'notifications.sound',
      group: how,
      render: () => <NotificationSwitch field="sound" label={t('notifications.sound.name')} />,
    },
  ]
  // The notch island is the macOS app's own; a browser has none.
  if (isMac && !isWeb) {
    rows.push({
      id: 'island',
      setting: 'notifications.island',
      group: how,
      description: islandDescription,
      render: () => <IslandSwitch label={t('notifications.island.name')} />,
    })
  }
  // Linux desktops differ in how they show a count, so the row is left out there.
  if (platform !== 'linux') {
    const name = isMac ? t('notifications.badge.nameDock') : t('notifications.badge.nameTaskbar')
    rows.push({
      id: 'badge',
      setting: 'notifications.badge',
      group: how,
      render: () => <NotificationSwitch field="badge" label={name} />,
    })
  }
  return {
    id: 'notifications',
    title: t('sections.notifications'),
    description: t('pages.notifications', onHost),
    icon: Notification01Icon,
    rows,
  }
}

export function useAccountSection(): SectionDef {
  const { t } = useTranslation('settings')
  const status = useAccountStore((s) => s.status)
  const signedIn = status?.state === 'signed-in' ? status : null
  const card = group('account', t('account.name'), {
    unlabeled: true,
    note: signedIn?.plainText && <GroupNote>{t('account.plainText')}</GroupNote>,
  })
  const rows: RowDef[] = [
    {
      id: 'account',
      setting: 'account.account',
      // Not the email, which search results would show past Hide account.
      description: signedIn ? null : undefined,
      group: card,
      layout: 'custom',
      render: () => <AccountRow />,
    },
  ]
  const plan = signedIn?.plan
  const usage = signedIn?.usage
  if (plan) {
    rows.push({
      id: 'plan',
      setting: 'account.plan',
      group: card,
      render: () => <PlanName plan={plan} />,
    })
  }
  if (plan && usage) {
    rows.push(
      {
        id: 'devices',
        setting: 'account.devices',
        group: card,
        render: () => <DeviceUsage plan={plan} usage={usage} />,
      },
      {
        id: 'storage',
        setting: 'account.storage',
        group: card,
        render: () => <StorageUsage plan={plan} usage={usage} />,
      },
    )
  }
  const points = signedIn?.points
  if (signedIn && points != null) {
    rows.push({
      id: 'points',
      setting: 'account.points',
      group: card,
      render: () => <PointsBalance points={points} url={signedIn.pointsUrl} />,
    })
  }
  if (signedIn && signedIn.subscription !== 'none') {
    rows.push({
      id: 'subscription',
      setting: 'account.subscription',
      group: card,
      render: () => <SubscriptionState status={signedIn.subscription} />,
    })
  }
  return {
    id: 'account',
    title: t('sections.account'),
    description: t('pages.account'),
    icon: UserCircleIcon,
    rows,
    footer: <AccountNote />,
  }
}

export function useUsageSection(): SectionDef {
  const { t } = useTranslation('usage')
  const onHost = useHostContext()
  const { hostId, useSettingsStore, useUsageStore } = useHostScope()
  const fromComputer = useSettingsStore((s) => s.settings.usage.fromComputer)
  // Strings only: the status is a new object at every step of a scan.
  const logIds = useUsageStore(useShallow((s) => (s.status?.logs ?? []).map((log) => log.agentId)))
  const logPlaces = useUsageStore(
    useShallow((s) => (s.status?.logs ?? []).map((log) => log.locations.join(' '))),
  )
  const sources = group('sources', t('settings.groups.sources'))
  const rows: RowDef[] = [
    {
      id: 'from-computer',
      setting: 'usage.from-computer',
      params: onHost,
      group: sources,
      render: () => <FromComputer />,
    },
  ]
  if (fromComputer) {
    const logGroup = group('logs', t('settings.groups.logs'), {
      count: logIds.length,
      actions: <SyncLogs />,
    })
    rows.push(
      ...logIds.map((agentId, i): RowDef => ({
        id: `logs-${agentId}`,
        setting: 'usage.logs',
        item: { name: agentName(agentId, hostId), description: logPlaces[i] ?? '' },
        group: logGroup,
        layout: 'custom',
        render: () => <LogRow agentId={agentId} />,
      })),
    )
  }
  rows.push(
    {
      id: 'sidebar',
      setting: 'usage.sidebar',
      group: group('display', t('settings.groups.display')),
      render: () => <SidebarEnd />,
    },
    {
      id: 'clear-record',
      setting: 'usage.clear-record',
      group: group('danger', t('settings.groups.danger')),
      render: () => <ClearRecord />,
    },
  )
  return {
    id: 'usage',
    title: t('settings.title'),
    description: t('settings.description'),
    icon: PieChartIcon,
    rows,
  }
}

export function useAgentsSection(): SectionDef {
  const { t } = useTranslation('settings')
  const onHost = useHostContext()
  const { useAgentsStore } = useHostScope()
  const agents = useAgentsStore(useShallow((s) => usableAgents(s.order, s.byId)))
  const idleRows = useIdleSessionRows()
  const workflowRows = useWorkflowRows()
  // The footer goes under the list, so the workflow groups after it keep their own notes.
  const list: GroupDef =
    agents.length === 0
      ? {
          id: 'agents',
          label: t('agents.groups.list', onHost),
          actions: <AgentsGroupActions />,
          unlabeled: true,
          note: <AgentsFooter />,
        }
      : {
          id: 'agents',
          label: t('agents.groups.list', onHost),
          count: agents.length,
          actions: <AgentsGroupActions />,
          note: <AgentsFooter />,
        }
  const row = (status: AgentStatus): RowDef => ({
    id: status.id,
    setting: 'agents.agents',
    item: {
      name: status.name,
      ...(status.account?.label ? { description: status.account.label } : {}),
      keywords: `${status.harnessName} ${
        status.account?.kind === 'none' ? '' : (status.account?.email ?? '')
      }`,
    },
    group: list,
    layout: 'custom',
    render: () => <AgentListItem status={status} />,
    open: () => openAgentSettings(status.id),
  })
  return {
    id: 'agents',
    title: t('sections.agents'),
    description: t('pages.agents', onHost),
    icon: AiBrain01Icon,
    rows: [
      ...(agents.length === 0
        ? ([
            {
              id: 'no-agents',
              setting: 'agents.agents',
              item: { name: t('agents.empty.title'), keywords: t('agents.empty.keywords') },
              group: list,
              layout: 'custom' as const,
              render: () => <NoAgents />,
            },
          ] satisfies RowDef[])
        : ([
            ...agents.map(row),
            {
              // Search still finds it; the list's head carries the one Add agent.
              id: 'add-agent',
              setting: 'agents.add-agent',
              group: list,
              searchOnly: true,
              layout: 'custom' as const,
              render: () => null,
            },
          ] satisfies RowDef[])),
      ...idleRows,
      ...workflowRows,
    ],
    itemPage: (agentId) => <AgentPage agentId={agentId as AgentId} />,
  }
}

export function useHarnessesSection(): SectionDef {
  const { t } = useTranslation('settings')
  const { useAgentsStore } = useHostScope()
  const harnesses = useAgentsStore(useShallow((s) => harnessStatuses(s.order, s.byId)))
  const environment = useAgentsStore((s) => s.environment)
  // Installed: its program is on the machine, too old or waiting for Node.js included, with any
  // package Kettu adds for it.
  const installed = harnesses.filter((h) => programHere(h) && !awaitsPackage(h) && !h.uninstalled)
  const missing = harnesses.filter((h) => !installed.includes(h))
  const groups = {
    installed: {
      id: 'installed',
      label: t('harnesses.groups.installed'),
      count: installed.length,
      actions: <HarnessGroupActions />,
    },
    missing: { id: 'missing', label: t('harnesses.groups.notInstalled'), count: missing.length },
  }
  const row = (status: AgentStatus, group: GroupDef): RowDef => ({
    id: status.harnessId,
    setting: 'harnesses.installed',
    item: { name: status.harnessName },
    group,
    layout: 'custom',
    render: () => <HarnessListItem status={status} />,
    open: () => openHarnessSettings(status.harnessId),
  })
  const updates = harnesses.filter((h) => h.update || h.cli?.update)
  return {
    id: 'harnesses',
    title: t('sections.harnesses'),
    description: t('pages.harnesses'),
    icon: PackageIcon,
    rows: [
      ...installed.map((h) => row(h, groups.installed)),
      ...missing.map((h) => row(h, groups.missing)),
      {
        id: 'environment',
        setting: 'harnesses.environment',
        description: environmentText(t, environment),
        searchOnly: true,
        render: () => null,
      },
    ],
    footer: <EnvironmentFooter />,
    itemPage: (harnessId) => <HarnessPage harnessId={harnessId as HarnessId} />,
    mark:
      updates.length > 0
        ? t('agents.update.mark', { names: updates.map((h) => h.harnessName).join(', ') })
        : undefined,
  }
}

export function useTerminalSection(): SectionDef {
  const { t } = useTranslation('settings')
  return {
    id: 'terminal',
    title: t('sections.terminal'),
    description: t('pages.terminal'),
    icon: ComputerTerminal01Icon,
    rows: [
      {
        id: 'shell',
        setting: 'terminal.shell',
        description: isWindows
          ? t('terminal.shell.descriptionWindows')
          : t('terminal.shell.description'),
        group: group('shell', t('terminal.groups.shell')),
        render: () => <ShellPicker />,
      },
      {
        id: 'font-family',
        setting: 'terminal.font-family',
        group: group('display', t('terminal.groups.display')),
        render: () => <FontFamily label={t('terminal.fontFamily.name')} />,
      },
      {
        id: 'font-size',
        setting: 'terminal.font-size',
        group: group('display', t('terminal.groups.display')),
        // The preview closes the group, with no line under it.
        layout: 'bare',
        render: (text) => <FontSize label={text} />,
      },
    ],
  }
}

export function useGitSection(): SectionDef {
  const { t } = useTranslation('settings')
  const tools = group('tools', t('git.groups.tools'))
  return {
    id: 'git',
    title: t('sections.git'),
    description: t('pages.git'),
    icon: GitBranchIcon,
    rows: [
      {
        id: 'git',
        setting: 'git.git',
        group: tools,
        render: () => <GitTool />,
      },
      {
        id: 'gh',
        setting: 'git.gh',
        group: tools,
        render: () => <GhTool />,
      },
      {
        id: 'fetch',
        setting: 'git.fetch',
        group: group('sync', t('git.groups.sync')),
        render: () => <BackgroundFetch />,
      },
      {
        id: 'worktree-root',
        setting: 'git.worktree-root',
        group: group('worktrees', t('git.groups.worktrees')),
        render: () => <WorktreeLocation />,
      },
    ],
  }
}

export function useBrowserSection(): SectionDef {
  const { t } = useTranslation('settings')
  const { sites, error, remove, reload } = useAllowedSites()
  const remembered = useSettingsStore((s) => Object.keys(s.settings.thread.alwaysOpenIn).length)
  const allowed = group('allowed-sites', t('browser.groups.allowedSites'), {
    count: sites?.length,
    note: (
      <>
        {error && sites !== null && <GroupNote>{error}</GroupNote>}
        <GroupNote>{t('browser.allowedSites.note')}</GroupNote>
      </>
    ),
  })
  const links = group('links-from-agents', t('browser.groups.links'))
  const brought = useBroughtSites()
  const [allBrought, setAllBrought] = useState(false)
  const signIns = group('sign-ins', t('browser.groups.signIns'))
  const shownBrought = allBrought ? (brought ?? []) : (brought ?? []).slice(0, BROUGHT_SHOWN)
  // Kettu's browser, which sign-ins are brought into, runs in the desktop app alone.
  const signInRows: RowDef[] = isWeb
    ? []
    : [
        {
          id: 'bring-sign-ins',
          setting: 'browser.bring-sign-ins',
          group: signIns,
          layout: 'custom',
          render: () => <BringSignInsRow />,
        },
        ...shownBrought.map((site): RowDef => ({
          id: `brought-${site.site}`,
          setting: 'browser.brought-sites',
          item: { name: site.site },
          group: signIns,
          layout: 'custom',
          render: () => <BroughtSiteRow site={site} />,
        })),
        ...((brought?.length ?? 0) > BROUGHT_SHOWN
          ? [
              {
                id: 'brought-more',
                setting: 'browser.brought-sites',
                item: { name: t('browser.signIns.showAll', { count: brought!.length }) },
                group: signIns,
                layout: 'custom',
                render: () => (
                  <BroughtMoreRow
                    count={brought!.length}
                    all={allBrought}
                    onToggle={() => setAllBrought((all) => !all)}
                  />
                ),
              } satisfies RowDef,
            ]
          : []),
      ]
  const rows: RowDef[] = [
    ...signInRows,
    {
      id: 'open-links-in',
      setting: 'browser.open-links-in',
      description: t('browser.openLinksIn.description', { mod: formatShortcut('Mod') }),
      group: links,
      render: () => <OpenLinksIn label={t('browser.openLinksIn.name')} />,
    },
    {
      id: 'confirm-links',
      setting: 'browser.confirm-links',
      group: links,
      render: () => <ConfirmLinks label={t('browser.confirmLinks.name')} />,
    },
    // Shown once the "Open link?" dialog has remembered a site: there is nothing to manage before.
    ...(remembered > 0
      ? [
          {
            id: 'remembered-sites',
            setting: 'browser.remembered-sites',
            group: links,
            layout: 'block',
            render: (text) => <RememberedSitesList label={text} />,
          } satisfies RowDef,
        ]
      : []),
    {
      id: 'clear-data',
      setting: 'browser.clear-data',
      group: group('site-data', t('browser.groups.siteData')),
      render: () => <ClearBrowsingData />,
    },
    {
      id: 'allowed-sites',
      setting: 'browser.allowed-sites',
      searchOnly: !!sites?.length,
      group: allowed,
      layout: 'custom',
      render: () => (
        <AllowedSitesState
          loading={sites === null && error === null}
          error={sites === null ? error : null}
          onRetry={reload}
        />
      ),
    },
    // The web client has no built-in browser, so no sites it allows.
    ...(isWeb ? [] : (sites ?? [])).map((site): RowDef => ({
      id: `site-${site.origin}`,
      setting: 'browser.allowed-sites',
      item: { name: originLabel(site.origin) },
      group: allowed,
      layout: 'custom',
      render: () => <AllowedSiteRow site={site} onRemove={() => remove(site.origin)} />,
    })),
  ]
  return {
    id: 'browser',
    title: t('sections.browser'),
    // The web client shows only the links rows: the built-in browser runs in the desktop app.
    description: isWeb ? t('pages.browserWeb') : t('pages.browser'),
    icon: Globe02Icon,
    rows,
  }
}

export function useAdvancedSection(): SectionDef {
  const { t } = useTranslation('settings')
  const onHost = useHostContext()
  const { hostId } = useHostScope()
  const debugOn = useDebugStore((s) => s.status.on)
  const data = group('data', t('advanced.groups.data'))
  return {
    id: 'advanced',
    title: t('sections.advanced'),
    description: t('pages.advanced', onHost),
    icon: Setting07Icon,
    rows: [
      {
        id: 'proxy',
        setting: 'advanced.proxy',
        group: group('network', t('advanced.groups.network')),
        layout: 'block',
        render: (text) => <Proxy label={text} />,
      },
      {
        id: 'report',
        setting: 'advanced.report',
        group: data,
        render: () => <ReportProblem />,
      },
      // The log files and their switch are this computer's; a host elsewhere keeps its own.
      ...(isWeb || hostId !== null
        ? []
        : ([
            {
              id: 'logs',
              setting: 'advanced.logs',
              group: data,
              render: () => <LogsFolderActions />,
            },
            {
              id: 'record-steps',
              setting: 'advanced.record-steps',
              group: data,
              render: () => <RecordSteps />,
            },
            {
              id: 'detailed-records',
              setting: 'advanced.detailed-records',
              group: data,
              render: () => <DetailedRecords label={t('advanced.detailedRecords.name')} />,
            },
            {
              id: 'debug-mode',
              setting: 'advanced.debug-mode',
              description: debugOn
                ? t('advanced.debugMode.descriptionOn')
                : t('advanced.debugMode.description'),
              group: data,
              layout: 'block' as const,
              render: (text: ReactNode) => <DebugModeRow text={text} />,
            },
          ] satisfies RowDef[])),
      {
        id: 'data-folder',
        setting: 'advanced.data-folder',
        rich: <DataFolderText />,
        group: data,
        render: () => <DataFolderActions />,
      },
      {
        id: 'remove-sessions',
        setting: 'advanced.remove-sessions',
        group: group('danger', t('advanced.groups.danger')),
        render: () => <RemoveAll />,
      },
    ],
  }
}

export function useAboutSection(): SectionDef {
  const { t } = useTranslation('settings')
  const status = useUpdatesStore((s) => s.status)
  const info = useAppInfo()
  // A host whose Kettu Settings cannot update, as the daemon's, says so in the row.
  const updatable = useHostHas('updates')
  const githubOnly = useGitHubOnly()
  const cloudOffHere = useCloudOffHere()
  const updates = group('updates', t('about.groups.updates'))
  return {
    id: 'about',
    title: t('sections.about'),
    description: t('pages.about'),
    icon: InformationCircleIcon,
    hero: <AboutHero info={info} />,
    rows: [
      {
        id: 'update',
        setting: 'about.update',
        group: updates,
        layout: 'block',
        render: () => (updatable === false ? <NoUpdates /> : <UpdateRow status={status} />),
      },
      ...(updatable === false || status?.state.kind === 'off'
        ? []
        : ([
            {
              id: 'automatic',
              setting: 'about.automatic',
              group: updates,
              render: () => <AutomaticUpdates />,
            },
            {
              id: 'source',
              setting: 'about.source',
              description: cloudOffHere
                ? t('about.source.local')
                : githubOnly
                  ? t('about.source.githubDetail')
                  : t('about.source.autoDetail'),
              group: updates,
              render: () => <DownloadSource />,
            },
          ] satisfies RowDef[])),
      {
        id: 'github',
        setting: 'about.github',
        searchOnly: true,
        render: () => null,
      },
    ],
  }
}

/** More archived rows than a tall window shows, drawn in full as the page opens. */
const ARCHIVED_EAGER = 30

export function useArchivedSection(): SectionDef {
  const { t } = useTranslation(['settings', 'sidebar'])
  const { hostId } = useHostScope()
  const archived = useSessionsStore(useShallow((s) => archivedSessions(s.byId, hostId)))
  const projects = useProjectsStore((s) => s.projects)
  const where = (summary: SessionSummary) =>
    summary.scratch
      ? t('sidebar:project.noProject')
      : (projects.find((p) => p.path === summary.projectPath)?.name ??
        basename(summary.projectPath))
  const list = group('archived', t('archived.group'), { count: archived.length })
  return {
    id: 'archived',
    title: t('sections.archived'),
    description: t('pages.archived'),
    icon: Archive01Icon,
    rows: archived.map((summary, i): RowDef => ({
      id: summary.id,
      setting: 'archived.sessions',
      item: {
        name: sessionTitle(summary),
        description: where(summary),
        keywords: agentName(summary.agentId, hostId),
      },
      group: list,
      layout: 'custom',
      render: () => (
        <ArchivedRow summary={summary} where={where(summary)} eager={i < ARCHIVED_EAGER} />
      ),
    })),
    footer: archived.length === 0 && (
      <EmptyCard title={t('archived.emptyTitle')} hint={t('archived.emptyHint')} />
    ),
  }
}

/**
 * Settings > Hosts in the web client, which reaches only the host that served its page: that host,
 * this browser's name on it, and forgetting it here.
 */
function useWebHostsSection(): SectionDef {
  const { t } = useTranslation('settings')
  const host = useWebHostStore((s) => s.host)
  const name = host?.name ?? ''
  const online = host?.connection.state === 'online'
  return {
    id: 'hosts',
    title: t('sections.hosts'),
    description: t('pages.hostsWeb'),
    icon: ServerStack02Icon,
    rows: [
      {
        id: 'hosts',
        setting: 'hosts.hosts',
        description: t('pages.hostsWeb'),
        searchOnly: true,
        render: () => null,
      },
      {
        id: 'host',
        setting: 'hosts.web-host',
        item: {
          name: name || t('sections.hosts'),
          ...(host ? { description: webHostLine(t, host) } : {}),
        },
        group: group('host', t('sections.hosts'), { unlabeled: true }),
        layout: 'custom',
        render: () => (host ? <WebHostRow host={host} /> : <HostsLoading />),
      },
      {
        id: 'device-name',
        setting: 'hosts.device-name',
        description: online
          ? t('hosts.web.nameDescription', { name })
          : t('hosts.web.nameOffline', { name }),
        group: group('self', t('hosts.web.self', { name })),
        render: () => <BrowserNameField />,
      },
      {
        id: 'forget',
        setting: 'hosts.forget',
        params: { name },
        group: group('forget', t('hosts.web.forget.name', { name }), { unlabeled: true }),
        render: () => <ForgetHost />,
      },
      ...(isHosted || isRelayPage
        ? ([
            {
              id: 'others',
              setting: 'hosts.others',
              description: t(
                isRelayPage ? 'hosts.web.others.descriptionRelay' : 'hosts.web.others.description',
                { name },
              ),
              group: group('others', t('hosts.web.others.name')),
              layout: 'custom' as const,
              render: () => <OtherWebHosts />,
            },
          ] satisfies RowDef[])
        : []),
    ],
  }
}

/** Settings > Hosts: the hosts this computer connects to, or in a browser the one it does. */
export function useHostsSection(): SectionDef {
  const desktop = useDesktopHostsSection()
  const web = useWebHostsSection()
  return isWeb ? web : desktop
}

function useDesktopHostsSection(): SectionDef {
  const { t } = useTranslation('settings')
  const status = useHostsStore((s) => s.status)
  const discovered = useDiscoveredHosts()
  const cloudOff = useCloudOff()
  // Read when Settings opens: the computer's model is read only then.
  useEffect(() => {
    void loadHosts()
  }, [])
  const list = group('hosts', t('sections.hosts'), {
    actions: <AddHostButton />,
    note: <HostsNote />,
  })
  const hosts = status?.hosts
  const rows: RowDef[] = [
    {
      id: 'hosts',
      setting: 'hosts.hosts',
      searchOnly: true,
      render: () => null,
    },
    {
      id: 'add-host',
      setting: 'hosts.add-host',
      searchOnly: true,
      render: () => null,
    },
    {
      id: 'this-computer',
      setting: 'hosts.this-computer',
      item: {
        name: status?.self.name ?? t('hosts.self.label'),
        description: t('hosts.self.label'),
      },
      group: list,
      layout: 'custom',
      render: () => (status ? <SelfRow self={status.self} /> : <HostsLoading />),
    },
    ...(hosts ?? []).map((host): RowDef => ({
      id: host.id,
      setting: 'hosts.hosts',
      item: { name: host.name, description: hostLine(t, host) },
      group: list,
      layout: 'custom',
      render: () => <HostRow host={host} />,
      open: () => openSettingsItem('hosts', host.id),
    })),
  ]
  if (status && hosts === null) {
    rows.push({
      id: 'hosts-loading',
      setting: 'hosts.hosts',
      group: list,
      layout: 'custom',
      render: () => <HostsLoading />,
    })
  }
  const account = group('account-hosts', t('hosts.account.group'), {
    actions: <AccountHostsActions signedOut={discovered?.state === 'signed_out'} />,
    note: <GroupNote>{t('hosts.account.note')}</GroupNote>,
  })
  const found = discovered?.state === 'ok' ? discovered.hosts : []
  // The account's computers are found through the relay, which a self-hosted computer never uses.
  if (!cloudOff) {
    rows.push(
      {
        id: 'account-hosts',
        setting: 'hosts.account-hosts',
        group: account,
        layout: 'custom',
        searchOnly: found.length > 0,
        render: () => <AccountHostsState discovered={discovered} />,
      },
      ...found.map((host): RowDef => ({
        id: `account-${host.relayId}`,
        setting: 'hosts.account-hosts',
        item: { name: host.name, description: platformName(host.platform) },
        group: account,
        layout: 'custom',
        render: () => <AccountHostRow host={host} />,
      })),
    )
  }
  return {
    id: 'hosts',
    title: t('sections.hosts'),
    description: t('pages.hosts'),
    icon: ServerStack02Icon,
    rows,
    itemPage: (id: string) => <HostPage id={id} />,
  }
}

export function useRemoteSection(): SectionDef {
  const { t } = useTranslation('settings')
  const onHost = useHostContext()
  const { useSettingsStore, useRemoteStore } = useHostScope()
  const enabled = useSettingsStore((s) => s.settings.remote.enabled)
  const relayChoice = useSettingsStore((s) => s.settings.remote.relay)
  const status = useRemoteStore((s) => s.status)
  const resettable = useHostHas('remoteReset')
  // Finding this computer and the relay are the account's, so self-hosted it shows neither.
  const cloudOff = useCloudOffHere()
  const state = group('status', t('remote.switch'), {
    unlabeled: true,
    note: enabled && <PlainKeyNote />,
  })
  const switchRow: RowDef = {
    id: 'remote',
    setting: 'remote.remote',
    params: onHost,
    group: state,
    layout: 'custom',
    render: () => <RemoteSwitchRow />,
  }
  const base = {
    id: 'remote' as const,
    title: t('sections.remote'),
    description: t('pages.remote', onHost),
    icon: Wifi01Icon,
    itemPage: (id: string) => <DevicePage id={id} />,
  }
  const devices = status?.devices ?? []
  const online = status?.online ?? []
  const list = group('devices', t('remote.devices.group'), {
    count: devices.length > 0 ? devices.length : undefined,
    actions: devices.length > 0 && <AddDeviceButton disabled={!enabled} />,
    note: enabled ? (
      <StaleNote />
    ) : (
      <>
        <StaleNote />
        <GroupNote>{t('remote.devices.addOff')}</GroupNote>
      </>
    ),
  })
  const deviceRows: RowDef[] = [
    ...devices.map((device): RowDef => ({
      id: device.id,
      setting: 'remote.devices',
      item: { name: device.name, description: deviceLine(t, device) },
      group: list,
      layout: 'custom',
      render: () => <DeviceRow device={device} online={online.includes(device.id)} />,
      open: () => openSettingsItem('remote', device.id),
    })),
    {
      id: 'add-device',
      setting: 'remote.add-device',
      group: list,
      layout: devices.length === 0 ? 'custom' : undefined,
      searchOnly: devices.length > 0,
      render: () => (devices.length === 0 ? <NoDevices /> : null),
    },
  ]
  // Off, the devices are still listed to rename and remove; only adding one waits.
  if (!enabled)
    return { ...base, rows: devices.length > 0 ? [switchRow, ...deviceRows] : [switchRow] }
  const direct = group('direct', t('remote.direct.group'))
  // The choices are cards of their own, so the group draws on the page.
  const relayGroup = group('relay', t('remote.relay.group'), { plain: true, note: <RelayNote /> })
  const permissions = group('permissions', t('remote.groups.permissions'))
  const rows: RowDef[] = [
    switchRow,
    {
      id: 'host-name',
      setting: 'remote.host-name',
      params: onHost,
      group: state,
      render: () => <HostNameField label={t('remote.hostName.name', onHost)} />,
    },
    ...deviceRows,
    {
      id: 'relay',
      setting: 'remote.relay',
      params: onHost,
      group: relayGroup,
      layout: 'custom',
      render: () => <RelayChoices />,
    },
    ...(relayChoice === 'kettu' && !cloudOff
      ? [
          {
            id: 'relay-regions',
            setting: 'remote.relay-regions',
            group: relayGroup,
            // Drawn in the Kettu relay's card, which search lands on.
            searchOnly: true,
            render: () => null,
          } satisfies RowDef,
        ]
      : []),
    {
      id: 'direct',
      setting: 'remote.direct',
      description: t(
        relayInUse(status) && (!cloudOff || relayChoice === 'own')
          ? 'remote.direct.descriptionFree'
          : 'remote.direct.description',
      ),
      group: direct,
      render: () => <DirectSwitch label={t('remote.direct.name')} />,
    },
    {
      id: 'direct-port',
      setting: 'remote.direct-port',
      group: direct,
      render: () => <DirectPortField label={t('remote.direct.port.name')} />,
    },
    {
      id: 'direct-found',
      setting: 'remote.direct-found',
      params: onHost,
      group: direct,
      layout: 'block',
      render: (text) => <FoundAddresses text={text} />,
    },
    {
      id: 'direct-own',
      setting: 'remote.direct-own',
      group: direct,
      layout: 'block',
      render: (text) => <OwnAddresses text={text} />,
    },
    {
      id: 'terminal',
      setting: 'remote.terminal',
      params: onHost,
      group: permissions,
      render: () => <TerminalSwitch label={t('remote.terminal.name')} />,
    },
    ...(cloudOff
      ? []
      : [
          {
            id: 'discoverable',
            setting: 'remote.discoverable',
            params: onHost,
            // Only the Kettu relay names this computer to the account; dimmed, it says so.
            description: relayChoice === 'own' ? t('remote.relay.onlyKettu') : undefined,
            group: permissions,
            render: () => <DiscoverableSwitch label={t('remote.discoverable.name')} />,
          } satisfies RowDef,
        ]),
  ]
  if (resettable !== false) {
    rows.push({
      id: 'reset',
      setting: 'remote.reset',
      params: onHost,
      group: group('danger', t('remote.groups.danger')),
      render: () => <ResetRemote />,
    })
  }
  return { ...base, rows }
}

/** Each published artifact's title, read while there are published pages to name. */
function usePublishedTitles(some: boolean): ReadonlyMap<string, string> {
  useEffect(() => {
    if (!some) return
    artifactListShown(true)
    return () => artifactListShown(false)
  }, [some])
  const list = useArtifactsStore((s) => s.list)
  const deleted = useArtifactsStore((s) => s.deleted)
  return useMemo(
    () => new Map([...(deleted ?? []), ...(list ?? [])].map((item) => [item.id, item.title])),
    [list, deleted],
  )
}

export function useSharingSection(): SectionDef {
  const { t } = useTranslation('settings')
  const { hostId, sharing } = useHostScope()
  const { useSharingStore } = sharing
  const account = useSharingStore((s) => s.status?.cloudflare ?? null)
  const kettu = useSharingStore((s) => s.status?.kettu.account ?? null)
  const pages = useSharingStore(useShallow((s) => s.status?.published ?? []))
  const blocked = useSharingStore(useShallow((s) => s.status?.auto.blocked ?? []))
  // Another host's artifacts are not listed here, so its pages go by their addresses.
  const titles = usePublishedTitles(hostId === null && pages.length > 0)
  const shares = useHostHas('sharing')
  const cloudOff = useCloudOffHere()
  const base = {
    id: 'sharing' as const,
    title: t('sections.sharing'),
    description: t('pages.sharing'),
    icon: Share08Icon,
  }
  // A host that publishes nothing, as the daemon, says so in place of the account and the pages.
  if (shares !== true) {
    return {
      ...base,
      rows: [
        {
          id: 'cloudflare',
          setting: 'sharing.cloudflare',
          description: shares === false ? t('sharing.none.title') : null,
          searchOnly: true,
          render: () => null,
        },
      ],
      footer: shares === false ? <NoSharing /> : <SharingPending />,
    }
  }
  const rows: RowDef[] = []
  // Self-hosted, nothing publishes to Kettu, so only the own Cloudflare account and the pages show.
  if (!cloudOff) {
    const kettuGroup = group('kettu', t('sharing.groups.kettu'))
    const full = blocked.filter((entry) => entry.reason === 'storage_full').length
    const large = blocked.length - full
    rows.push(
      {
        id: 'kettu',
        setting: 'sharing.kettu',
        // Not the email, which search results would show past Hide account.
        description: kettu ? null : undefined,
        group: kettuGroup,
        layout: 'custom',
        render: () => <KettuSharingAccount />,
      },
      {
        id: 'auto',
        setting: 'sharing.auto',
        description: [
          t('sharing.auto.description'),
          ...(full > 0 ? [t('sharing.auto.blockedFull', { count: full })] : []),
          ...(large > 0 ? [t('sharing.auto.blockedLarge', { count: large })] : []),
        ].join(' '),
        group: kettuGroup,
        render: () => <AutoPublishSwitch />,
      },
    )
    if (kettu) {
      rows.push({
        id: 'kettu-storage',
        setting: 'sharing.kettu-storage',
        group: kettuGroup,
        render: () => <KettuStorage />,
      })
    }
  }
  const published: RowDef[] = []
  if (pages.length > 0) {
    const list = group('published', t('sharing.groups.published'), { count: pages.length })
    published.push(
      ...pages.map((page): RowDef => {
        const title = titles.get(page.id)
        return {
          id: `published-${page.id}`,
          setting: 'sharing.published',
          item: {
            name: title ?? page.url,
            description: title
              ? page.url
              : t('sharing.published.version', {
                  version: page.version,
                  ago: mediumAgo(page.publishedAt),
                }),
          },
          group: list,
          layout: 'custom',
          render: () => <PublishedRow page={page} title={title} />,
        }
      }),
    )
  }
  const cloudflare: RowDef = {
    id: 'cloudflare',
    setting: 'sharing.cloudflare',
    description: account ? `${account.subdomain}.workers.dev` : t('sharing.account.description'),
    group: group('cloudflare', t('sharing.groups.account')),
    layout: 'custom',
    render: () => <SharingAccount />,
  }
  if (pages.length === 0) {
    published.push({
      id: 'published-empty',
      setting: 'sharing.published',
      group: group('published', t('sharing.groups.published')),
      layout: 'custom',
      render: () => <p className="ui-ss-empty">{t('sharing.published.empty')}</p>,
    })
  }
  // The pages sit between the Kettu account and Cloudflare; self-hosted, they follow Cloudflare.
  if (cloudOff) rows.push(cloudflare, ...published)
  else rows.push(...published, cloudflare)
  return { ...base, rows }
}

/** What the user allowed the artifacts' pages on the host, read again whenever it changes. */
function useConsents() {
  const { request } = useHostScope()
  const [rows, setRows] = useState<ArtifactConsentRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    const load = (): void => {
      request('artifacts.consents', undefined).then(
        (list) => {
          if (!live) return
          setRows(list)
          setError(null)
        },
        (reason: unknown) => {
          if (live) setError(errorMessage(reason))
        },
      )
    }
    load()
    const off = window.kettu.agents.onEvent((event) => {
      if (event.type === 'artifacts.consentsChanged') load()
    })
    return () => {
      live = false
      off()
    }
  }, [request, attempt])
  return { rows, error, retry: () => setAttempt((n) => n + 1) }
}

/** Settings › Artifacts: the pages the user allowed to read project files or ask the agent. */
export function useArtifactsSection(): SectionDef {
  const { t } = useTranslation('settings')
  const { rows, error, retry } = useConsents()
  const projects = useProjectsStore((s) => s.projects)
  const where = (row: ArtifactConsentRow): string =>
    projects.find((p) => p.path === row.project)?.name ?? basename(row.project)
  const list = group('page-permissions', t('artifacts.group'))
  return {
    id: 'artifacts',
    title: t('sections.artifacts'),
    description: t('pages.artifacts'),
    icon: DashboardSquare02Icon,
    rows: (rows ?? []).map((row): RowDef => ({
      id: `consent-${row.artifactId}`,
      setting: 'artifacts.page-permissions',
      item: { name: row.title, description: where(row) },
      group: list,
      layout: 'custom',
      render: () => <ConsentRow row={row} where={where(row)} />,
    })),
    footer:
      rows === null ? (
        <ConsentsState state={error ? 'failed' : 'loading'} error={error} onRetry={retry} />
      ) : (
        rows.length === 0 && <ConsentsState state="empty" />
      ),
  }
}
