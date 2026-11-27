import { describe, expect, it } from 'vitest'
import type { Project, SessionSummary } from '@shared/agent-host'
import { onHost } from '@renderer/lib/host-paths'
import { pickupSessions } from '@renderer/features/session/new-session/picker'
import { newSessionProject } from '@renderer/features/split/new-session-project'
import {
  activeProjects,
  archivedProjects,
  canArchiveProject,
  isProjectArchived,
  isSessionInArchivedProject,
  pinnedFolders,
} from '@renderer/stores/projects'
import { sidebarTabStop, visibleOrder, type SidebarView } from '@renderer/stores/sessions'
import { buildArchivedEntries, buildArchivedProjects } from './archived-model'

function makeProject(overrides: Partial<Project> & { path: string; name: string }): Project {
  return {
    missing: false,
    lastOpenedAt: 100,
    pinnedAt: null,
    archivedAt: null,
    order: null,
    ...overrides,
  }
}

function makeSession(
  overrides: Partial<SessionSummary> & { id: string; projectPath: string },
): SessionSummary {
  return {
    agentId: 'claude-code',
    scratch: false,
    title: overrides.id,
    status: 'closed',
    attention: 'none',
    permissionCount: 0,
    createdAt: 10,
    updatedAt: 20,
    parentId: null,
    origin: 'user',
    routine: null,
    task: null,
    description: null,
    branch: null,
    missing: false,
    pr: null,
    cache: null,
    model: null,
    pinnedAt: null,
    archivedAt: null,
    acpSessionId: null,
    ...overrides,
  }
}

const baseView: SidebarView = {
  main: { kind: 'new', agentId: null, noProject: false },
  collapsedProjects: {},
  expandedParents: {},
}

const HOST_LEGACY = 'a'.repeat(32)
const HOST_B = 'b'.repeat(32)

describe('project archiving helpers and legacy host compatibility', () => {
  it('treats projects from older hosts without archivedAt as active and non-archivable', () => {
    const legacy: Project = {
      path: onHost(HOST_LEGACY, '/work/old'),
      name: 'old',
      missing: false,
      lastOpenedAt: 10,
    }
    const modernActive = makeProject({ path: '/work/active', name: 'active' })
    const modernArchived = makeProject({
      path: '/work/done',
      name: 'done',
      archivedAt: 500,
      pinnedAt: 200,
    })

    expect(isProjectArchived(legacy)).toBe(false)
    expect(canArchiveProject(legacy)).toBe(false)
    expect(isProjectArchived(modernActive)).toBe(false)
    expect(canArchiveProject(modernActive)).toBe(true)
    expect(isProjectArchived(modernArchived)).toBe(true)
    expect(canArchiveProject(modernArchived)).toBe(true)

    expect(activeProjects([legacy, modernActive, modernArchived])).toEqual([legacy, modernActive])
    expect(archivedProjects([legacy, modernActive, modernArchived])).toEqual([modernArchived])
    expect(pinnedFolders([legacy, modernActive, modernArchived], {}, [null])).toEqual([])
  })

  it('hides archived projects and their sessions from sidebar navigation, pickup and new-session defaults', () => {
    const active = makeProject({ path: '/work/active', name: 'Active' })
    const archived = makeProject({
      path: '/work/archived',
      name: 'Archived',
      folders: ['/work/archived', '/work/archived-docs'],
      archivedAt: 300,
    })
    const projects = [archived, active]

    const sActive = makeSession({ id: 's-active', projectPath: '/work/active', updatedAt: 50 })
    const sArchived = makeSession({
      id: 's-archived',
      projectPath: '/work/archived',
      pinnedAt: 10,
      updatedAt: 100,
    })
    const sArchivedDocs = makeSession({
      id: 's-archived-docs',
      projectPath: '/work/archived-docs',
      projectOwner: '/work/archived',
      updatedAt: 120,
    })
    const byId = {
      [sActive.id]: sActive,
      [sArchived.id]: sArchived,
      [sArchivedDocs.id]: sArchivedDocs,
    }

    expect(isSessionInArchivedProject(sActive, projects)).toBe(false)
    expect(isSessionInArchivedProject(sArchived, projects)).toBe(true)
    expect(isSessionInArchivedProject(sArchivedDocs, projects)).toBe(true)

    expect(visibleOrder(baseView, byId, projects)).toEqual(['s-active'])
    expect(sidebarTabStop(baseView, byId, projects)).toEqual({
      kind: 'group',
      key: '/work/active',
    })
    expect(pickupSessions(byId, [null], 3, projects).map((s) => s.id)).toEqual(['s-active'])
    expect(
      newSessionProject(
        { kind: 'new', agentId: null, noProject: false, projectPath: '/work/archived' },
        '/work/archived',
        projects,
      ),
    ).toEqual(active)

    // Once unarchived, the project and its retained active sessions return to the sidebar.
    const restoredProjects = [{ ...archived, archivedAt: null }, active]
    expect(visibleOrder(baseView, byId, restoredProjects)).toEqual([
      's-archived',
      's-archived-docs',
      's-active',
    ])
  })
})

describe('buildArchivedProjects for Settings > Archived', () => {
  it('groups retained historical sessions under each archived project by host and preserves custom names', () => {
    const localOld = makeProject({
      path: '/work/alpha',
      name: 'Alpha Portal',
      customName: true,
      folders: ['/work/alpha', '/work/alpha-api'],
      archivedAt: 100,
    })
    const localNew = makeProject({
      path: '/work/beta',
      name: 'Beta',
      archivedAt: 200,
    })
    const localActive = makeProject({
      path: '/work/active',
      name: 'Active',
      archivedAt: null,
    })
    const remoteArchived = makeProject({
      path: onHost(HOST_B, '/srv/gamma'),
      name: 'Gamma',
      archivedAt: 300,
    })
    const remoteLegacy: Project = {
      path: onHost(HOST_B, '/srv/legacy'),
      name: 'Legacy',
      missing: false,
      lastOpenedAt: 10,
    }
    const projects = [localOld, localNew, localActive, remoteArchived, remoteLegacy]

    const rootActive = makeSession({
      id: 'a-1',
      projectPath: '/work/alpha',
      title: 'Primary chat',
      updatedAt: 500,
    })
    const subOfRoot = makeSession({
      id: 'a-1-sub',
      projectPath: '/work/alpha',
      parentId: 'a-1',
      title: 'Sub chat',
      updatedAt: 510,
    })
    const extraFolderChat = makeSession({
      id: 'a-2',
      projectPath: '/work/alpha-api',
      projectOwner: '/work/alpha',
      title: 'API chat',
      archivedAt: 400,
      updatedAt: 450,
    })
    const remoteChat = makeSession({
      id: 'r-1',
      projectPath: onHost(HOST_B, '/srv/gamma'),
      title: 'Remote history',
      updatedAt: 600,
    })
    const byId = {
      [rootActive.id]: rootActive,
      [subOfRoot.id]: subOfRoot,
      [extraFolderChat.id]: extraFolderChat,
      [remoteChat.id]: remoteChat,
    }

    const localArchived = buildArchivedProjects(projects, byId, null)
    expect(localArchived.map((entry) => entry.project.path)).toEqual(['/work/beta', '/work/alpha'])
    expect(localArchived[0]!.sessions).toEqual([])
    expect(localArchived[1]!.folders).toEqual(['/work/alpha', '/work/alpha-api'])
    expect(localArchived[1]!.sessions.map((s) => s.summary.id)).toEqual(['a-1', 'a-2'])
    expect(localArchived[1]!.sessions[0]).toMatchObject({
      title: 'Primary chat',
      subSessionCount: 1,
      sessionArchived: false,
    })
    expect(localArchived[1]!.sessions[1]).toMatchObject({
      title: 'API chat',
      sessionArchived: true,
    })

    // Individually archived sessions still resolve the archived project's custom name.
    const archivedSessionEntries = buildArchivedEntries(
      [extraFolderChat],
      byId,
      projects,
      null,
      'No project',
    )
    expect(archivedSessionEntries[0]?.projectLabel).toBe('Alpha Portal')

    // Host scoping isolates remote archived projects cleanly without touching legacy projects.
    const remoteList = buildArchivedProjects(projects, byId, HOST_B)
    expect(remoteList.map((entry) => entry.project.path)).toEqual([onHost(HOST_B, '/srv/gamma')])
    expect(remoteList[0]!.sessions.map((s) => s.summary.id)).toEqual(['r-1'])
  })
})
