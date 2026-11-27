import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { ConversationHit, Project, SessionSummary } from '@shared/agent-host'
import { artifactKind, recency } from '@renderer/features/artifacts/model'
import { settingRow } from '@renderer/features/marketplace/plugin-model'
import { languageText, surfaceTitle } from '@renderer/features/plugin-views/plugin-text'
import { scheduleWords } from '@renderer/features/routines/model'
import { projectNameHints } from '@renderer/features/session/project-names'
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
import { isAway, useOtherHosts } from '@renderer/stores/hosts'
import {
  loadPluginSurfaces,
  usePluginSurfacesStore,
  type PluginSettingsSurface,
} from '@renderer/stores/plugin-surfaces'
import {
  findProjectForPath,
  findProjectForSession,
  isProjectArchived,
  isSessionInArchivedProject,
  projectFolders,
  useProjectsStore,
} from '@renderer/stores/projects'
import {
  hostOfSession,
  sessionArchived,
  sessionTitle,
  useSessionsStore,
} from '@renderer/stores/sessions'
import { useGitHubStarStore } from '@renderer/stores/github-star'
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
function findable(
  summary: SessionSummary,
  byId: Record<string, SessionSummary>,
  projects: readonly Project[],
): boolean {
  return (
    summary.origin !== 'subagent' &&
    !summary.prepared &&
    !summary.missing &&
    !sessionArchived(byId, summary.id) &&
    !isSessionInArchivedProject(summary, projects)
  )
}

/** Everything Search can find, across the window's stores. */
export function useSearchEntries(): SearchEntry[] {
  const sessions = useSessionEntries()
  const artifacts = useArtifactEntries()
  const routines = useRoutineEntries()
  const projects = useProjectEntries()
  const actions = useActionEntries()
  const pluginActions = usePluginActionEntries()
  const sections = useSectionEntries()
  const pluginSettings = usePluginSettingEntries()
  return useMemo(
    () => [
      ...sessions,
      ...artifacts,
      ...routines,
      ...projects,
      ...actions,
      ...pluginActions,
      ...sections,
      ...pluginSettings,
    ],
    [sessions, artifacts, routines, projects, actions, pluginActions, sections, pluginSettings],
  )
}

/**
 * A project's name by its path, with the parent folders that tell it from another of the same name
 * in brackets, and "No project" for the scratch folders.
 */
function useProjectName(): (path: string | null, owner?: string) => string {
  const { t } = useTranslation('sidebar')
  const projects = useProjectsStore(useShallow((s) => s.projects))
  const noProject = t('project.noProject')
  return useMemo(() => {
    const hints = projectNameHints(projects)
    return (path, owner) => {
      if (path === null) return noProject
      const project =
        findProjectForPath(projects, path) ??
        (owner ? projects.find((item) => item.path === owner) : undefined)
      const name = project?.name ?? basename(hostPath(path))
      const hint = project ? hints.get(project.path) : undefined
      return hint ? `${name} (${hint})` : name
    }
  }, [projects, noProject])
}

/** A session's project, host and branch as a row names them, the host only when hosts are mixed. */
function useSessionLine(): (summary: SessionSummary) => {
  title: string
  project: string
  host: string | null
  meta: string
} {
  const { t } = useTranslation('sidebar')
  const projectName = useProjectName()
  const others = useOtherHosts()
  const thisComputer = t('hosts.thisComputer')
  const unknown = t('hosts.unknown')
  const only = useOnlyHost()
  return useMemo(() => {
    const hostName = (id: string | null) =>
      id === null ? thisComputer : (others.find((host) => host.id === id)?.name ?? unknown)
    return (summary) => {
      const project = projectName(
        summary.scratch ? null : summary.projectPath,
        summary.projectOwner,
      )
      const host = others.length > 0 && only === undefined ? hostName(hostOfSession(summary)) : null
      const meta = [project, host, summary.branch].filter(Boolean).join(' · ')
      return { title: sessionTitle(summary), project, host, meta }
    }
  }, [projectName, others, thisComputer, unknown, only])
}

function useSessionEntries(): SearchEntry[] {
  const byId = useSessionsStore((s) => s.byId)
  const projects = useProjectsStore(useShallow((s) => s.projects))
  const lineOf = useSessionLine()
  const only = useOnlyHost()

  return useMemo(() => {
    return Object.values(byId)
      .filter(
        (summary) => findable(summary, byId, projects) && onHost(only, hostOfSession(summary)),
      )
      .map((summary): SearchEntry => {
        const { title, project, host, meta } = lineOf(summary)
        const hostId = hostOfSession(summary)
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
  }, [byId, projects, lineOf, only])
}

/** The sessions the hosts found by what was said in them, as Search's rows. */
export function useConversationEntries(hits: readonly ConversationHit[]): SearchEntry[] {
  const { t } = useTranslation('sidebar')
  const byId = useSessionsStore((s) => s.byId)
  const projects = useProjectsStore(useShallow((s) => s.projects))
  const lineOf = useSessionLine()
  return useMemo(
    () =>
      hits.flatMap((hit): SearchEntry[] => {
        const summary = byId[hit.sessionId]
        if (!summary || !findable(summary, byId, projects)) return []
        const { title, meta } = lineOf(summary)
        const matches = hit.matches ?? 1
        return [
          {
            kind: 'conversation',
            key: `conversation:${hit.sessionId}`,
            title,
            // The number of messages is told only when it is more than the one shown.
            meta: matches > 1 ? `${meta} · ${t('search.matches', { count: matches })}` : meta,
            trailing: shortAgo(summary.updatedAt),
            haystack: '',
            at: summary.updatedAt,
            sessionId: summary.id,
            projectPath: summary.projectPath,
            agentId: summary.agentId,
            hostId: hostOfSession(summary),
            entryId: hit.entryId,
            pos: hit.pos,
            snippet: hit.snippet,
          },
        ]
      }),
    [hits, byId, projects, lineOf, t],
  )
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
      if (findable(summary, byId, projects) && !summary.scratch) {
        const owner = findProjectForSession(projects, summary)?.path ?? summary.projectPath
        counts.set(owner, (counts.get(owner) ?? 0) + 1)
      }
    }
    return projects
      .filter(
        (project) =>
          !project.missing && !isProjectArchived(project) && onHost(only, hostOfPath(project.path)),
      )
      .map((project): SearchEntry => {
        const hostId = hostOfPath(project.path)
        const folder = dirname(hostPath(project.path))
        const host = hostId === null ? null : (others.find((h) => h.id === hostId)?.name ?? unknown)
        const count = counts.get(project.path) ?? 0
        const allPaths = projectFolders(project).map(hostPath).join(' ')
        return {
          kind: 'project',
          key: `project:${project.path}`,
          title: project.name,
          meta: host ? `${host} · ${folder}` : folder,
          trailing: count > 0 ? t('search.sessionCount', { count }) : null,
          haystack: haystackOf(project.name, host, allPaths),
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
  const starred = useGitHubStarStore((s) => s.state?.starred ?? false)
  return useMemo(() => {
    const english = i18n.getFixedT('en', 'sidebar')
    const keys = new Map(shortcutList('enter').map((shortcut) => [shortcut.action, shortcut.keys]))
    const listed = (action: SearchAction): boolean =>
      !(isWeb && action === 'openProject') && !(starred && action === 'starKettu')
    return SEARCH_ACTIONS.filter(listed).map((action): SearchEntry => {
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
    })
  }, [t, starred])
}

/** The hosts Search reads plugins from: the narrowed host, or every reachable host. */
function usePluginHostIds(): (string | null)[] {
  const others = useOtherHosts()
  const only = useOnlyHost()
  return useMemo<(string | null)[]>(
    () =>
      only === undefined
        ? [null, ...others.filter((host) => !isAway(host.connection)).map((host) => host.id)]
        : [only],
    [only, others],
  )
}

/**
 * The actions the plugins that are on declare, on each host the window shows that is reachable.
 * The hosts are read when Search opens, and a plugin changing is told by the host.
 */
function usePluginActionEntries(): SearchEntry[] {
  const { t, i18n: language } = useTranslation('sidebar')
  const only = useOnlyHost()
  const hostName = useHostName()
  const namesHosts = useNamesHosts()
  const byHost = usePluginSurfacesStore((s) => s.byHost)
  const hostIds = usePluginHostIds()
  useEffect(() => {
    for (const hostId of hostIds) {
      if (!byHost[hostId ?? '']) void loadPluginSurfaces(hostId)
    }
  }, [hostIds, byHost])

  return useMemo(
    () =>
      hostIds.flatMap((hostId) =>
        (byHost[hostId ?? '']?.plugins ?? []).flatMap((plugin) => {
          const pluginTitle = surfaceTitle(plugin, language.language)
          const group =
            namesHosts && only === undefined
              ? `${pluginTitle} \u00b7 ${hostName(hostId)}`
              : pluginTitle
          return plugin.actions.map((action): SearchEntry => {
            const title = languageText(action.title, language.language) || action.id
            const description = action.description
              ? languageText(action.description, language.language)
              : null
            return {
              kind: 'pluginAction',
              key: `pluginAction:${hostId ?? ''}/${plugin.pluginId}/${action.id}`,
              title,
              meta: description,
              trailing: t('search.pluginAction'),
              haystack: haystackOf(title, description, pluginTitle),
              at: 0,
              hostId,
              pluginId: plugin.pluginId,
              actionId: action.id,
              icon: action.icon ?? null,
              plugin: { name: plugin.name, title: group, icon: plugin.icon },
            }
          })
        }),
      ),
    [hostIds, byHost, language.language, namesHosts, only, hostName, t],
  )
}

/** Builds Search entries for plugin settings across `hostIds`, tagging each with its host. */
export function buildPluginSettingEntries({
  hostIds,
  byHost,
  language,
  showHost,
  hostName,
  trailing,
}: {
  hostIds: readonly (string | null)[]
  byHost: Record<string, { settings: PluginSettingsSurface[] } | undefined>
  language: string
  showHost: boolean
  hostName: (hostId: string | null) => string
  trailing: (plugin: string) => string
}): SearchEntry[] {
  return hostIds.flatMap((hostId) => {
    const host = showHost ? hostName(hostId) : null
    return (byHost[hostId ?? '']?.settings ?? []).flatMap((plugin) => {
      const pluginTitle = surfaceTitle(plugin, language)
      const label = host ? `${pluginTitle} \u00b7 ${host}` : pluginTitle
      return plugin.settings.map((setting): SearchEntry => ({
        kind: 'section',
        key: `pluginSetting:${hostId ?? ''}/${plugin.pluginId}/${setting.key}`,
        title: setting.title,
        meta: setting.description ?? null,
        trailing: trailing(label),
        haystack: haystackOf(setting.title, setting.description, pluginTitle, host),
        at: 0,
        pluginSetting: {
          hostId,
          pluginId: plugin.pluginId,
          row: settingRow(setting.key),
          plugin: { name: plugin.name, title: pluginTitle, icon: plugin.icon },
        },
      }))
    })
  })
}

/**
 * The settings plugins declare, on each host the window shows that is reachable; each opens its
 * plugin's page on that host. A plugin that is off keeps its settings.
 */
function usePluginSettingEntries(): SearchEntry[] {
  const { t, i18n: language } = useTranslation('sidebar')
  const only = useOnlyHost()
  const hostName = useHostName()
  const namesHosts = useNamesHosts()
  const byHost = usePluginSurfacesStore((s) => s.byHost)
  const hostIds = usePluginHostIds()
  useEffect(() => {
    for (const hostId of hostIds) {
      if (!byHost[hostId ?? '']) void loadPluginSurfaces(hostId)
    }
  }, [hostIds, byHost])
  return useMemo(
    () =>
      buildPluginSettingEntries({
        hostIds,
        byHost,
        language: language.language,
        showHost: namesHosts && only === undefined,
        hostName,
        trailing: (plugin) => t('search.pluginSetting', { plugin }),
      }),
    [hostIds, byHost, language.language, namesHosts, only, hostName, t],
  )
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
