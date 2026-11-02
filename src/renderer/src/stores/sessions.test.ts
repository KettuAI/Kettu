import { describe, expect, it } from 'vitest'
import type { Project, SessionSummary } from '@shared/agent-host'
import { onHost } from '@renderer/lib/host-paths'
import { NO_PROJECT_GROUP, PINNED_GROUP, type MainView } from '@renderer/stores/view'
import {
  archivedSessions,
  inPinnedTree,
  isScratchFolder,
  needsYouTree,
  noProjectGroup,
  pinnedTree,
  sessionTree,
  sidebarTabStop,
  useSessionsStore,
  visibleOrder,
  type SidebarView,
} from './sessions'

const session = (id: string, projectPath: string, extra: Partial<SessionSummary> = {}) =>
  ({
    id,
    projectPath,
    scratch: false,
    parentId: null,
    updatedAt: 0,
    createdAt: 0,
    permissionCount: 0,
    status: 'closed',
    ...extra,
  }) as SessionSummary

const byId = Object.fromEntries(
  [
    session('p1', '/repo'),
    session('x1', '/data/scratch/a', { scratch: true, updatedAt: 1 }),
    session('x2', '/data/scratch/b', { scratch: true, updatedAt: 2 }),
    session('x3', '/data/scratch/a', { scratch: true, parentId: 'x1' }),
  ].map((s) => [s.id, s]),
)

describe('sessionTree', () => {
  it("groups No project's sessions across their scratch folders", () => {
    const tree = sessionTree(byId, null)
    expect(tree.map((n) => n.summary.id)).toEqual(['x2', 'x1'])
    expect(tree[1]!.children.map((n) => n.summary.id)).toEqual(['x3'])
    expect(sessionTree(byId, '/repo').map((n) => n.summary.id)).toEqual(['p1'])
  })
})

describe('pinned and archived sessions', () => {
  const sessions = Object.fromEntries(
    [
      session('a', '/repo', { updatedAt: 1 }),
      session('b', '/repo', { updatedAt: 2, pinnedAt: 20 }),
      session('b1', '/repo', { parentId: 'b' }),
      session('c', '/other', { updatedAt: 3, pinnedAt: 10 }),
      session('d', '/repo', { updatedAt: 4, archivedAt: 30 }),
      session('d1', '/repo', { parentId: 'd' }),
      session('e', '/repo', { updatedAt: 5, archivedAt: 40, pinnedAt: 5 }),
    ].map((s) => [s.id, s]),
  )

  it('leaves them out of their project, sub-sessions included', () => {
    expect(sessionTree(sessions, '/repo').map((n) => n.summary.id)).toEqual(['a'])
  })

  it('lists the pinned ones across projects in the order they were pinned', () => {
    const tree = pinnedTree(sessions)
    expect(tree.map((n) => n.summary.id)).toEqual(['c', 'b'])
    expect(tree[1]!.children.map((n) => n.summary.id)).toEqual(['b1'])
    expect(inPinnedTree(sessions, sessions.b1!)).toBe(true)
    expect(inPinnedTree(sessions, sessions.e!)).toBe(false)
  })

  it('lists the archived ones, the most recently archived first', () => {
    expect(archivedSessions(sessions).map((s) => s.id)).toEqual(['e', 'd'])
  })
})

describe('isScratchFolder', () => {
  it("knows a scratch session's folder from a project's", () => {
    expect(isScratchFolder(byId, '/data/scratch/a')).toBe(true)
    expect(isScratchFolder(byId, '/repo')).toBe(false)
  })
})

describe('sidebarTabStop', () => {
  const project = (path: string): Project => ({
    path,
    name: path.slice(1),
    missing: false,
    lastOpenedAt: 0,
  })
  const projects = [project('/repo'), project('/other')]
  const listed = (extra: Partial<SessionSummary> = {}, id = 'repo-1') =>
    session(id, '/repo', { updatedAt: 3, ...extra })
  const projectById = Object.fromEntries(
    [
      listed(),
      session('repo-2', '/repo', { updatedAt: 2 }),
      session('repo-1-child', '/repo', { parentId: 'repo-1' }),
      session('other-1', '/other', { updatedAt: 1 }),
      session('scratch-1', '/data/scratch/a', { scratch: true, updatedAt: 1 }),
    ].map((s) => [s.id, s]),
  )
  const view = (main: MainView, extra: Partial<Omit<SidebarView, 'main'>> = {}): SidebarView => ({
    main,
    collapsedProjects: {},
    expandedParents: {},
    ...extra,
  })
  const newSession: MainView = { kind: 'new', agentId: null, noProject: false }
  const shown = (id: string): MainView => ({ kind: 'session', sessionId: id })

  it("stops on the shown session's row while the list shows it", () => {
    expect(sidebarTabStop(view(shown('repo-1')), projectById, projects)).toEqual({
      kind: 'session',
      id: 'repo-1',
    })
    expect(sidebarTabStop(view(shown('scratch-1')), projectById, projects)).toEqual({
      kind: 'session',
      id: 'scratch-1',
    })
  })

  it('stops on the Pinned header with a pinned session and nothing shown', () => {
    const byId = { ...projectById, pinned: listed({ pinnedAt: 1 }, 'pinned') }
    expect(sidebarTabStop(view(newSession), byId, projects)).toEqual({
      kind: 'group',
      key: PINNED_GROUP,
    })
  })

  it('stops on the first project with a session when nothing is shown', () => {
    expect(sidebarTabStop(view(newSession), projectById, projects)).toEqual({
      kind: 'group',
      key: '/repo',
    })
  })

  it('stops on the No project header when it is the only group left', () => {
    const byId = { scratch: projectById['scratch-1']! }
    expect(sidebarTabStop(view(newSession), byId, projects)).toEqual({
      kind: 'group',
      key: NO_PROJECT_GROUP,
    })
  })

  it("stops on the first header while the shown session's group is collapsed", () => {
    const collapsed = { collapsedProjects: { '/repo': true as const } }
    expect(sidebarTabStop(view(shown('repo-1'), collapsed), projectById, projects)).toEqual({
      kind: 'group',
      key: '/repo',
    })
    const byId = { ...projectById, pinned: listed({ pinnedAt: 1 }, 'pinned') }
    const pinnedCollapsed = {
      collapsedProjects: { [PINNED_GROUP]: true as const },
    }
    expect(sidebarTabStop(view(shown('pinned'), pinnedCollapsed), byId, projects)).toEqual({
      kind: 'group',
      key: PINNED_GROUP,
    })
  })

  it("stops on the first header while the shown session's parent is collapsed", () => {
    expect(sidebarTabStop(view(shown('repo-1-child')), projectById, projects)).toEqual({
      kind: 'group',
      key: '/repo',
    })
    const expanded = { expandedParents: { 'repo-1': true } }
    expect(sidebarTabStop(view(shown('repo-1-child'), expanded), projectById, projects)).toEqual({
      kind: 'session',
      id: 'repo-1-child',
    })
  })

  it('has no stop while the list has no rows', () => {
    expect(sidebarTabStop(view(newSession), {}, [])).toBeNull()
    expect(
      sidebarTabStop(
        view(newSession),
        { archived: session('a', '/repo', { archivedAt: 1 }) },
        projects,
      ),
    ).toBeNull()
  })
})

describe('sessions on other hosts', () => {
  const devBox = 'a'.repeat(32)
  const api = onHost(devBox, '/home/lin/api')
  const project = (path: string): Project => ({ path, name: 'x', missing: false, lastOpenedAt: 0 })
  const projects = [project('/repo'), project(api)]
  const sessions = Object.fromEntries(
    [
      session('mine', '/repo', { updatedAt: 1 }),
      session('mine-scratch', '/data/scratch/a', { scratch: true }),
      session('theirs', api, { updatedAt: 2, attention: 'error' }),
      session('theirs-scratch', onHost(devBox, '/home/lin/.kettu/scratch/b'), { scratch: true }),
      session('waiting', '/repo', { updatedAt: 3 }),
      session('waiting-child', '/repo', { parentId: 'waiting', permissionCount: 1 }),
      session('archived', api, { archivedAt: 1, attention: 'error' }),
    ].map((s) => [s.id, s]),
  )

  it("keeps each host's No project sessions to it", () => {
    expect(sessionTree(sessions, null).map((n) => n.summary.id)).toEqual(['mine-scratch'])
    expect(sessionTree(sessions, null, devBox).map((n) => n.summary.id)).toEqual(['theirs-scratch'])
    expect(noProjectGroup(null)).toBe(NO_PROJECT_GROUP)
    expect(noProjectGroup(devBox)).not.toBe(NO_PROJECT_GROUP)
  })

  it('gathers what needs you across the hosts, a sub-session under its root', () => {
    const tree = needsYouTree(sessions)
    expect(tree.map((n) => [n.summary.id, n.permissionCount])).toEqual([
      ['waiting', 1],
      ['theirs', 0],
    ])
    expect(tree.every((n) => n.children.length === 0)).toBe(true)
  })

  it('orders the list by host, Needs you first, and visits a session once', () => {
    const view: SidebarView = {
      main: { kind: 'new', agentId: null, noProject: false },
      collapsedProjects: {},
      expandedParents: {},
      hosts: [null, devBox],
    }
    expect(visibleOrder(view, sessions, projects)).toEqual([
      'waiting',
      'theirs',
      'mine',
      'mine-scratch',
      'theirs-scratch',
    ])
    expect(visibleOrder({ ...view, hosts: [devBox] }, sessions, projects)).toEqual([
      'theirs',
      'theirs-scratch',
    ])
    expect(sidebarTabStop({ ...view, hosts: [devBox] }, sessions, projects)).toEqual({
      kind: 'group',
      key: api,
    })
  })

  it("leaves a host's sessions out of Needs you while it is not connected, and keeps them in its section", () => {
    const view: SidebarView = {
      main: { kind: 'new', agentId: null, noProject: false },
      collapsedProjects: {},
      expandedParents: {},
      hosts: [null, devBox],
      away: [devBox],
    }
    expect(visibleOrder(view, sessions, projects)).toEqual([
      'waiting',
      'mine',
      'mine-scratch',
      'theirs',
      'theirs-scratch',
    ])
  })

  it("lists each host's archived sessions apart, as its settings show them", () => {
    expect(archivedSessions(sessions)).toEqual([])
    expect(archivedSessions(sessions, devBox).map((s) => s.id)).toEqual(['archived'])
  })

  it("replaces one host's sessions and leaves the others'", () => {
    useSessionsStore.setState({ byId: sessions, loaded: false })
    useSessionsStore.getState().setAll([session('new', api)], devBox)
    expect(Object.keys(useSessionsStore.getState().byId).sort()).toEqual([
      'mine',
      'mine-scratch',
      'new',
      'waiting',
      'waiting-child',
    ])
    expect(useSessionsStore.getState().loaded).toBe(false)
    useSessionsStore.getState().setAll([])
    expect(Object.keys(useSessionsStore.getState().byId)).toEqual(['new'])
    expect(useSessionsStore.getState().loaded).toBe(true)
  })
})
