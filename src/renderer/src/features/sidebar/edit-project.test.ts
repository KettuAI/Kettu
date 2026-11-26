import { describe, expect, it } from 'vitest'
import type { Project, SessionSummary } from '@shared/agent-host'
import { projectNameHints } from '@renderer/features/session/project-names'
import { newSessionFolder, newSessionProject } from '@renderer/features/split/new-session-project'
import {
  findProjectForPath,
  findProjectForSession,
  isFolderMissing,
  projectFolders,
} from '@renderer/stores/projects'
import { projectGroupSummaries, projectSessionTree, visibleOrder } from '@renderer/stores/sessions'
import { removeSecondaryFolder, validateAdditionalFolder } from './edit-project-model'

function makeProject(overrides: Partial<Project> & { path: string; name: string }): Project {
  return {
    missing: false,
    lastOpenedAt: 100,
    pinnedAt: null,
    order: null,
    ...overrides,
  }
}

function makeSession(
  overrides: Partial<SessionSummary> & { id: string; projectPath: string },
): SessionSummary {
  return {
    agentId: 'fake-agent',
    scratch: false,
    title: overrides.id,
    status: 'ready',
    attention: 'none',
    permissionCount: 0,
    createdAt: 100,
    updatedAt: 100,
    parentId: null,
    origin: 'user',
    routine: null,
    description: null,
    missing: false,
    branch: null,
    pr: null,
    cache: null,
    model: null,
    pinnedAt: null,
    archivedAt: null,
    acpSessionId: null,
    ...overrides,
  }
}

describe('edit project folder validation', () => {
  const alpha = makeProject({
    path: '/work/alpha/app',
    name: 'Client Portal',
    customName: true,
    folders: ['/work/alpha/app', '/work/alpha/docs'],
  })
  const beta = makeProject({
    path: '/work/beta/app',
    name: 'Admin Console',
    customName: true,
  })
  const all = [alpha, beta]

  it('rejects empty, relative, duplicate, and cross-project paths', () => {
    const current = projectFolders(alpha)
    expect(validateAdditionalFolder('   ', alpha, current, all)).toEqual({
      ok: false,
      error: { kind: 'empty' },
    })
    expect(validateAdditionalFolder('relative/dir', alpha, current, all)).toEqual({
      ok: false,
      error: { kind: 'notAbsolute' },
    })
    expect(validateAdditionalFolder('/work/alpha/docs/', alpha, current, all)).toEqual({
      ok: false,
      error: { kind: 'duplicate' },
    })
    expect(validateAdditionalFolder('/work/beta/app', alpha, current, all)).toEqual({
      ok: false,
      error: { kind: 'otherProject', name: 'Admin Console' },
    })
    expect(validateAdditionalFolder('/work/alpha/sdk/', alpha, current, all)).toEqual({
      ok: true,
      path: '/work/alpha/sdk',
    })
  })

  it('prevents removing the primary folder or leaving zero folders', () => {
    const folders = ['/work/alpha/app', '/work/alpha/docs']
    expect(removeSecondaryFolder(folders, '/work/alpha/app', '/work/alpha/app')).toEqual(folders)
    expect(removeSecondaryFolder(folders, '/work/alpha/app', '/work/alpha/docs')).toEqual([
      '/work/alpha/app',
    ])
    expect(
      removeSecondaryFolder(['/work/alpha/app'], '/work/alpha/app', '/work/alpha/app'),
    ).toEqual(['/work/alpha/app'])
  })
})

describe('custom display names and disambiguation hints', () => {
  it('clears duplicate-folder hints once projects have distinct display names', () => {
    const sameName = [
      makeProject({ path: '/work/alpha/app', name: 'app' }),
      makeProject({ path: '/work/beta/app', name: 'app' }),
    ]
    expect(projectNameHints(sameName).get('/work/alpha/app')).toBe('alpha')
    expect(projectNameHints(sameName).get('/work/beta/app')).toBe('beta')

    const renamed = [
      makeProject({ path: '/work/alpha/app', name: 'Client Portal', customName: true }),
      makeProject({ path: '/work/beta/app', name: 'Admin Console', customName: true }),
    ]
    expect(projectNameHints(renamed).size).toBe(0)
  })
})

describe('multi-folder project session grouping and New session selection', () => {
  const project = makeProject({
    path: '/work/alpha/app',
    name: 'Client Portal',
    customName: true,
    folders: ['/work/alpha/app', '/work/alpha/docs'],
    missingFolders: ['/work/alpha/docs'],
  })

  it('resolves New session project and chosen source folder cleanly', () => {
    const view = {
      kind: 'new' as const,
      agentId: 'fake-agent' as const,
      projectPath: '/work/alpha/docs',
      noProject: false,
    }
    expect(newSessionProject(view, null, [project])?.path).toBe('/work/alpha/app')
    expect(newSessionFolder(view, null, project)).toBe('/work/alpha/docs')
    expect(isFolderMissing(project, '/work/alpha/docs')).toBe(true)
    expect(isFolderMissing(project, '/work/alpha/app')).toBe(false)

    // After removing the secondary folder, New session falls back to the primary folder.
    const single = makeProject({ path: '/work/alpha/app', name: 'Client Portal', customName: true })
    expect(newSessionFolder(view, null, single)).toBe('/work/alpha/app')
    expect(findProjectForPath([single], '/work/alpha/docs')).toBeUndefined()
  })

  it('groups sessions across source folders and preserves sessions after secondary folder removal', () => {
    const primarySession = makeSession({
      id: 's-primary',
      projectPath: '/work/alpha/app',
      updatedAt: 200,
    })
    const secondarySession = makeSession({
      id: 's-secondary',
      projectPath: '/work/alpha/docs',
      projectOwner: '/work/alpha/app',
      updatedAt: 300,
    })
    const byId = {
      [primarySession.id]: primarySession,
      [secondarySession.id]: secondarySession,
    }

    // Both sessions appear under the project while both folders are associated.
    expect(projectGroupSummaries(byId, project, null, [project]).map((s) => s.id)).toEqual([
      's-primary',
      's-secondary',
    ])
    expect(projectSessionTree(byId, project, [project]).map((n) => n.summary.id)).toEqual([
      's-secondary',
      's-primary',
    ])

    // Removing the secondary folder keeps the existing session's working directory intact and
    // keeps it associated with the owning project in the sidebar.
    const afterRemoval = makeProject({
      path: '/work/alpha/app',
      name: 'Client Portal',
      customName: true,
    })
    expect(secondarySession.projectPath).toBe('/work/alpha/docs')
    expect(findProjectForSession([afterRemoval], secondarySession)?.path).toBe('/work/alpha/app')
    expect(projectSessionTree(byId, afterRemoval, [afterRemoval]).map((n) => n.summary.id)).toEqual(
      ['s-secondary', 's-primary'],
    )
    expect(
      visibleOrder(
        {
          main: { kind: 'session', sessionId: 's-secondary' },
          collapsedProjects: {},
          expandedParents: {},
        },
        byId,
        [afterRemoval],
      ),
    ).toEqual(['s-secondary', 's-primary'])
  })
})
