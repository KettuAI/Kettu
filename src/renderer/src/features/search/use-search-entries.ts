import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { SessionSummary } from '@shared/agent-host'
import { artifactKind, recency } from '@renderer/features/artifacts/model'
import { scheduleWords } from '@renderer/features/routines/model'
import { shortcutList, type ShortcutAction } from '@renderer/features/shell/shortcuts'
import { basename, dirname, shortAgo } from '@renderer/lib/format'
import { hostOfPath, hostPath } from '@renderer/lib/host-paths'
import { i18n } from '@renderer/lib/i18n'
import { isWeb } from '@renderer/lib/platform'
import { useArtifactsStore } from '@renderer/stores/artifacts'
import { useOtherHosts } from '@renderer/stores/hosts'
import { useProjectsStore } from '@renderer/stores/projects'
import { useRoutinesStore } from '@renderer/stores/routines'
import { hostOfSession, sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import type { SettingsSection } from '@renderer/stores/view'
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
  'usage',
  'git',
  'mcp',
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

/** Sessions Search can find: not archived, not prepared, and not a subagent the replay never named. */
function findable(summary: SessionSummary): boolean {
  return !summary.archivedAt && !summary.prepared && !summary.missing
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

  return useMemo(() => {
    const hostName = (id: string | null) =>
      id === null ? thisComputer : (others.find((host) => host.id === id)?.name ?? unknown)
    return Object.values(byId)
      .filter(findable)
      .map((summary): SearchEntry => {
        const hostId = hostOfSession(summary)
        const title = sessionTitle(summary)
        const project = projectName(summary.scratch ? null : summary.projectPath)
        const host = others.length > 0 ? hostName(hostId) : null
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
  }, [byId, projectName, others, thisComputer, unknown])
}

function useArtifactEntries(): SearchEntry[] {
  const { t } = useTranslation('artifacts')
  const list = useArtifactsStore((s) => s.list)
  const openedAt = useArtifactsStore((s) => s.openedAt)
  const projectName = useProjectName()

  return useMemo(
    () =>
      (list ?? []).map((artifact): SearchEntry => {
        const kind = artifactKind(artifact)
        const project = projectName(artifact.scratch ? null : artifact.project)
        const label = t(`page.kinds.${kind}`)
        const at = recency(artifact, openedAt)
        return {
          kind: 'artifact',
          key: `artifact:${artifact.id}`,
          title: artifact.title,
          meta: `${project} · ${label} · v${artifact.version}`,
          trailing: shortAgo(at),
          haystack: haystackOf(artifact.title, project, label),
          at,
          artifactId: artifact.id,
          artifactKind: kind,
        }
      }),
    [list, openedAt, projectName, t],
  )
}

function useRoutineEntries(): SearchEntry[] {
  const { t } = useTranslation('routines')
  const byId = useRoutinesStore((s) => s.byId)
  const order = useRoutinesStore((s) => s.order)
  const projectName = useProjectName()

  return useMemo(
    () =>
      order.flatMap((id): SearchEntry[] => {
        const routine = byId[id]
        if (!routine) return []
        const schedule = scheduleWords(routine.trigger.schedule)
        const project = projectName(routine.projectPath)
        return [
          {
            kind: 'routine',
            key: `routine:${routine.id}`,
            title: routine.name,
            meta: schedule,
            trailing: t(`state.${routine.state}`),
            haystack: haystackOf(routine.name, schedule, project),
            at: routine.activeRun?.startedAt ?? routine.lastRun?.startedAt ?? routine.updatedAt,
            routineId: routine.id,
          },
        ]
      }),
    [byId, order, projectName, t],
  )
}

function useProjectEntries(): SearchEntry[] {
  const { t } = useTranslation('sidebar')
  const projects = useProjectsStore(useShallow((s) => s.projects))
  const byId = useSessionsStore((s) => s.byId)
  const others = useOtherHosts()
  const unknown = t('hosts.unknown')

  return useMemo(() => {
    const counts = new Map<string, number>()
    for (const summary of Object.values(byId)) {
      if (findable(summary)) {
        counts.set(summary.projectPath, (counts.get(summary.projectPath) ?? 0) + 1)
      }
    }
    return projects
      .filter((project) => !project.missing)
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
  }, [projects, byId, others, unknown, t])
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
  return useMemo(() => {
    const english = i18n.getFixedT('en', ['settings', 'usage'])
    return SECTIONS.filter((id) => !(isWeb && id === 'account')).map((id): SearchEntry => {
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
  }, [t])
}
