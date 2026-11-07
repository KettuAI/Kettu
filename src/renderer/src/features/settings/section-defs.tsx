import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AiBrain01Icon,
  Analytics01Icon,
  Archive01Icon,
  DashboardSquare02Icon,
  GitBranchIcon,
  Globe02Icon,
  InformationCircleIcon,
  Notification01Icon,
  PackageIcon,
  PaintBoardIcon,
  PlugSocketIcon,
  ServerStack02Icon,
  Setting07Icon,
  Settings02Icon,
  Share08Icon,
  ComputerTerminal01Icon,
  UserCircleIcon,
  Wifi01Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { AgentStatus, SessionSummary } from '@shared/agent-host'
import type { ArtifactConsentRow } from '@shared/artifact-capabilities'
import { originLabel } from '@shared/browser'
import type { AgentId, HarnessId } from '@shared/thread'
import { Icon } from '@renderer/components/affect/app-shell'
import { basename, mediumAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { i18n } from '@renderer/lib/i18n'
import { useHostContext, useHostHas } from '@renderer/lib/host-features'
import { formatShortcut, isMac, isWeb, isWindows, platform } from '@renderer/lib/platform'
import { useAppInfo } from '@renderer/lib/use-app-info'
import {
  agentName,
  awaitsPackage,
  harnessStatuses,
  hasProgram,
  usableAgents,
} from '@renderer/stores/agents'
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
import { AboutHero, AutomaticUpdates, NoUpdates, UpdateRow } from './about-section'
import {
  AddAgentRow,
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
import { AgentPlaceRow, FailedRead, McpServerPage, PendingList, ServerRow } from './mcp-section'
import { ArchivedRow } from './archived-section'
import { DebugModeRow } from './debug-mode'
import { ConsentRow, ConsentsState } from './artifacts-section'
import { Group, GroupNote } from './rows'
import { SettingSwitch } from './controls'
import { HostPage } from './host-page'
import { hostLine, webHostLine } from './host-text'
import { AddHostButton, HostRow, HostsLoading, HostsNote, SelfRow } from './hosts-section'
import { DevicePage } from './remote-device'
import { DirectPortField, FoundAddresses, OwnAddresses } from './remote-direct'
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
import { NoSharing, PublishedRow, SharingAccount, SharingPending } from './sharing-section'
import { useLoginItemStatus } from './use-login-item'
import { environmentText } from './environment-text'
import { AccountNote, AccountRow, SubscriptionState } from './account-section'
import { english, type GroupDef, type RowDef, type SectionDef } from './model'
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
  FontSize,
  GeneralSwitch,
  GhTool,
  GitTool,
  Language,
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
  WebNotificationsNote,
  TextSize,
  Zoom,
} from './sections'
import { useAllowedSites } from './allowed-sites'
import { ThemeTiles } from './theme-section'
import { ClearRecord, FromComputer, LogRow, SidebarEnd, SyncLogs } from './usage-section'
import { BrowserNameField, ForgetHost, WebHostRow } from './web-host-section'

// The sections of the Settings page as data, so search and the match counts read the same rows
// the page draws.

function group(id: string, label: string, extra?: Omit<GroupDef, 'id' | 'label'>): GroupDef {
  return { id, label, ...extra }
}

export function useGeneralSection(): SectionDef {
  const { t } = useTranslation('settings')
  const en = english()
  const input = group('input', t('general.groups.input'))
  // Devices reach the computer only while Kettu runs, so remote access holds it on.
  const remoteOn = useSettingsStore((s) => s.settings.remote.enabled)
  const sessions = group('sessions', t('general.groups.sessions'), {
    note: remoteOn && <GroupNote>{t('general.background.lockedByRemote')}</GroupNote>,
  })
  const thread = group('thread', t('general.groups.thread'))
  const startup = group('startup', t('general.groups.startup'))
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
        description: t('general.confirmQuit.description'),
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
        description: isMac
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
    icon: PaintBoardIcon,
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
        layout: 'custom',
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
        layout: 'bare',
        render: (text) => <TextSize label={text} />,
      },
      {
        id: 'reduce-motion',
        name: t('appearance.reduceMotion.name'),
        english: en('appearance.reduceMotion.name'),
        description: isMac
          ? t('appearance.reduceMotion.description')
          : t('appearance.reduceMotion.descriptionOther'),
        keywords: t('appearance.reduceMotion.keywords'),
        group: group('motion', t('appearance.groups.motion')),
        render: () => <ReduceMotion />,
      },
    ],
  }
}

export function useNotificationsSection(): SectionDef {
  const { t } = useTranslation('settings')
  const onHost = useHostContext()
  const en = english()
  const when = group('when', t('notifications.groups.when'))
  const how = group('how', t('notifications.groups.how'))
  const rows: RowDef[] = [
    {
      id: 'preview',
      name: t('notifications.groups.preview'),
      english: en('notifications.groups.preview'),
      description: t('notifications.test'),
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
    description: t('pages.notifications', onHost),
    icon: Notification01Icon,
    rows,
  }
}

export function useAccountSection(): SectionDef {
  const { t } = useTranslation('settings')
  const en = english()
  const status = useAccountStore((s) => s.status)
  const signedIn = status?.state === 'signed-in' ? status : null
  const card = group('account', t('account.name'), {
    unlabeled: true,
    note: signedIn?.plainText && <GroupNote>{t('account.plainText')}</GroupNote>,
  })
  const rows: RowDef[] = [
    {
      id: 'account',
      name: t('account.name'),
      english: en('account.name'),
      // Not the email, which search results would show past Hide account.
      description: signedIn ? undefined : t('account.description'),
      keywords: t('account.keywords'),
      group: card,
      layout: 'custom',
      render: () => <AccountRow />,
    },
  ]
  if (signedIn && signedIn.subscription !== 'none') {
    rows.push({
      id: 'subscription',
      name: t('account.subscription.name'),
      english: en('account.subscription.name'),
      description: t('account.subscription.description'),
      keywords: t('account.subscription.keywords'),
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
      name: t('settings.fromComputer.name', onHost),
      english: en('settings.fromComputer.name'),
      description: t('settings.fromComputer.description', onHost),
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
        name: agentName(agentId, hostId),
        description: logPlaces[i] ?? '',
        keywords: t('settings.groups.logs'),
        group: logGroup,
        layout: 'custom',
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
      group: group('danger', t('settings.groups.danger')),
      render: () => <ClearRecord />,
    },
  )
  return {
    id: 'usage',
    title: t('settings.title'),
    description: t('settings.description'),
    icon: Analytics01Icon,
    rows,
  }
}

export function useAgentsSection(): SectionDef {
  const { t } = useTranslation('settings')
  const onHost = useHostContext()
  const { useAgentsStore } = useHostScope()
  const en = english()
  const agents = useAgentsStore(useShallow((s) => usableAgents(s.order, s.byId)))
  const list: GroupDef =
    agents.length === 0
      ? {
          id: 'agents',
          label: t('agents.groups.list', onHost),
          actions: <AgentsGroupActions />,
          unlabeled: true,
        }
      : {
          id: 'agents',
          label: t('agents.groups.list', onHost),
          count: agents.length,
          actions: <AgentsGroupActions />,
        }
  const row = (status: AgentStatus): RowDef => ({
    id: status.id,
    name: status.name,
    description: status.account?.label ?? undefined,
    keywords: `${t('agents.keywords')} ${status.harnessName} ${
      status.account?.kind === 'none' ? '' : (status.account?.email ?? '')
    }`,
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
    rows:
      agents.length === 0
        ? [
            {
              id: 'no-agents',
              name: t('agents.empty.title'),
              keywords: t('agents.empty.keywords'),
              group: list,
              layout: 'custom',
              render: () => <NoAgents />,
            },
          ]
        : [
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
  const { useAgentsStore } = useHostScope()
  const en = english()
  const harnesses = useAgentsStore(useShallow((s) => harnessStatuses(s.order, s.byId)))
  const environment = useAgentsStore((s) => s.environment)
  // Installed: its program is on the machine, too old included, with any package Kettu adds for it.
  const installed = harnesses.filter((h) => hasProgram(h) && !awaitsPackage(h) && !h.uninstalled)
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
    icon: PackageIcon,
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
    icon: ComputerTerminal01Icon,
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
        // The preview closes the group, with no line under it.
        layout: 'bare',
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
  const rows: RowDef[] = [
    {
      id: 'open-links-in',
      name: t('browser.openLinksIn.name'),
      english: en('browser.openLinksIn.name'),
      description: t('browser.openLinksIn.description', { mod: formatShortcut('Mod') }),
      keywords: t('browser.openLinksIn.keywords'),
      group: links,
      render: () => <OpenLinksIn label={t('browser.openLinksIn.name')} />,
    },
    {
      id: 'confirm-links',
      name: t('browser.confirmLinks.name'),
      english: en('browser.confirmLinks.name'),
      description: t('browser.confirmLinks.description'),
      keywords: t('browser.confirmLinks.keywords'),
      group: links,
      render: () => <ConfirmLinks label={t('browser.confirmLinks.name')} />,
    },
    // Shown once the "Open link?" dialog has remembered a site: there is nothing to manage before.
    ...(remembered > 0
      ? [
          {
            id: 'remembered-sites',
            name: t('browser.rememberedSites.name'),
            english: en('browser.rememberedSites.name'),
            description: t('browser.rememberedSites.description'),
            keywords: t('browser.rememberedSites.keywords'),
            group: links,
            layout: 'block',
            render: (text) => <RememberedSitesList label={text} />,
          } satisfies RowDef,
        ]
      : []),
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
      name: originLabel(site.origin),
      keywords: t('browser.allowedSites.keywords'),
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
  const en = english()
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
        name: t('advanced.proxy.name'),
        english: en('advanced.proxy.name'),
        description: t('advanced.proxy.description'),
        keywords: t('advanced.proxy.keywords'),
        group: group('network', t('advanced.groups.network')),
        layout: 'block',
        render: (text) => <Proxy label={text} />,
      },
      {
        id: 'report',
        name: t('advanced.report.name'),
        english: en('advanced.report.name'),
        description: t('advanced.report.description'),
        keywords: t('advanced.report.keywords'),
        group: data,
        render: () => <ReportProblem />,
      },
      // The log files and their switch are this computer's; a host elsewhere keeps its own.
      ...(isWeb || hostId !== null
        ? []
        : [
            {
              id: 'logs',
              name: t('advanced.logs.name'),
              english: en('advanced.logs.name'),
              description: t('advanced.logs.description'),
              keywords: t('advanced.logs.keywords'),
              group: data,
              render: () => <LogsFolderActions />,
            },
            {
              id: 'record-steps',
              name: t('advanced.record.name'),
              english: en('advanced.record.name'),
              description: t('advanced.record.description'),
              keywords: t('advanced.record.keywords'),
              group: data,
              render: () => <RecordSteps />,
            },
            {
              id: 'detailed-records',
              name: t('advanced.detailedRecords.name'),
              english: en('advanced.detailedRecords.name'),
              description: t('advanced.detailedRecords.description'),
              keywords: t('advanced.detailedRecords.keywords'),
              group: data,
              render: () => <DetailedRecords label={t('advanced.detailedRecords.name')} />,
            },
            {
              id: 'debug-mode',
              name: t('advanced.debugMode.name'),
              english: en('advanced.debugMode.name'),
              description: debugOn
                ? t('advanced.debugMode.descriptionOn')
                : t('advanced.debugMode.description'),
              keywords: t('advanced.debugMode.keywords'),
              group: data,
              layout: 'block' as const,
              render: (text: ReactNode) => <DebugModeRow text={text} />,
            },
          ]),
      {
        id: 'data-folder',
        name: t('advanced.dataFolder.name'),
        english: en('advanced.dataFolder.name'),
        description: t('advanced.dataFolder.description'),
        rich: <DataFolderText />,
        group: data,
        render: () => <DataFolderActions />,
      },
      {
        id: 'remove-sessions',
        name: t('advanced.removeSessions.name'),
        english: en('advanced.removeSessions.name'),
        description: t('advanced.removeSessions.description'),
        keywords: t('advanced.removeSessions.keywords'),
        group: group('danger', t('advanced.groups.danger')),
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
  // A host whose Kettu Settings cannot update, as the daemon's, says so in the row.
  const updatable = useHostHas('updates')
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
        name: t('about.updates.name'),
        english: en('about.updates.name'),
        keywords: t('about.updates.keywords'),
        group: updates,
        layout: 'block',
        render: () => (updatable === false ? <NoUpdates /> : <UpdateRow status={status} />),
      },
      ...(updatable === false || status?.state.kind === 'off'
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
        id: 'github',
        name: t('about.github.name'),
        english: en('about.github.name'),
        keywords: t('about.github.keywords'),
        searchOnly: true,
        render: () => null,
      },
    ],
  }
}

export function useMcpSection(): SectionDef {
  const { t } = useTranslation('settings')
  const { hostId, useMcpStore } = useHostScope()
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
    group: group('kettu', t('mcp.groups.kettu'), {
      count: servers.length,
      note: <GroupNote>{t('mcp.groups.kettuNote')}</GroupNote>,
    }),
    layout: 'custom',
    render: () => <ServerRow server={server} />,
    open: () => openSettingsItem('mcp', server.name),
  }))
  for (const place of places) {
    const name = agentName(place.agentId, hostId)
    rows.push({
      id: place.agentId,
      name,
      description: t('mcp.place.connects', { name }),
      keywords: `${t('mcp.place.keywords')} ${place.path} ${place.project}`,
      english: en('sections.mcp'),
      group: group('own', t('mcp.groups.own')),
      layout: 'custom',
      render: () => <AgentPlaceRow place={place} />,
    })
  }
  return {
    id: 'mcp',
    title: t('sections.mcp'),
    description: t('pages.mcp'),
    icon: PlugSocketIcon,
    // A read that failed shows its notice in place of both groups.
    rows: error ? [] : rows,
    itemPage: (item) => <McpServerPage name={item} />,
    footer: error ? <FailedRead error={error} /> : !status ? <PendingList /> : undefined,
  }
}

export function useArchivedSection(): SectionDef {
  const { t } = useTranslation(['settings', 'sidebar'])
  const { hostId } = useHostScope()
  const en = english()
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
    rows: archived.map((summary) => ({
      id: summary.id,
      name: sessionTitle(summary),
      description: where(summary),
      keywords: `${agentName(summary.agentId, hostId)} ${t('archived.keywords')}`,
      english: en('sections.archived'),
      group: list,
      layout: 'custom',
      render: () => <ArchivedRow summary={summary} where={where(summary)} />,
    })),
    footer: archived.length === 0 && (
      <div className="ui-as-empty">
        <span className="ui-as-empty__icon">
          <Icon icon={Archive01Icon} size={18} />
        </span>
        <b className="ui-as-empty__title">{t('archived.emptyTitle')}</b>
        <p className="ui-as-empty__text">{t('archived.emptyHint')}</p>
      </div>
    ),
  }
}

/**
 * Settings > Hosts in the web client, which reaches only the host that served its page: that host,
 * this browser's name on it, and forgetting it here.
 */
function useWebHostsSection(): SectionDef {
  const { t } = useTranslation('settings')
  const en = english()
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
        name: t('sections.hosts'),
        english: en('sections.hosts'),
        description: t('pages.hostsWeb'),
        keywords: t('hosts.keywords'),
        searchOnly: true,
        render: () => null,
      },
      {
        id: 'host',
        name: name || t('sections.hosts'),
        description: host ? webHostLine(t, host) : undefined,
        keywords: t('hosts.keywords'),
        group: group('host', t('sections.hosts'), { unlabeled: true }),
        layout: 'custom',
        render: () => (host ? <WebHostRow host={host} /> : <HostsLoading />),
      },
      {
        id: 'device-name',
        name: t('hosts.page.name'),
        english: en('hosts.page.name'),
        description: online
          ? t('hosts.web.nameDescription', { name })
          : t('hosts.web.nameOffline', { name }),
        group: group('self', t('hosts.web.self', { name })),
        render: () => <BrowserNameField />,
      },
      {
        id: 'forget',
        name: t('hosts.web.forget.name', { name }),
        english: en('hosts.web.forget.name', { name }),
        description: t('hosts.web.forget.description', { name }),
        keywords: t('hosts.web.forget.keywords'),
        group: group('forget', t('hosts.web.forget.name', { name }), { unlabeled: true }),
        render: () => <ForgetHost />,
      },
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
  const en = english()
  const status = useHostsStore((s) => s.status)
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
    icon: ServerStack02Icon,
    rows,
    itemPage: (id: string) => <HostPage id={id} />,
  }
}

export function useRemoteSection(): SectionDef {
  const { t } = useTranslation('settings')
  const onHost = useHostContext()
  const { useSettingsStore, useRemoteStore } = useHostScope()
  const en = english()
  const enabled = useSettingsStore((s) => s.settings.remote.enabled)
  const status = useRemoteStore((s) => s.status)
  const resettable = useHostHas('remoteReset')
  const state = group('status', t('remote.switch'), {
    unlabeled: true,
    note: enabled && <PlainKeyNote />,
  })
  const switchRow: RowDef = {
    id: 'remote',
    name: t('remote.switch'),
    english: en('remote.switch'),
    description: t('pages.remote', onHost),
    keywords: t('remote.keywords'),
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
      layout: devices.length === 0 ? 'custom' : undefined,
      searchOnly: devices.length > 0,
      render: () => (devices.length === 0 ? <NoDevices /> : null),
    },
  ]
  // Off, the devices are still listed to rename and remove; only adding one waits.
  if (!enabled)
    return { ...base, rows: devices.length > 0 ? [switchRow, ...deviceRows] : [switchRow] }
  const direct = group('direct', t('remote.direct.group'))
  const rows: RowDef[] = [
    switchRow,
    {
      id: 'host-name',
      name: t('remote.hostName.name', onHost),
      english: en('remote.hostName.name'),
      description: t('remote.hostName.description'),
      group: state,
      render: () => <HostNameField label={t('remote.hostName.name', onHost)} />,
    },
    ...deviceRows,
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
      description: t('remote.direct.found.description', onHost),
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
      id: 'terminal',
      name: t('remote.terminal.name'),
      english: en('remote.terminal.name'),
      description: t('remote.terminal.description', onHost),
      keywords: t('remote.terminal.keywords'),
      group: group('permissions', t('remote.groups.permissions')),
      render: () => <TerminalSwitch label={t('remote.terminal.name')} />,
    },
  ]
  if (resettable !== false) {
    rows.push({
      id: 'reset',
      name: t('remote.reset.name'),
      english: en('remote.reset.name'),
      description: t('remote.reset.description', onHost),
      keywords: t('remote.reset.keywords'),
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
  const en = english()
  const account = useSharingStore((s) => s.status?.cloudflare ?? null)
  const pages = useSharingStore(useShallow((s) => s.status?.published ?? []))
  // Another host's artifacts are not listed here, so its pages go by their addresses.
  const titles = usePublishedTitles(hostId === null && pages.length > 0)
  const shares = useHostHas('sharing')
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
          name: t('sharing.account.name'),
          english: en('sharing.account.name'),
          description: shares === false ? t('sharing.none.title') : undefined,
          keywords: t('sharing.account.keywords'),
          searchOnly: true,
          render: () => null,
        },
      ],
      footer: shares === false ? <NoSharing /> : <SharingPending />,
    }
  }
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
                ago: mediumAgo(page.publishedAt),
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
    ...base,
    rows,
    footer: pages.length === 0 && (
      <Group label={t('sharing.groups.published')}>
        <p className="ui-ss-empty">{t('sharing.published.empty')}</p>
      </Group>
    ),
  }
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
  const en = english()
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
    rows: (rows ?? []).map((row) => ({
      id: `consent-${row.artifactId}`,
      name: row.title,
      description: where(row),
      keywords: t('artifacts.keywords'),
      english: en('sections.artifacts'),
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
