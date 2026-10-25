import { describe, expect, it } from 'vitest'
import type { Project, SessionSummary } from '@shared/agent-host'
import { visibleProjects } from './project-group'

const session = (id: string, projectPath: string, extra: Partial<SessionSummary> = {}) =>
  ({
    id,
    projectPath,
    scratch: false,
    parentId: null,
    title: null,
    status: 'closed',
    attention: 'none',
    permissionCount: 0,
    createdAt: 0,
    updatedAt: 0,
    origin: 'user',
    description: null,
    missing: false,
    branch: null,
    pr: null,
    cache: null,
    model: null,
    pinnedAt: null,
    archivedAt: null,
    ...extra,
  }) as SessionSummary

const sessions = (...list: SessionSummary[]) =>
  Object.fromEntries(list.map((item) => [item.id, item]))

const project = (path: string): Project => ({
  path,
  name: path.slice(1),
  missing: false,
  lastOpenedAt: 0,
})

describe('visibleProjects', () => {
  it('leaves out a project that has no session', () => {
    expect(visibleProjects([project('/empty')], sessions())).toEqual([])
  })

  it('leaves out a project whose last session was archived', () => {
    expect(
      visibleProjects(
        [project('/archived')],
        sessions(session('a', '/archived', { archivedAt: 1 })),
      ),
    ).toEqual([])
  })

  it('keeps a project with a session to show', () => {
    expect(
      visibleProjects([project('/shown')], sessions(session('a', '/shown'))).map((p) => p.path),
    ).toEqual(['/shown'])
  })

  it('leaves out a project whose only session is pinned', () => {
    expect(
      visibleProjects([project('/pinned')], sessions(session('a', '/pinned', { pinnedAt: 1 }))),
    ).toEqual([])
  })

  it('keeps a project whose only unarchived session is a child under its parent', () => {
    expect(
      visibleProjects(
        [project('/child')],
        sessions(session('parent', '/child'), session('child', '/child', { parentId: 'parent' })),
      ),
    ).toHaveLength(1)
  })

  it('leaves out a project whose parent and child are archived', () => {
    expect(
      visibleProjects(
        [project('/child')],
        sessions(
          session('parent', '/child', { archivedAt: 1 }),
          session('child', '/child', { parentId: 'parent' }),
        ),
      ),
    ).toEqual([])
  })

  it('leaves scratch sessions for No project', () => {
    expect(
      visibleProjects([project('/repo')], sessions(session('a', '/repo', { scratch: true }))),
    ).toEqual([])
  })

  it('lists only the projects with sessions when both have a project entry', () => {
    expect(
      visibleProjects([project('/empty'), project('/shown')], sessions(session('a', '/shown'))).map(
        (p) => p.path,
      ),
    ).toEqual(['/shown'])
  })
})
