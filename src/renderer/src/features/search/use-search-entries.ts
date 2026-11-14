import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { SessionSummary } from '@shared/agent-host'
import { artifactKind, recency } from '@renderer/features/artifacts/model'
import { scheduleWords } from '@renderer/features/routines/model'
import { shortcutList, type ShortcutAction } from '@renderer/features/shell/shortcuts'
import { useCloudOff } from '@renderer/lib/cloud'
import { basename, dirname, shortAgo } from '@renderer/lib/format'
import { hostOfPath, hostPath } from '@renderer/lib/host-paths'
import { i18n } from '@renderer/lib/i18n'
import { isWeb } from '@renderer/lib/platform'
import { useWindowArtifacts } from '@renderer/features/artifacts/window-artifacts'
import { useShownRoutines } from '@renderer/features/routines/window-routines'
import { artifactHost, routineHost } from '@renderer/lib/host'
import { useArtifactsStore } from '@renderer/stores/artifacts'
import { useOtherHosts } from '@renderer/stores/hosts'
import { useProjectsStore } from '@renderer/stores/projects'
import {
  hostOfSession,
  sessionArchived,
  sessionTitle,
  useSessionsStore,
} from '@renderer/stores/sessions'
import type { SettingsSection } from '@renderer/stores/view'
import { useHostName, useNamesHosts, useWindowHost } from '@renderer/stores/window-host'
import { haystackOf, SEARCH_ACTIONS, type SearchAction, type SearchEntry } from './search-model'

/** Settings sections in the order the page lists them. */
const SECTIONS: readonly SettingsSection[] = [
  'general',
  'appearance',
  'notifications',
  'account',
  'hosts',
  'browser',
  'agents',
  'harnesses',
  'memory',
  'usage',
  'git',
  'archived',
  'artifacts',
  'sharing',
  'terminal',
  'remote',
  'advanced',
  'about',
]

const ACTION_SHORTCUT: Partial<Record<SearchAction, ShortcutAction>> = {
  newSession: 'newSession',
  openProject: 'openProject',
  openSettings: 'settings',
  showShortcuts: 'showShortcuts',
  toggleSidebar: 'toggleSidebar',
}

/**
 * Sessions Search can find, as the sidebar lists them: no subagents, no prepared or missing
 * sessions, and nothing archived itself or under an archived parent.
 */
function findable(summary: SessionSummary, byId: Record<string, SessionSummary>): boolean {
  return (
    summary.origin !== 'subagent' &&
    !summary.prepared &&
    !summary.missing &&
    !sessionArchived(byId, summary.id)
  )
}

/** Everything Search can find, across the window's stores. */
export function useSearchEntries(): SearchEntry[] {
  const sessions = useSessionEntries()
  const artifacts = useArtifactEntries()
  const routines = useRoutineEntries()
  const projects = useProjectEntries()
  const actions = useActionEntries()
  const sections = useSectionEntries()
  return useMemo(
    () => [...sessions, ...artifacts, ...routines, ...projects, ...actions, ...sections],
    [sessions, artifacts, routines, projects, actions, sections],
  )
}

/** A project's name by its path, and "No project" for the scratch folders. */
function useProjectName(): (path: string | null) => string {
  const { t } = useTranslation('sidebar')
  const projects = useProjectsStore(useShallow((s) => s.projects))
  const noProject = t('project.noProject')
  return useMemo(() => {
    const names = new Map(projects.map((project) => [project.path, project.name]))
    return (path) => (path === null ? noProject : (names.get(path) ?? basename(hostPath(path))))
  }, [projects, noProject])
}

function useSessionEntries(): SearchEntry[] {
  const { t } = useTranslation('sidebar')
  const byId = useSessionsStore((s) => s.byId)
  const projectName = useProjectName()
  const others = useOtherHosts()
  const thisComputer = t('hosts.thisComputer')
  const unknown = t('hosts.unknown')
  const only = useOnlyHost()

  return useMemo(() => {
    const hostName = (id: string | null) =>
      id === null ? thisComputer : (others.find((host) => host.id === id)?.name ?? unknown)
    return Object.values(byId)
      .filter((summary) => findable(summary, byId) && onHost(only, hostOfSession(summary)))
      .map((summary): SearchEntry => {
        const hostId = hostOfSession(summary)
        const title = sessionTitle(summary)
        const project = projectName(summary.scratch ? null : summary.projectPath)
        const host = others.length > 0 && only === undefined ? hostName(hostId) : null
        const meta = [project, host, summary.branch].filter(Boolean).join(' · ')
        return {
          kind: 'session',
          key: `session:${summary.id}`,
          title,
          meta,
          trailing: shortAgo(summary.updatedAt),
          haystack: haystackOf(title, project, host, summary.branch, summary.description),
          at: summary.updatedAt,
          sessionId: summary.id,
          projectPath: summary.projectPath,
          agentId: summary.agentId,
          hostId,
        }
      })
  }, [byId, projectName, others, thisComputer, unknown, only])
}

function useArtifactEntries(): SearchEntry[] {
  const { t } = useTranslation('artifacts')
  // An away host's artifacts cannot be opened, so they are not offered.
  const { list, away } = useWindowArtifacts()
  const openedAt = useArtifactsStore((s) => s.openedAt)
  const projectName = useProjectName()
  const hostName = useHostName()
  const namesHosts = useNamesHosts()
  const only = useOnlyHost()
  const named = namesHosts && only === undefined

  return useMemo(
    () =>
      (away ? [] : (list ?? [])).map((artifact): SearchEntry => {
        const kind = artifactKind(artifact)
        const project = projectName(artifact.scratch ? null : artifact.project)
        const label = t(`page.kinds.${kind}`)
        const at = recency(artifact, openedAt)
        const host = named ? hostName(artifactHost(artifact.id)) : null
        return {
          kind: 'artifact',
          key: `artifact:${artifact.id}`,
          title: artifact.title,
          meta: [project, host, label, `v${artifact.version}`].filter(Boolean).join(' · '),
          trailing: shortAgo(at),
          haystack: haystackOf(artifact.title, project, label, host),
          at,
          artifactId: artifact.id,
          artifactKind: kind,
        }
      }),
    [list, away, openedAt, projectName, named, hostName, t],
  )
}

function useRoutineEntries(): SearchEntry[] {
  const { t } = useTranslation('routines')
  const routines = useShownRoutines()
  const projectName = useProjectName()
  const hostName = useHostName()
  const namesHosts = useNamesHosts()
  const only = useOnlyHost()
  const named = namesHosts && only === undefined

  return useMemo(
    () =>
      routines.map((routine): SearchEntry => {
        const schedule = scheduleWords(routine.trigger.schedule)
        const project = projectName(routine.projectPath)
        const host = named ? hostName(routineHost(routine.id)) : null
        return {
          kind: 'routine',
          key: `routine:${routine.id}`,
          title: routine.name,
          meta: host ? `${host} · ${schedule}` : schedule,
          trailing: t(`state.${routine.state}`),
          haystack: haystackOf(routine.name, schedule, project, host),
          at: routine.activeRun?.startedAt ?? routine.lastRun?.startedAt ?? routine.updatedAt,
          routineId: routine.id,
        }
      }),
    [routines, projectName, named, hostName, t],
  )
}

function useProjectEntries(): SearchEntry[] {
  const { t } = useTranslation('sidebar')
  const projects = useProjectsStore(useShallow((s) => s.projects))
  const byId = useSessionsStore((s) => s.byId)
  const others = useOtherHosts()
  const unknown = t('hosts.unknown')
  const only = useOnlyHost()

  return useMemo(() => {
    const counts = new Map<string, number>()
    for (const summary of Object.values(byId)) {
      if (findable(summary, byId)) {
        counts.set(summary.projectPath, (counts.get(summary.projectPath) ?? 0) + 1)
      }
    }
    return projects
      .filter((project) => !project.missing && onHost(only, hostOfPath(project.path)))
      .map((project): SearchEntry => {
        const hostId = hostOfPath(project.path)
        const folder = dirname(hostPath(project.path))
        const host = hostId === null ? null : (others.find((h) => h.id === hostId)?.name ?? unknown)
        const count = counts.get(project.path) ?? 0
        return {
          kind: 'project',
          key: `project:${project.path}`,
          title: project.name,
          meta: host ? `${host} · ${folder}` : folder,
          trailing: count > 0 ? t('search.sessionCount', { count }) : null,
          haystack: haystackOf(project.name, host, hostPath(project.path)),
          at: project.lastOpenedAt,
          path: project.path,
        }
      })
  }, [projects, byId, others, unknown, t, only])
}

/** The one host the window is narrowed to, null being this computer; undefined for every host. */
function useOnlyHost(): string | null | undefined {
  const host = useWindowHost()
  return host.kind === 'one' ? host.hostId : undefined
}

function onHost(only: string | null | undefined, hostId: string | null): boolean {
  return only === undefined || hostId === only
}

function useActionEntries(): SearchEntry[] {
  const { t } = useTranslation('sidebar')
  return useMemo(() => {
    const english = i18n.getFixedT('en', 'sidebar')
    const keys = new Map(shortcutList('enter').map((shortcut) => [shortcut.action, shortcut.keys]))
    return SEARCH_ACTIONS.filter((action) => !(isWeb && action === 'openProject')).map(
      (action): SearchEntry => {
        const title = t(`search.action.${action}`)
        const shortcut = ACTION_SHORTCUT[action]
        return {
          kind: 'action',
          key: `action:${action}`,
          title,
          meta: null,
          trailing: null,
          haystack: haystackOf(title, english(`search.action.${action}`)),
          at: 0,
          action,
          shortcut: (shortcut && keys.get(shortcut)) || null,
        }
      },
    )
  }, [t])
}

function useSectionEntries(): SearchEntry[] {
  const { t } = useTranslation(['settings', 'usage'])
  const cloudOff = useCloudOff()
  return useMemo(() => {
    const english = i18n.getFixedT('en', ['settings', 'usage'])
    const noAccount = isWeb || cloudOff
    return SECTIONS.filter((id) => !(noAccount && id === 'account')).map((id): SearchEntry => {
      const usage = id === 'usage'
      const title = usage ? t('usage:settings.title') : t(`settings:sections.${id}`)
      const inEnglish = usage ? english('usage:settings.title') : english(`settings:sections.${id}`)
      const description = usage ? t('usage:settings.description') : t(`settings:pages.${id}`)
      return {
        kind: 'section',
        key: `section:${id}`,
        title,
        meta: description,
        trailing: null,
        haystack: haystackOf(title, inEnglish, description),
        at: 0,
        section: id,
      }
    })
  }, [t, cloudOff])
}
