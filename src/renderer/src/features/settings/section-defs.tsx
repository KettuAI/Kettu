import {
  ArchiveIcon,
  BellIcon,
  BotIcon,
  ChartNoAxesColumnIcon,
  GitBranchIcon,
  InfoIcon,
  KeyboardIcon,
  SettingsIcon,
  SquareTerminalIcon,
  SunMoonIcon,
  WrenchIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { AgentStatus, SessionSummary } from '@shared/agent-host'
import { listedInstalled } from '@renderer/features/agents/readiness'
import { basename } from '@renderer/lib/format'
import { i18n } from '@renderer/lib/i18n'
import { formatShortcut, isMac, isWindows, platform } from '@renderer/lib/platform'
import { agentName, usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { useProjectsStore } from '@renderer/stores/projects'
import { archivedSessions, sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import { useUpdatesStore } from '@renderer/stores/updates'
import { useUsageStore } from '@renderer/stores/usage'
import { openAgentSettings } from '@renderer/stores/view'
import {
  AboutHero,
  AutomaticUpdates,
  CopyVersions,
  LinkRow,
  RuntimeFact,
  UpdateRow,
} from './about-section'
import { AgentListItem, AgentsGroupActions, EnvironmentFooter } from './agents-section'
import { ArchivedRow } from './archived-section'
import { useAppInfo } from './use-app-info'
import { english, type GroupDef, type RowDef, type SectionDef } from './model'
import {
  BackgroundFetch,
  DataFolder,
  DefaultAgent,
  Diagnostics,
  FontSize,
  GeneralSwitch,
  GhTool,
  GitTool,
  Language,
  NotificationPreview,
  NotificationSwitch,
  Proxy,
  ReduceMotion,
  RemoveAll,
  SendKey,
  ShellPicker,
  ShortcutKeys,
  TestNotification,
  TextSize,
  ThemeTiles,
  Zoom,
} from './sections'
import { ClearRecord, FromComputer, LogRow, SidebarEnd, SyncLogs } from './usage-section'

// The sections of the Settings page as data, so search and the match counts read the same rows
// the page draws.

const SOURCE_URL = 'https://github.com/overbench/overbench'
const ISSUES_URL = 'https://github.com/overbench/overbench/issues'
const LICENSE_URL = 'https://github.com/overbench/overbench/blob/main/LICENSE'

const SHORTCUTS = [
  { group: 'sessions', keys: 'Mod+N', action: 'newSession' },
  { group: 'sessions', keys: 'Mod+L', action: 'focusComposer' },
  { group: 'sessions', keys: 'Mod+Shift+[', action: 'previousSession' },
  { group: 'sessions', keys: 'Mod+Shift+]', action: 'nextSession' },
  { group: 'sessions', keys: 'Esc', action: 'cancelTurn' },
  { group: 'sessions', keys: '1-4', action: 'answerPermission' },
  { group: 'window', keys: 'Mod+O', action: 'openProject' },
  { group: 'window', keys: 'Mod+B', action: 'toggleSidebar' },
  { group: 'window', keys: 'Mod+,', action: 'settings' },
  { group: 'window', keys: 'Mod+=', action: 'zoomIn' },
  { group: 'window', keys: 'Mod+-', action: 'zoomOut' },
  { group: 'window', keys: 'Mod+0', action: 'resetZoom' },
  { group: 'terminal', keys: 'Ctrl+`', action: 'toggleTerminal' },
  { group: 'terminal', keys: 'Ctrl+Shift+`', action: 'newTerminal' },
] as const

function group(id: string, label: string, extra?: Omit<GroupDef, 'id' | 'label'>): GroupDef {
  return { id, label, ...extra }
}

export function useGeneralSection(): SectionDef {
  const { t } = useTranslation('settings')
  const en = english()
  const input = group('input', t('general.groups.input'))
  const sessions = group('sessions', t('general.groups.sessions'))
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
    ],
  }
}

export function useAppearanceSection(): SectionDef {
  const { t } = useTranslation('settings')
  const en = english()
  const scale = group('scale', t('appearance.groups.scale'))
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
        group: group('theme', t('appearance.groups.theme')),
        layout: 'block',
        render: () => <ThemeTiles />,
      },
      {
        id: 'zoom',
        name: t('appearance.zoom.name'),
        english: en('appearance.zoom.name'),
        description: t('appearance.zoom.description', {
          zoomIn: formatShortcut('Mod+='),
          zoomOut: formatShortcut('Mod+-'),
        }),
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
      group: group('preview', t('notifications.groups.preview'), { actions: <TestNotification /> }),
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

export function useShortcutsSection(): SectionDef {
  const { t } = useTranslation('settings')
  const en = english()
  const groups = {
    sessions: group('sessions', t('shortcuts.groups.sessions')),
    window: group('window', t('shortcuts.groups.window')),
    terminal: group('terminal', t('shortcuts.groups.terminal')),
  }
  return {
    id: 'shortcuts',
    title: t('sections.shortcuts'),
    description: t('pages.shortcuts'),
    icon: KeyboardIcon,
    rows: SHORTCUTS.map((s) => ({
      id: s.keys,
      name: t(`shortcuts.${s.action}`),
      english: en(`shortcuts.${s.action}`),
      keywords: s.keys,
      group: groups[s.group],
      render: () => <ShortcutKeys keys={s.keys} />,
    })),
  }
}

export function useAgentsSection(): SectionDef {
  const { t } = useTranslation('settings')
  const agents = useAgentsStore(useShallow((s) => usableAgents(s.order, s.byId)))
  const hidden = useSettingsStore((s) => s.settings.privacy.hideAccount)
  const installed = agents.filter(listedInstalled)
  const missing = agents.filter((a) => !listedInstalled(a))
  const groups = {
    installed: {
      id: 'installed',
      label: t('agents.groups.installed'),
      count: installed.length,
      actions: <AgentsGroupActions />,
    },
    missing: { id: 'missing', label: t('agents.groups.notInstalled'), count: missing.length },
  }
  const row = (status: AgentStatus, group: GroupDef): RowDef => ({
    id: status.id,
    name: status.name,
    description: status.account?.label ?? undefined,
    // A hidden email stays out of search too, so a match cannot reveal it.
    keywords: `${t('agents.keywords')} ${hidden ? '' : (status.account?.email ?? '')}`,
    group,
    layout: 'custom',
    render: () => <AgentListItem status={status} />,
    open: () => openAgentSettings(status.id),
  })
  const updates = agents.filter((a) => a.update)
  return {
    id: 'agents',
    title: t('sections.agents'),
    description: t('pages.agents'),
    icon: BotIcon,
    rows: [
      ...installed.map((a) => row(a, groups.installed)),
      ...missing.map((a) => row(a, groups.missing)),
    ],
    footer: <EnvironmentFooter />,
    mark:
      updates.length > 0
        ? t('agents.update.mark', { names: updates.map((a) => a.name).join(', ') })
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
        render: () => <Diagnostics />,
      },
      {
        id: 'data-folder',
        name: t('advanced.dataFolder.name'),
        english: en('advanced.dataFolder.name'),
        description: t('advanced.dataFolder.description'),
        group: data,
        layout: 'block',
        render: (text) => <DataFolder label={text} />,
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
  const runtime = group('runtime', t('about.groups.runtime'), {
    actions: info && <CopyVersions info={info} />,
  })
  const links = group('links', t('about.groups.links'))
  const fact = (id: string, name: string, value: string | undefined): RowDef => ({
    id,
    name,
    keywords: t('about.version.keywords'),
    group: runtime,
    render: () => <RuntimeFact value={value} />,
  })
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
        render: (text) => <UpdateRow status={status} label={text} />,
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
      fact('electron', 'Electron', info?.versions.electron),
      fact('chromium', 'Chromium', info?.versions.chrome),
      fact('node', 'Node.js', info?.versions.node),
      fact('system', t('about.runtime.system'), info ? `${info.platform} ${info.arch}` : undefined),
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
        id: 'issues',
        name: t('about.issues.name'),
        english: en('about.issues.name'),
        group: links,
        layout: 'custom',
        render: () => <LinkRow name={t('about.issues.name')} url={ISSUES_URL} />,
      },
    ],
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
      layout: 'custom',
      render: () => <ArchivedRow summary={summary} where={where(summary)} />,
    })),
    footer: archived.length === 0 && (
      <p className="px-1 text-small text-secondary">{t('archived.empty')}</p>
    ),
  }
}
