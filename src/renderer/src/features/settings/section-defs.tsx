import {
  BellIcon,
  BotIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  InfoIcon,
  KeyboardIcon,
  PaletteIcon,
  SettingsIcon,
  SquareTerminalIcon,
  WrenchIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { AgentStatus } from '@shared/agent-host'
import { buttonVariants } from '@renderer/components/ui/button'
import { Kbd } from '@renderer/components/ui/kbd'
import { readiness } from '@renderer/features/agents/readiness'
import { formatShortcut, isMac, isWindows, platform } from '@renderer/lib/platform'
import { usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { useUpdatesStore } from '@renderer/stores/updates'
import { AutomaticUpdates, UpdateRow, Version } from './about-section'
import { AgentListItem, EnvironmentFooter } from './agents-section'
import { english, type RowDef, type SectionDef } from './model'
import {
  BackgroundFetch,
  DataFolder,
  DefaultAgent,
  Diagnostics,
  FontSize,
  GeneralSwitch,
  Language,
  GhTool,
  GitTool,
  NotificationSwitch,
  Proxy,
  ReduceMotion,
  RemoveAll,
  SendKey,
  ShellPicker,
  TextSize,
  ThemeTiles,
} from './sections'

// The sections of the Settings page as data, so search and the match counts read the same rows
// the page draws.

const SOURCE_URL = 'https://github.com/overbench/overbench'

const SHORTCUTS = [
  { keys: 'Mod+O', action: 'openProject' },
  { keys: 'Mod+N', action: 'newSession' },
  { keys: 'Mod+B', action: 'toggleSidebar' },
  { keys: 'Mod+L', action: 'focusComposer' },
  { keys: 'Mod+Shift+[', action: 'previousSession' },
  { keys: 'Mod+Shift+]', action: 'nextSession' },
  { keys: 'Mod+,', action: 'settings' },
  { keys: 'Mod+=', action: 'zoomIn' },
  { keys: 'Mod+-', action: 'zoomOut' },
  { keys: 'Mod+0', action: 'resetZoom' },
  { keys: 'Ctrl+`', action: 'toggleTerminal' },
  { keys: 'Ctrl+Shift+`', action: 'newTerminal' },
  { keys: 'Esc', action: 'cancelTurn' },
  { keys: '1 – 4', action: 'answerPermission' },
] as const

export function useGeneralSection(): SectionDef {
  const { t } = useTranslation('settings')
  const en = english()
  return {
    id: 'general',
    title: t('sections.general'),
    icon: SettingsIcon,
    rows: [
      {
        id: 'language',
        name: t('general.language.name'),
        english: en('general.language.name'),
        description: t('general.language.description'),
        keywords: t('general.language.keywords'),
        render: () => <Language />,
      },
      {
        id: 'default-agent',
        name: t('general.defaultAgent.name'),
        english: en('general.defaultAgent.name'),
        description: t('general.defaultAgent.description'),
        render: () => <DefaultAgent />,
      },
      {
        id: 'send-key',
        name: t('general.sendKey.name'),
        english: en('general.sendKey.name'),
        description: t('general.sendKey.description'),
        keywords: t('general.sendKey.keywords'),
        render: () => <SendKey />,
      },
      {
        id: 'restore',
        name: t('general.restore.name'),
        english: en('general.restore.name'),
        render: () => (
          <GeneralSwitch field="restoreLastSession" label={t('general.restore.name')} />
        ),
      },
      {
        id: 'confirm-quit',
        name: t('general.confirmQuit.name'),
        english: en('general.confirmQuit.name'),
        keywords: t('general.confirmQuit.keywords'),
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
  return {
    id: 'appearance',
    title: t('sections.appearance'),
    icon: PaletteIcon,
    rows: [
      {
        id: 'theme',
        name: t('appearance.theme.name'),
        english: en('appearance.theme.name'),
        keywords: t('appearance.theme.keywords'),
        render: () => <ThemeTiles />,
      },
      {
        id: 'text-size',
        name: t('appearance.textSize.name'),
        english: en('appearance.textSize.name'),
        description: t('appearance.textSize.description'),
        keywords: t('appearance.textSize.keywords'),
        render: () => <TextSize />,
      },
      {
        id: 'reduce-motion',
        name: t('appearance.reduceMotion.name'),
        english: en('appearance.reduceMotion.name'),
        description: t('appearance.reduceMotion.description'),
        keywords: t('appearance.reduceMotion.keywords'),
        render: () => <ReduceMotion />,
      },
    ],
  }
}

export function useTerminalSection(): SectionDef {
  const { t } = useTranslation('settings')
  const en = english()
  return {
    id: 'terminal',
    title: t('sections.terminal'),
    icon: SquareTerminalIcon,
    rows: [
      {
        id: 'shell',
        name: t('terminal.shell.name'),
        english: en('terminal.shell.name'),
        description: isWindows
          ? t('terminal.shell.descriptionWindows')
          : t('terminal.shell.description'),
        render: () => <ShellPicker />,
      },
      {
        id: 'font-size',
        name: t('terminal.fontSize.name'),
        english: en('terminal.fontSize.name'),
        description: t('terminal.fontSize.description'),
        render: () => <FontSize />,
      },
    ],
  }
}

export function useGitSection(): SectionDef {
  const { t } = useTranslation('settings')
  const en = english()
  return {
    id: 'git',
    title: t('sections.git'),
    icon: GitBranchIcon,
    rows: [
      {
        id: 'git',
        name: t('git.git.name'),
        english: en('git.git.name'),
        description: t('git.git.description'),
        render: () => <GitTool />,
      },
      {
        id: 'gh',
        name: t('git.gh.name'),
        english: en('git.gh.name'),
        description: t('git.gh.description'),
        keywords: t('git.gh.keywords'),
        render: () => <GhTool />,
      },
      {
        id: 'fetch',
        name: t('git.fetch.name'),
        english: en('git.fetch.name'),
        description: t('git.fetch.description'),
        render: () => <BackgroundFetch />,
      },
    ],
  }
}

export function useNotificationsSection(): SectionDef {
  const { t } = useTranslation('settings')
  const en = english()
  const rows: SectionDef['rows'] = [
    {
      id: 'permission',
      name: t('notifications.permission.name'),
      english: en('notifications.permission.name'),
      description: t('notifications.permission.description'),
      keywords: t('notifications.permission.keywords'),
      render: () => (
        <NotificationSwitch field="permission" label={t('notifications.permission.name')} />
      ),
    },
    {
      id: 'turn-ended',
      name: t('notifications.turnEnded.name'),
      english: en('notifications.turnEnded.name'),
      description: t('notifications.turnEnded.description'),
      render: () => (
        <NotificationSwitch field="turnEnded" label={t('notifications.turnEnded.name')} />
      ),
    },
    {
      id: 'error',
      name: t('notifications.error.name'),
      english: en('notifications.error.name'),
      description: t('notifications.error.description'),
      render: () => <NotificationSwitch field="error" label={t('notifications.error.name')} />,
    },
    {
      id: 'sound',
      name: t('notifications.sound.name'),
      english: en('notifications.sound.name'),
      description: t('notifications.sound.description'),
      render: () => <NotificationSwitch field="sound" label={t('notifications.sound.name')} />,
    },
  ]
  if (platform !== 'linux') {
    const name = isMac ? t('notifications.badge.nameDock') : t('notifications.badge.nameTaskbar')
    rows.push({
      id: 'badge',
      name,
      description: t('notifications.badge.description'),
      keywords: t('notifications.badge.keywords'),
      render: () => <NotificationSwitch field="badge" label={name} />,
    })
  }
  return {
    id: 'notifications',
    title: t('sections.notifications'),
    icon: BellIcon,
    rows,
    footer: <p className="px-1 text-xs text-muted-foreground">{t('notifications.footer')}</p>,
  }
}

export function useShortcutsSection(): SectionDef {
  const { t } = useTranslation('settings')
  const en = english()
  return {
    id: 'shortcuts',
    title: t('sections.shortcuts'),
    icon: KeyboardIcon,
    rows: SHORTCUTS.map((s) => ({
      id: s.keys,
      name: t(`shortcuts.${s.action}`),
      english: en(`shortcuts.${s.action}`),
      keywords: s.keys,
      render: () => (
        <Kbd className="font-sans">
          {s.keys.startsWith('Mod') ? formatShortcut(s.keys) : s.keys}
        </Kbd>
      ),
    })),
  }
}

export function useAdvancedSection(): SectionDef {
  const { t } = useTranslation('settings')
  const en = english()
  return {
    id: 'advanced',
    title: t('sections.advanced'),
    icon: WrenchIcon,
    rows: [
      {
        id: 'proxy',
        name: t('advanced.proxy.name'),
        english: en('advanced.proxy.name'),
        description: t('advanced.proxy.description'),
        keywords: t('advanced.proxy.keywords'),
        layout: 'block',
        render: (text) => <Proxy label={text} />,
      },
      {
        id: 'diagnostics',
        name: t('advanced.diagnostics.name'),
        english: en('advanced.diagnostics.name'),
        description: t('advanced.diagnostics.description'),
        keywords: t('advanced.diagnostics.keywords'),
        render: () => <Diagnostics />,
      },
      {
        id: 'data-folder',
        name: t('advanced.dataFolder.name'),
        english: en('advanced.dataFolder.name'),
        description: t('advanced.dataFolder.description'),
        render: () => <DataFolder />,
      },
      {
        id: 'remove-sessions',
        name: t('advanced.removeSessions.name'),
        english: en('advanced.removeSessions.name'),
        description: t('advanced.removeSessions.description'),
        keywords: t('advanced.removeSessions.keywords'),
        render: () => <RemoveAll />,
      },
    ],
  }
}

export function useAgentsSection(): SectionDef {
  const { t } = useTranslation('settings')
  const agents = useAgentsStore(useShallow((s) => usableAgents(s.order, s.byId)))
  const installed = agents.filter((a) => readiness(a).kind !== 'missing')
  const missing = agents.filter((a) => readiness(a).kind === 'missing')
  const row = (status: AgentStatus, group: string): RowDef => ({
    id: status.id,
    name: status.name,
    description: status.account?.label ?? undefined,
    keywords: t('agents.keywords'),
    group,
    layout: 'custom',
    render: () => <AgentListItem status={status} />,
  })
  return {
    id: 'agents',
    title: t('sections.agents'),
    icon: BotIcon,
    rows: [
      ...installed.map((a) => row(a, t('agents.groups.installed'))),
      ...missing.map((a) => row(a, t('agents.groups.notInstalled'))),
    ],
    footer: <EnvironmentFooter />,
  }
}

export function useAboutSection(): SectionDef {
  const { t } = useTranslation('settings')
  const en = english()
  const status = useUpdatesStore((s) => s.status)
  const updatesOff = status?.state.kind === 'off'
  return {
    id: 'about',
    title: t('sections.about'),
    icon: InfoIcon,
    rows: [
      {
        id: 'version',
        name: status ? `OverBench ${status.current}` : 'OverBench',
        description: t('about.version.description'),
        keywords: t('about.version.keywords'),
        render: () => <Version />,
      },
      {
        id: 'update',
        name: t('about.updates.name'),
        english: en('about.updates.name'),
        keywords: t('about.updates.keywords'),
        layout: 'block',
        render: (text) => <UpdateRow status={status} label={text} />,
      },
      ...(updatesOff
        ? []
        : [
            {
              id: 'automatic',
              name: t('about.automatic.name'),
              english: en('about.automatic.name'),
              description: t('about.automatic.description'),
              render: () => <AutomaticUpdates />,
            },
          ]),
      {
        id: 'source',
        name: t('about.source.name'),
        english: en('about.source.name'),
        render: () => (
          <a
            href={SOURCE_URL}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: 'quiet', size: 'compact' })}
          >
            GitHub
            <ExternalLinkIcon data-icon="inline-end" />
          </a>
        ),
      },
    ],
  }
}
