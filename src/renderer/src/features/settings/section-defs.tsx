import { useEffect, useMemo } from 'react'
import {
  ArchiveIcon,
  BellIcon,
  BotIcon,
  BoxesIcon,
  ChartNoAxesColumnIcon,
  GitBranchIcon,
  GlobeIcon,
  InfoIcon,
  MonitorSmartphoneIcon,
  PlugIcon,
  ServerIcon,
  SettingsIcon,
  ShareIcon,
  SquareTerminalIcon,
  SunMoonIcon,
  WrenchIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { AgentStatus, SessionSummary } from '@shared/agent-host'
import type { AgentId, HarnessId } from '@shared/thread'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@renderer/components/ui/empty'
import { bugReportUrl } from '@renderer/lib/bug-report'
import { basename, longAgo } from '@renderer/lib/format'
import { i18n } from '@renderer/lib/i18n'
import { formatShortcut, isMac, isWindows, platform } from '@renderer/lib/platform'
import { useAppInfo } from '@renderer/lib/use-app-info'
import {
  agentName,
  harnessStatuses,
  hasProgram,
  usableAgents,
  useAgentsStore,
} from '@renderer/stores/agents'
import { artifactListShown, useArtifactsStore } from '@renderer/stores/artifacts'
import { useProjectsStore } from '@renderer/stores/projects'
import { archivedSessions, sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import { useMcpStore } from '@renderer/stores/mcp'
import { loadHosts, useHostsStore } from '@renderer/stores/hosts'
import { useRemoteStore } from '@renderer/stores/remote'
import { useSharingStore } from '@renderer/stores/sharing'
import { useUpdatesStore } from '@renderer/stores/updates'
import { useUsageStore } from '@renderer/stores/usage'
import { openAgentSettings, openHarnessSettings, openSettingsItem } from '@renderer/stores/view'
import { AboutHero, AutomaticUpdates, LinkRow, UpdateRow } from './about-section'
import {
  AddAgentRow,
  AgentListItem,
  AgentPage,
  AgentsFooter,
  AgentsGroupActions,
} from './agents-section'
import {
  EnvironmentFooter,
  HarnessGroupActions,
  HarnessListItem,
  HarnessPage,
} from './harness-section'
import { AgentPlaceRow, FailedRead, McpServerPage, PendingList, ServerRow } from './mcp-section'
import { ArchivedRow } from './archived-section'
import { GroupLabel, GroupNote } from './rows'
import { SettingSwitch } from './controls'
import { HostPage } from './host-page'
import { hostLine } from './host-text'
import { HostRow, HostsHeader, HostsLoading, HostsNote, SelfRow } from './hosts-section'
import { DevicePage } from './remote-device'
import { DirectPortField, FoundAddresses, OwnAddresses } from './remote-direct'
import {
  AddDeviceRow,
  DeviceRow,
  HostNameField,
  NoDevices,
  PlainKeyNote,
  RemoteHeader,
  RemoteStatusRow,
  ResetRemote,
  StaleNote,
} from './remote-section'
import { deviceLine } from './remote-text'
import { PublishedRow, SharingAccount } from './sharing-section'
import { useLoginItemStatus } from './use-login-item'
import { environmentText } from './environment-text'
import { english, type GroupDef, type RowDef, type SectionDef } from './model'
import {
  AllowedSitesList,
  BackgroundFetch,
  ClearBrowsingData,
  ColorMode,
  ConfirmLinks,
  DataFolderActions,
  DataFolderText,
  DefaultAgent,
  Diagnostics,
  FontSize,
  GeneralSwitch,
  GhTool,
  GitTool,
  Language,
  NotificationPreview,
  NotificationSwitch,
  OpenAtLogin,
  OutlineSummaries,
  Proxy,
  ReduceMotion,
  RemoveAll,
  SendKey,
  ShellPicker,
  TestNotification,
  TextSize,
  WithKeys,
  Zoom,
} from './sections'
import { ThemeTiles } from './theme-section'
import { ClearRecord, FromComputer, LogRow, SidebarEnd, SyncLogs } from './usage-section'

// The sections of the Settings page as data, so search and the match counts read the same rows
// the page draws.

const SOURCE_URL = 'https://github.com/KettuAI/Kettu'
const LICENSE_URL = 'https://github.com/KettuAI/Kettu/blob/main/LICENSE'

function group(id: string, label: string, extra?: Omit<GroupDef, 'id' | 'label'>): GroupDef {
  return { id, label, ...extra }
}

export function useGeneralSection(): SectionDef {
  const { t } = useTranslation('settings')
  const en = english()
  const input = group('input', t('general.groups.input'))
  const sessions = group('sessions', t('general.groups.sessions'))
  const thread = group('thread', t('general.groups.thread'))
  const startup = group('startup', t('general.groups.startup'))
  const loginItem = useLoginItemStatus()
  // Devices reach the computer only while Kettu runs, so remote access holds it on.
  const remoteOn = useSettingsStore((s) => s.settings.remote.enabled)
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
    icon: SettingsIcon,
    rows: [
      {
        id: 'language',
        name: t('general.language.name'),
        english: en('general.language.name'),
        description: t('general.language.description'),
        keywords: t('general.language.keywords'),
        group: input,
        render: () => <Language />,
      },
      {
        id: 'send-key',
        name: t('general.sendKey.name'),
        english: en('general.sendKey.name'),
        description: t('general.sendKey.description'),
        keywords: t('general.sendKey.keywords'),
        group: input,
        render: () => <SendKey />,
      },
      {
        id: 'default-agent',
        name: t('general.defaultAgent.name'),
        english: en('general.defaultAgent.name'),
        description: t('general.defaultAgent.description'),
        group: sessions,
        render: () => <DefaultAgent />,
      },
      {
        id: 'restore',
        name: t('general.restore.name'),
        english: en('general.restore.name'),
        description: t('general.restore.description'),
        group: sessions,
        render: () => (
          <GeneralSwitch field="restoreLastSession" label={t('general.restore.name')} />
        ),
      },
      {
        id: 'confirm-quit',
        name: t('general.confirmQuit.name'),
        english: en('general.confirmQuit.name'),
        keywords: t('general.confirmQuit.keywords'),
        group: sessions,
        render: () => (
          <GeneralSwitch field="confirmQuitWhileRunning" label={t('general.confirmQuit.name')} />
        ),
      },
      {
        id: 'session-titles',
        name: t('general.sessionTitles.name'),
        english: en('general.sessionTitles.name'),
        description: t('general.sessionTitles.description'),
        keywords: t('general.sessionTitles.keywords'),
        group: sessions,
        render: () => (
          <GeneralSwitch field="sessionTitles" label={t('general.sessionTitles.name')} />
        ),
      },
      {
        id: 'background',
        name: t('general.background.name'),
        english: en('general.background.name'),
        description: remoteOn
          ? t('general.background.lockedByRemote')
          : isMac
            ? t('general.background.descriptionMac')
            : isWindows
              ? t('general.background.descriptionWindows')
              : t('general.background.descriptionLinux'),
        keywords: t('general.background.keywords'),
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
        id: 'confirm-links',
        name: t('general.confirmLinks.name'),
        english: en('general.confirmLinks.name'),
        description: t('general.confirmLinks.description'),
        keywords: t('general.confirmLinks.keywords'),
        group: thread,
        render: () => <ConfirmLinks label={t('general.confirmLinks.name')} />,
      },
      {
        id: 'outline-summaries',
        name: t('general.outlineSummaries.name'),
        english: en('general.outlineSummaries.name'),
        description: t('general.outlineSummaries.description'),
        keywords: t('general.outlineSummaries.keywords'),
        group: thread,
        render: () => <OutlineSummaries label={t('general.outlineSummaries.name')} />,
      },
      {
        id: 'open-at-login',
        name: t('general.openAtLogin.name'),
        english: en('general.openAtLogin.name'),
        description: openAtLoginDescription,
        keywords: t('general.openAtLogin.keywords'),
        group: startup,
        render: () => (
          <OpenAtLogin label={t('general.openAtLogin.name')} disabled={!loginItem?.available} />
        ),
      },
    ],
  }
}

export function useAppearanceSection(): SectionDef {
  const { t } = useTranslation('settings')
  const en = english()
  const scale = group('scale', t('appearance.groups.scale'))
  const zoomKeys = [formatShortcut('Mod+='), formatShortcut('Mod+-')] as const
  const zoomDescription = t('appearance.zoom.description', {
    zoomIn: zoomKeys[0],
    zoomOut: zoomKeys[1],
  })
  return {
    id: 'appearance',
    title: t('sections.appearance'),
    description: t('pages.appearance'),
    icon: SunMoonIcon,
    rows: [
      {
        id: 'theme',
        name: t('appearance.theme.name'),
        english: en('appearance.theme.name'),
        keywords: t('appearance.theme.keywords'),
        group: group('theme', t('appearance.groups.theme'), {
          actions: <ColorMode />,
          plain: true,
        }),
        layout: 'block',
        render: () => <ThemeTiles />,
      },
      {
        id: 'color-mode',
        name: t('appearance.colorMode.name'),
        english: en('appearance.colorMode.name'),
        keywords: t('appearance.colorMode.keywords'),
        searchOnly: true,
        render: () => null,
      },
      {
        id: 'zoom',
        name: t('appearance.zoom.name'),
        english: en('appearance.zoom.name'),
        description: zoomDescription,
        rich: <WithKeys text={zoomDescription} keys={zoomKeys} />,
        keywords: t('appearance.zoom.keywords'),
        group: scale,
        render: () => <Zoom />,
      },
      {
        id: 'text-size',
        name: t('appearance.textSize.name'),
        english: en('appearance.textSize.name'),
        description: t('appearance.textSize.description'),
        keywords: t('appearance.textSize.keywords'),
        group: scale,
        layout: 'block',
        render: (text) => <TextSize label={text} />,
      },
      {
        id: 'reduce-motion',
        name: t('appearance.reduceMotion.name'),
        english: en('appearance.reduceMotion.name'),
        description: t('appearance.reduceMotion.description'),
        keywords: t('appearance.reduceMotion.keywords'),
        group: group('motion', t('appearance.groups.motion')),
        render: () => <ReduceMotion />,
      },
    ],
  }
}

export function useNotificationsSection(): SectionDef {
  const { t } = useTranslation('settings')
  const en = english()
  const when = group('when', t('notifications.groups.when'))
  const how = group('how', t('notifications.groups.how'))
  const rows: RowDef[] = [
    {
      id: 'preview',
      name: t('notifications.groups.preview'),
      english: en('notifications.groups.preview'),
      description: t('notifications.test'),
      group: group('preview', t('notifications.groups.preview'), {
        actions: <TestNotification />,
        plain: true,
      }),
      layout: 'custom',
      render: () => <NotificationPreview />,
    },
    {
      id: 'permission',
      name: t('notifications.permission.name'),
      english: en('notifications.permission.name'),
      description: t('notifications.permission.description'),
      keywords: t('notifications.permission.keywords'),
      group: when,
      render: () => (
        <NotificationSwitch field="permission" label={t('notifications.permission.name')} />
      ),
    },
    {
      id: 'turn-ended',
      name: t('notifications.turnEnded.name'),
      english: en('notifications.turnEnded.name'),
      description: t('notifications.turnEnded.description'),
      group: when,
      render: () => (
        <NotificationSwitch field="turnEnded" label={t('notifications.turnEnded.name')} />
      ),
    },
    {
      id: 'routines',
      name: t('notifications.routines.name'),
      english: en('notifications.routines.name'),
      description: t('notifications.routines.description'),
      keywords: t('notifications.routines.keywords'),
      group: when,
      render: () => (
        <NotificationSwitch field="routines" label={t('notifications.routines.name')} />
      ),
    },
    {
      id: 'error',
      name: t('notifications.error.name'),
      english: en('notifications.error.name'),
      description: t('notifications.error.description'),
      group: when,
      render: () => <NotificationSwitch field="error" label={t('notifications.error.name')} />,
    },
    {
      id: 'sound',
      name: t('notifications.sound.name'),
      english: en('notifications.sound.name'),
      description: t('notifications.sound.description'),
      group: how,
      render: () => <NotificationSwitch field="sound" label={t('notifications.sound.name')} />,
    },
  ]
  // Linux desktops differ in how they show a count, so the row is left out there.
  if (platform !== 'linux') {
    const name = isMac ? t('notifications.badge.nameDock') : t('notifications.badge.nameTaskbar')
    rows.push({
      id: 'badge',
      name,
      description: t('notifications.badge.description'),
      keywords: t('notifications.badge.keywords'),
      group: how,
      render: () => <NotificationSwitch field="badge" label={name} />,
    })
  }
  return {
    id: 'notifications',
    title: t('sections.notifications'),
    description: t('pages.notifications'),
    icon: BellIcon,
    rows,
  }
}

export function useUsageSection(): SectionDef {
  const { t } = useTranslation('usage')
  const en = i18n.getFixedT('en', 'usage')
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
      name: t('settings.fromComputer.name'),
      english: en('settings.fromComputer.name'),
      description: t('settings.fromComputer.description'),
      keywords: t('settings.fromComputer.keywords'),
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
        name: agentName(agentId),
        description: logPlaces[i] ?? '',
        keywords: t('settings.groups.logs'),
        group: logGroup,
        layout: 'block',
        render: () => <LogRow agentId={agentId} />,
      })),
    )
  }
  rows.push(
    {
      id: 'sidebar',
      name: t('settings.sidebar.name'),
      english: en('settings.sidebar.name'),
      description: t('settings.sidebar.description'),
      group: group('display', t('settings.groups.display')),
      render: () => <SidebarEnd />,
    },
    {
      id: 'clear-record',
      name: t('settings.clear.name'),
      english: en('settings.clear.name'),
      description: t('settings.clear.description'),
      group: group('danger', t('settings.groups.danger'), { tone: 'danger' }),
      render: () => <ClearRecord />,
    },
  )
  return {
    id: 'usage',
    title: t('settings.title'),
    description: t('settings.description'),
    icon: ChartNoAxesColumnIcon,
    rows,
  }
}

export function useAgentsSection(): SectionDef {
  const { t } = useTranslation('settings')
  const en = english()
  const agents = useAgentsStore(useShallow((s) => usableAgents(s.order, s.byId).filter(hasProgram)))
  const hidden = useSettingsStore((s) => s.settings.privacy.hideAccount)
  const list: GroupDef = {
    id: 'agents',
    label: t('agents.groups.list'),
    count: agents.length,
    actions: <AgentsGroupActions />,
  }
  const row = (status: AgentStatus): RowDef => ({
    id: status.id,
    name: status.name,
    description: status.account?.label ?? undefined,
    // A hidden email stays out of search too, so a match cannot reveal it.
    keywords: `${t('agents.keywords')} ${status.harnessName} ${hidden ? '' : (status.account?.email ?? '')}`,
    group: list,
    layout: 'custom',
    render: () => <AgentListItem status={status} />,
    open: () => openAgentSettings(status.id),
  })
  return {
    id: 'agents',
    title: t('sections.agents'),
    description: t('pages.agents'),
    icon: BotIcon,
    rows: [
      ...agents.map(row),
      {
        id: 'add-agent',
        name: t('agents.add.button'),
        english: en('agents.add.button'),
        keywords: t('agents.add.keywords'),
        group: list,
        layout: 'custom',
        render: () => <AddAgentRow />,
      },
    ],
    footer: <AgentsFooter />,
    itemPage: (agentId) => <AgentPage agentId={agentId as AgentId} />,
  }
}

export function useHarnessesSection(): SectionDef {
  const { t } = useTranslation('settings')
  const en = english()
  const harnesses = useAgentsStore(useShallow((s) => harnessStatuses(s.order, s.byId)))
  const environment = useAgentsStore((s) => s.environment)
  // Installed: its program is on the machine, even before Kettu's package for it installs.
  const installed = harnesses.filter(hasProgram)
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
    name: status.harnessName,
    keywords: t('harnesses.keywords'),
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
    icon: BoxesIcon,
    rows: [
      ...installed.map((h) => row(h, groups.installed)),
      ...missing.map((h) => row(h, groups.missing)),
      {
        id: 'environment',
        name: t('agents.environment.reload'),
        english: en('agents.environment.reload'),
        description: environmentText(t, environment),
        keywords: t('agents.environment.keywords'),
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
  const en = english()
  return {
    id: 'terminal',
    title: t('sections.terminal'),
    description: t('pages.terminal'),
    icon: SquareTerminalIcon,
    rows: [
      {
        id: 'shell',
        name: t('terminal.shell.name'),
        english: en('terminal.shell.name'),
        description: isWindows
          ? t('terminal.shell.descriptionWindows')
          : t('terminal.shell.description'),
        group: group('shell', t('terminal.groups.shell')),
        render: () => <ShellPicker />,
      },
      {
        id: 'font-size',
        name: t('terminal.fontSize.name'),
        english: en('terminal.fontSize.name'),
        description: t('terminal.fontSize.description'),
        group: group('display', t('terminal.groups.display')),
        layout: 'block',
        render: (text) => <FontSize label={text} />,
      },
    ],
  }
}

export function useGitSection(): SectionDef {
  const { t } = useTranslation('settings')
  const en = english()
  const tools = group('tools', t('git.groups.tools'))
  return {
    id: 'git',
    title: t('sections.git'),
    description: t('pages.git'),
    icon: GitBranchIcon,
    rows: [
      {
        id: 'git',
        name: t('git.git.name'),
        english: en('git.git.name'),
        description: t('git.git.description'),
        group: tools,
        render: () => <GitTool />,
      },
      {
        id: 'gh',
        name: t('git.gh.name'),
        english: en('git.gh.name'),
        description: t('git.gh.description'),
        keywords: t('git.gh.keywords'),
        group: tools,
        render: () => <GhTool />,
      },
      {
        id: 'fetch',
        name: t('git.fetch.name'),
        english: en('git.fetch.name'),
        description: t('git.fetch.description'),
        group: group('sync', t('git.groups.sync')),
        render: () => <BackgroundFetch />,
      },
    ],
  }
}

export function useBrowserSection(): SectionDef {
  const { t } = useTranslation('settings')
  const en = english()
  return {
    id: 'browser',
    title: t('sections.browser'),
    description: t('pages.browser'),
    icon: GlobeIcon,
    rows: [
      {
        id: 'clear-data',
        name: t('browser.clearData.name'),
        english: en('browser.clearData.name'),
        description: t('browser.clearData.description'),
        keywords: t('browser.clearData.keywords'),
        group: group('site-data', t('browser.groups.siteData')),
        render: () => <ClearBrowsingData />,
      },
      {
        id: 'allowed-sites',
        name: t('browser.allowedSites.name'),
        english: en('browser.allowedSites.name'),
        description: t('browser.allowedSites.description'),
        keywords: t('browser.allowedSites.keywords'),
        group: group('allowed-sites', t('browser.groups.allowedSites')),
        layout: 'block',
        render: () => <AllowedSitesList />,
      },
    ],
  }
}

export function useAdvancedSection(): SectionDef {
  const { t } = useTranslation('settings')
  const en = english()
  const data = group('data', t('advanced.groups.data'))
  return {
    id: 'advanced',
    title: t('sections.advanced'),
    description: t('pages.advanced'),
    icon: WrenchIcon,
    rows: [
      {
        id: 'proxy',
        name: t('advanced.proxy.name'),
        english: en('advanced.proxy.name'),
        description: t('advanced.proxy.description'),
        keywords: t('advanced.proxy.keywords'),
        group: group('network', t('advanced.groups.network')),
        layout: 'block',
        render: (text) => <Proxy label={text} />,
      },
      {
        id: 'diagnostics',
        name: t('advanced.diagnostics.name'),
        english: en('advanced.diagnostics.name'),
        description: t('advanced.diagnostics.description'),
        keywords: t('advanced.diagnostics.keywords'),
        group: data,
        layout: 'block',
        render: (text) => <Diagnostics label={text} />,
      },
      {
        id: 'data-folder',
        name: t('advanced.dataFolder.name'),
        english: en('advanced.dataFolder.name'),
        description: t('advanced.dataFolder.description'),
        rich: <DataFolderText text={t('advanced.dataFolder.description')} />,
        group: data,
        render: () => <DataFolderActions />,
      },
      {
        id: 'remove-sessions',
        name: t('advanced.removeSessions.name'),
        english: en('advanced.removeSessions.name'),
        description: t('advanced.removeSessions.description'),
        keywords: t('advanced.removeSessions.keywords'),
        group: group('danger', t('advanced.groups.danger'), { tone: 'danger' }),
        render: () => <RemoveAll />,
      },
    ],
  }
}

export function useAboutSection(): SectionDef {
  const { t } = useTranslation('settings')
  const en = english()
  const status = useUpdatesStore((s) => s.status)
  const info = useAppInfo()
  const updates = group('updates', t('about.groups.updates'))
  const links = group('links', t('about.groups.links'))
  return {
    id: 'about',
    title: t('sections.about'),
    description: t('pages.about'),
    icon: InfoIcon,
    hero: <AboutHero info={info} />,
    rows: [
      {
        id: 'update',
        name: t('about.updates.name'),
        english: en('about.updates.name'),
        keywords: t('about.updates.keywords'),
        group: updates,
        layout: 'block',
        render: () => <UpdateRow status={status} />,
      },
      ...(status?.state.kind === 'off'
        ? []
        : [
            {
              id: 'automatic',
              name: t('about.automatic.name'),
              english: en('about.automatic.name'),
              description: t('about.automatic.description'),
              group: updates,
              render: () => <AutomaticUpdates />,
            },
          ]),
      {
        id: 'source',
        name: t('about.source.name'),
        english: en('about.source.name'),
        group: links,
        layout: 'custom',
        render: () => <LinkRow name={t('about.source.name')} url={SOURCE_URL} />,
      },
      {
        id: 'license',
        name: t('about.license.name'),
        english: en('about.license.name'),
        keywords: t('about.license.keywords'),
        group: links,
        layout: 'custom',
        render: () => (
          <LinkRow name={t('about.license.name')} url={LICENSE_URL} detail="Apache-2.0" />
        ),
      },
      {
        id: 'notices',
        name: t('about.notices.name'),
        english: en('about.notices.name'),
        keywords: t('about.notices.keywords'),
        group: links,
        layout: 'custom',
        render: () => (
          <LinkRow
            name={t('about.notices.name')}
            onOpen={() => window.kettu.shell.openNotices()}
            detail="third-party-notices.txt"
          />
        ),
      },
      {
        id: 'issues',
        name: t('about.issues.name'),
        english: en('about.issues.name'),
        group: links,
        layout: 'custom',
        render: () => (
          <LinkRow
            name={t('about.issues.name')}
            url={bugReportUrl(info)}
            detail="github.com/KettuAI/Kettu/issues/new"
          />
        ),
      },
    ],
  }
}

export function useMcpSection(): SectionDef {
  const { t } = useTranslation('settings')
  const en = english()
  const status = useMcpStore((s) => s.status)
  const error = useMcpStore((s) => s.error)
  const servers = status?.servers ?? []
  const places = status?.places ?? []
  const rows: RowDef[] = servers.map((server) => ({
    id: server.name,
    name: server.title,
    description: t('mcp.row.tools', { count: server.tools.length }),
    keywords: t('mcp.keywords'),
    english: en('sections.mcp'),
    group: group('kettu', t('mcp.groups.kettu'), { count: servers.length }),
    layout: 'custom',
    render: () => <ServerRow server={server} />,
    open: () => openSettingsItem('mcp', server.name),
  }))
  for (const place of places) {
    const name = agentName(place.agentId)
    rows.push({
      id: place.agentId,
      name,
      description: t('mcp.place.connects', { name }),
      keywords: `${t('mcp.place.keywords')} ${place.path} ${place.project}`,
      english: en('sections.mcp'),
      group: group('own', t('mcp.groups.own'), { count: places.length }),
      // The row itself is drawn by the section, as its place carries copy and show.
      layout: 'custom',
      render: () => <AgentPlaceRow place={place} />,
    })
  }
  return {
    id: 'mcp',
    title: t('sections.mcp'),
    description: t('pages.mcp'),
    icon: PlugIcon,
    // A read that failed shows its notice in place of both groups.
    rows: error ? [] : rows,
    itemPage: (item) => <McpServerPage name={item} />,
    footer: error ? <FailedRead error={error} /> : !status ? <PendingList /> : undefined,
  }
}

export function useArchivedSection(): SectionDef {
  const { t } = useTranslation(['settings', 'sidebar'])
  const en = english()
  const archived = useSessionsStore(useShallow((s) => archivedSessions(s.byId)))
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
    icon: ArchiveIcon,
    rows: archived.map((summary) => ({
      id: summary.id,
      name: sessionTitle(summary),
      description: where(summary),
      keywords: `${agentName(summary.agentId)} ${t('archived.keywords')}`,
      english: en('sections.archived'),
      group: list,
      layout: 'custom',
      render: () => <ArchivedRow summary={summary} where={where(summary)} />,
    })),
    footer: archived.length === 0 && (
      <Empty className="px-6 py-14">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ArchiveIcon />
          </EmptyMedia>
          <EmptyTitle>{t('archived.emptyTitle')}</EmptyTitle>
          <EmptyDescription>{t('archived.emptyHint')}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    ),
  }
}

export function useHostsSection(): SectionDef {
  const { t } = useTranslation('settings')
  const en = english()
  const status = useHostsStore((s) => s.status)
  // Read when Settings opens: the computer's model is read only then.
  useEffect(() => {
    void loadHosts()
  }, [])
  const list = group('hosts', t('sections.hosts'), { unlabeled: true, note: <HostsNote /> })
  const hosts = status?.hosts
  const rows: RowDef[] = [
    {
      id: 'hosts',
      name: t('sections.hosts'),
      english: en('sections.hosts'),
      description: t('pages.hosts'),
      keywords: t('hosts.keywords'),
      searchOnly: true,
      render: () => null,
    },
    {
      id: 'add-host',
      name: t('hosts.add.button'),
      english: en('hosts.add.button'),
      keywords: t('hosts.keywords'),
      searchOnly: true,
      render: () => null,
    },
    {
      id: 'this-computer',
      name: status?.self.name ?? t('hosts.self.label'),
      description: t('hosts.self.label'),
      group: list,
      layout: 'custom',
      render: () => (status ? <SelfRow self={status.self} /> : <HostsLoading />),
    },
    ...(hosts ?? []).map((host): RowDef => ({
      id: host.id,
      name: host.name,
      description: hostLine(t, host),
      keywords: t('hosts.keywords'),
      group: list,
      layout: 'custom',
      render: () => <HostRow host={host} />,
      open: () => openSettingsItem('hosts', host.id),
    })),
  ]
  if (status && hosts === null) {
    rows.push({
      id: 'hosts-loading',
      name: t('sections.hosts'),
      group: list,
      layout: 'custom',
      render: () => <HostsLoading />,
    })
  }
  return {
    id: 'hosts',
    title: t('sections.hosts'),
    description: t('pages.hosts'),
    icon: ServerIcon,
    hero: <HostsHeader id="settings-hosts" />,
    rows,
    itemPage: (id: string) => <HostPage id={id} />,
  }
}

export function useRemoteSection(): SectionDef {
  const { t } = useTranslation('settings')
  const en = english()
  const enabled = useSettingsStore((s) => s.settings.remote.enabled)
  const status = useRemoteStore((s) => s.status)
  const switchRow: RowDef = {
    id: 'remote',
    name: t('remote.switch'),
    english: en('remote.switch'),
    description: t('pages.remote'),
    keywords: t('remote.keywords'),
    searchOnly: true,
    render: () => null,
  }
  const base = {
    id: 'remote' as const,
    title: t('sections.remote'),
    description: t('pages.remote'),
    icon: MonitorSmartphoneIcon,
    hero: <RemoteHeader id="settings-remote" />,
    itemPage: (id: string) => <DevicePage id={id} />,
  }
  if (!enabled) return { ...base, rows: [switchRow] }
  const devices = status?.devices ?? []
  const online = status?.online ?? []
  const state = group('status', t('remote.switch'), {
    unlabeled: true,
    note: (
      <>
        <PlainKeyNote />
        <GroupNote>{t('remote.background')}</GroupNote>
      </>
    ),
  })
  const list = group('devices', t('remote.devices.group'), {
    count: devices.length > 0 ? devices.length : undefined,
    note: <StaleNote />,
  })
  const direct = group('direct', t('remote.direct.group'), {
    note: <GroupNote>{t('remote.direct.note')}</GroupNote>,
  })
  const rows: RowDef[] = [
    switchRow,
    {
      id: 'status',
      name: t('remote.switch'),
      group: state,
      layout: 'custom',
      render: () => (
        <div className="px-1">
          <RemoteStatusRow status={status} />
        </div>
      ),
    },
    {
      id: 'host-name',
      name: t('remote.hostName.name'),
      english: en('remote.hostName.name'),
      description: t('remote.hostName.description'),
      group: state,
      render: () => <HostNameField label={t('remote.hostName.name')} />,
    },
    ...devices.map((device): RowDef => ({
      id: device.id,
      name: device.name,
      description: deviceLine(t, device),
      keywords: t('remote.keywords'),
      group: list,
      layout: 'custom',
      render: () => <DeviceRow device={device} online={online.includes(device.id)} />,
      open: () => openSettingsItem('remote', device.id),
    })),
    {
      id: 'add-device',
      name: t('remote.devices.add'),
      english: en('remote.devices.add'),
      keywords: t('remote.keywords'),
      group: list,
      layout: 'custom',
      render: () => (devices.length === 0 ? <NoDevices /> : <AddDeviceRow />),
    },
    {
      id: 'direct',
      name: t('remote.direct.name'),
      english: en('remote.direct.name'),
      description: t('remote.direct.description'),
      keywords: t('remote.direct.keywords'),
      group: direct,
      render: () => (
        <SettingSwitch label={t('remote.direct.name')} checked disabled onChange={() => {}} />
      ),
    },
    {
      id: 'direct-port',
      name: t('remote.direct.port.name'),
      english: en('remote.direct.port.name'),
      description: t('remote.direct.port.description'),
      keywords: t('remote.direct.keywords'),
      group: direct,
      render: () => <DirectPortField label={t('remote.direct.port.name')} />,
    },
    {
      id: 'direct-found',
      name: t('remote.direct.found.name'),
      english: en('remote.direct.found.name'),
      description: t('remote.direct.found.description'),
      keywords: t('remote.direct.keywords'),
      group: direct,
      layout: 'block',
      render: (text) => <FoundAddresses text={text} />,
    },
    {
      id: 'direct-own',
      name: t('remote.direct.own.name'),
      english: en('remote.direct.own.name'),
      description: t('remote.direct.own.description'),
      keywords: t('remote.direct.keywords'),
      group: direct,
      layout: 'block',
      render: (text) => <OwnAddresses text={text} />,
    },
    {
      id: 'reset',
      name: t('remote.reset.name'),
      english: en('remote.reset.name'),
      description: t('remote.reset.description'),
      keywords: t('remote.reset.keywords'),
      group: group('reset', t('remote.reset.name'), { unlabeled: true }),
      render: () => <ResetRemote />,
    },
  ]
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
  const en = english()
  const account = useSharingStore((s) => s.status?.cloudflare ?? null)
  const pages = useSharingStore(useShallow((s) => s.status?.published ?? []))
  const titles = usePublishedTitles(pages.length > 0)
  const rows: RowDef[] = [
    {
      id: 'cloudflare',
      name: t('sharing.account.name'),
      english: en('sharing.account.name'),
      description: account ? `${account.subdomain}.workers.dev` : t('sharing.account.description'),
      keywords: t('sharing.account.keywords'),
      group: group('cloudflare', t('sharing.groups.account')),
      layout: 'custom',
      render: () => <SharingAccount />,
    },
  ]
  if (pages.length > 0) {
    const published = group('published', t('sharing.groups.published'), { count: pages.length })
    rows.push(
      ...pages.map((page): RowDef => {
        const title = titles.get(page.id)
        return {
          id: `published-${page.id}`,
          name: title ?? page.url,
          description: title
            ? page.url
            : t('sharing.published.version', {
                version: page.version,
                ago: longAgo(page.publishedAt),
              }),
          keywords: t('sharing.published.keywords'),
          group: published,
          layout: 'custom',
          render: () => <PublishedRow page={page} title={title} />,
        }
      }),
    )
  }
  return {
    id: 'sharing',
    title: t('sections.sharing'),
    description: t('pages.sharing'),
    icon: ShareIcon,
    rows,
    footer: pages.length === 0 && (
      <section aria-label={t('sharing.groups.published')} className="mt-7 flex flex-col">
        <GroupLabel group={{ id: 'published', label: t('sharing.groups.published') }} />
        <p className="px-1 pt-3 text-small text-tertiary">{t('sharing.published.empty')}</p>
      </section>
    ),
  }
}
