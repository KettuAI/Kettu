import { ExternalLinkIcon } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { buttonVariants } from '@renderer/components/ui/button'
import { Kbd } from '@renderer/components/ui/kbd'
import { formatShortcut, isMac, isWindows, platform } from '@renderer/lib/platform'
import { usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { useUpdatesStore } from '@renderer/stores/updates'
import { AutomaticUpdates, UpdateRow, Version } from './about-section'
import { AgentCard, EnvironmentFooter } from './agents-section'
import type { SectionDef } from './model'
import {
  BackgroundFetch,
  DataFolder,
  DefaultAgent,
  Diagnostics,
  FontSize,
  GeneralSwitch,
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

const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: 'Mod+O', action: 'Open project' },
  { keys: 'Mod+N', action: 'New session in the current project' },
  { keys: 'Mod+B', action: 'Toggle the sidebar' },
  { keys: 'Mod+L', action: 'Focus the composer, or ask about the terminal selection' },
  { keys: 'Mod+Shift+[', action: 'Previous session in the sidebar' },
  { keys: 'Mod+Shift+]', action: 'Next session in the sidebar' },
  { keys: 'Mod+,', action: 'Settings; Esc goes back' },
  { keys: 'Ctrl+`', action: 'Show or hide the terminal' },
  { keys: 'Ctrl+Shift+`', action: 'New terminal' },
  { keys: 'Esc', action: 'Cancel the running turn' },
  { keys: '1 – 4', action: 'Answer the pending permission request' },
]

export function useGeneralSection(): SectionDef {
  return {
    id: 'general',
    title: 'General',
    rows: [
      {
        id: 'default-agent',
        name: 'Default agent',
        description:
          'The agent New session starts. With Ask each time, the project home lets you pick.',
        render: () => <DefaultAgent />,
      },
      {
        id: 'send-key',
        name: 'Send with',
        description: 'The other key inserts a new line.',
        keywords: 'enter newline composer',
        render: () => <SendKey />,
      },
      {
        id: 'restore',
        name: 'Restore the last session on launch',
        render: () => (
          <GeneralSwitch field="restoreLastSession" label="Restore the last session on launch" />
        ),
      },
      {
        id: 'confirm-quit',
        name: 'Ask before quitting while agents or terminal commands are running',
        keywords: 'quit confirm',
        render: () => (
          <GeneralSwitch
            field="confirmQuitWhileRunning"
            label="Ask before quitting while agents or terminal commands are running"
          />
        ),
      },
    ],
  }
}

export function useAppearanceSection(): SectionDef {
  return {
    id: 'appearance',
    title: 'Appearance',
    rows: [
      {
        id: 'theme',
        name: 'Theme',
        keywords: 'dark light system color',
        render: () => <ThemeTiles />,
      },
      {
        id: 'text-size',
        name: 'Text size',
        description: 'For the thread and the composer: 13, 14 or 15 px.',
        keywords: 'font',
        render: () => <TextSize />,
      },
      {
        id: 'reduce-motion',
        name: 'Reduce motion',
        description: 'System follows your operating system; Always removes movement everywhere.',
        keywords: 'animation accessibility',
        render: () => <ReduceMotion />,
      },
    ],
  }
}

export function useTerminalSection(): SectionDef {
  return {
    id: 'terminal',
    title: 'Terminal',
    rows: [
      {
        id: 'shell',
        name: 'Shell',
        description: isWindows
          ? 'pwsh when it is installed, else Windows PowerShell; or a program you pick.'
          : 'Your login shell ($SHELL), so the terminal sees the same tools; or a program you pick.',
        render: () => <ShellPicker />,
      },
      { id: 'font-size', name: 'Font size', description: 'In pixels.', render: () => <FontSize /> },
    ],
  }
}

export function useGitSection(): SectionDef {
  return {
    id: 'git',
    title: 'Git',
    rows: [
      {
        id: 'git',
        name: 'Git',
        description: 'Branch, changes and commits in the top bar.',
        render: () => <GitTool />,
      },
      {
        id: 'gh',
        name: 'GitHub CLI',
        description: 'Pull requests and their checks, through gh.',
        keywords: 'gh github pull request',
        render: () => <GhTool />,
      },
      {
        id: 'fetch',
        name: 'Fetch in the background',
        description: 'Every 5 minutes, so ahead and behind stay current.',
        render: () => <BackgroundFetch />,
      },
    ],
  }
}

export function useNotificationsSection(): SectionDef {
  const rows: SectionDef['rows'] = [
    {
      id: 'permission',
      name: 'Needs approval',
      description: 'When an agent waits for you to allow something.',
      keywords: 'permission',
      render: () => <NotificationSwitch field="permission" label="Needs approval" />,
    },
    {
      id: 'turn-ended',
      name: 'Turn finished',
      description: 'When an agent finishes what you asked.',
      render: () => <NotificationSwitch field="turnEnded" label="Turn finished" />,
    },
    {
      id: 'error',
      name: 'Errors',
      description: 'When a session fails or an agent stops unexpectedly.',
      render: () => <NotificationSwitch field="error" label="Errors" />,
    },
    {
      id: 'sound',
      name: 'Play a sound',
      description: 'The system notification sound.',
      render: () => <NotificationSwitch field="sound" label="Play a sound" />,
    },
  ]
  if (platform !== 'linux') {
    const name = isMac ? 'Show a count on the Dock icon' : 'Show a count on the taskbar button'
    rows.push({
      id: 'badge',
      name,
      description: 'How many sessions wait for your approval.',
      keywords: 'badge',
      render: () => <NotificationSwitch field="badge" label={name} />,
    })
  }
  return {
    id: 'notifications',
    title: 'Notifications',
    rows,
    footer: (
      <p className="px-1 text-xs text-muted-foreground">
        Shown only while no OverBench window is focused.
      </p>
    ),
  }
}

export function useShortcutsSection(): SectionDef {
  return {
    id: 'shortcuts',
    title: 'Keyboard shortcuts',
    rows: SHORTCUTS.map((s) => ({
      id: s.keys,
      name: s.action,
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
  return {
    id: 'advanced',
    title: 'Advanced',
    rows: [
      {
        id: 'proxy',
        name: 'Proxy',
        description: 'For agents, npx and updates.',
        keywords: 'http https network',
        layout: 'block',
        render: (text) => <Proxy label={text} />,
      },
      {
        id: 'diagnostics',
        name: 'Diagnostics',
        description:
          'A file with recent agent messages, logs and paths, for a bug report. It can contain code and prompts, so share it only with people you trust.',
        keywords: 'logs bug report',
        render: () => <Diagnostics />,
      },
      {
        id: 'data-folder',
        name: 'Data folder',
        description: 'Settings, the session index and logs.',
        render: () => <DataFolder />,
      },
      {
        id: 'remove-sessions',
        name: 'Remove all sessions from OverBench',
        description: "Clears OverBench's session list. The agents' transcripts stay.",
        keywords: 'delete clear',
        render: () => <RemoveAll />,
      },
    ],
  }
}

export function useAgentsSection(): SectionDef {
  const agents = useAgentsStore(useShallow((s) => usableAgents(s.order, s.byId)))
  return {
    id: 'agents',
    title: 'Agents',
    rows: agents.map((status) => ({
      id: status.id,
      name: status.name,
      description: status.account?.label ?? undefined,
      keywords: 'sign in login install node binary plan limits',
      layout: 'custom' as const,
      render: () => <AgentCard status={status} />,
    })),
    footer: <EnvironmentFooter />,
  }
}

export function useAboutSection(): SectionDef {
  const status = useUpdatesStore((s) => s.status)
  const updatesOff = status?.state.kind === 'off'
  return {
    id: 'about',
    title: 'About',
    rows: [
      {
        id: 'version',
        name: status ? `OverBench ${status.current}` : 'OverBench',
        description: 'A desktop workbench for Claude Code, Codex and OpenCode.',
        keywords: 'version electron chromium node',
        render: () => <Version />,
      },
      {
        id: 'update',
        name: 'Updates',
        keywords: 'update check download restart',
        layout: 'block',
        render: (text) => <UpdateRow status={status} label={text} />,
      },
      ...(updatesOff
        ? []
        : [
            {
              id: 'automatic',
              name: 'Automatic updates',
              description: 'Download and install in the background, only tell you, or neither.',
              render: () => <AutomaticUpdates />,
            },
          ]),
      {
        id: 'source',
        name: 'Source code',
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
