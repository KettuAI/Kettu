import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import type { Project, SessionSummary } from '@shared/agent-host'
import { onHost } from '@renderer/lib/host-paths'
import {
  activityButtonTone,
  activityContextText,
  activitySessions,
  activitySummaryText,
  countActivitySessions,
  searchButtonLabel,
} from './activity-sessions'

function makeProject(path: string, name: string, overrides: Partial<Project> = {}): Project {
  return {
    path,
    name,
    missing: false,
    lastOpenedAt: 1,
    pinnedAt: null,
    archivedAt: null,
    ...overrides,
  }
}

function makeSession(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    agentId: 'claude-code',
    projectPath: '/work/alpha',
    scratch: false,
    title: id,
    status: 'ready',
    attention: 'none',
    permissionCount: 0,
    createdAt: 1,
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

const REMOTE_ONLINE = '11111111111111111111111111111111'
const REMOTE_OFFLINE = '22222222222222222222222222222222'

describe('activitySessions filtering and sorting (#2563)', () => {
  const projects: Project[] = [
    makeProject('/work/alpha', 'Alpha'),
    makeProject('/work/beta', 'Beta'),
    makeProject('/work/archived', 'Old Project', { archivedAt: 500 }),
    makeProject(onHost(REMOTE_ONLINE, '/srv/api'), 'API'),
    makeProject(onHost(REMOTE_OFFLINE, '/srv/web'), 'Web'),
  ]

  it('includes waiting, running, starting, and background sessions while excluding idle and archived ones', () => {
    const byId: Record<string, SessionSummary> = {
      waitingPerm: makeSession('waitingPerm', {
        status: 'awaiting_permission',
        attention: 'permission',
        permissionCount: 2,
        updatedAt: 200,
      }),
      waitingQuestion: makeSession('waitingQuestion', {
        status: 'ready',
        attention: 'permission',
        permissionCount: 1,
        updatedAt: 250,
      }),
      runningTurn: makeSession('runningTurn', {
        status: 'running',
        phase: 'writing',
        updatedAt: 300,
      }),
      startingSession: makeSession('startingSession', {
        status: 'starting',
        updatedAt: 280,
      }),
      bgCommand: makeSession('bgCommand', {
        status: 'running',
        phase: 'waiting_background',
        stillRunning: { commands: 1, subagents: 0, reportsBack: true },
        updatedAt: 400,
      }),
      bgMonitor: makeSession('bgMonitor', {
        status: 'ready',
        stillRunning: { commands: 0, subagents: 0, monitors: 1, scheduled: 1, reportsBack: true },
        updatedAt: 350,
      }),
      bgSubagentParent: makeSession('bgSubagentParent', {
        status: 'ready',
        updatedAt: 150,
      }),
      bgSubagentChild: makeSession('bgSubagentChild', {
        parentId: 'bgSubagentParent',
        origin: 'subagent',
        status: 'running',
        phase: 'thinking',
        updatedAt: 320,
      }),
      idleReady: makeSession('idleReady', {
        status: 'ready',
        attention: 'none',
        updatedAt: 999,
      }),
      idleUnread: makeSession('idleUnread', {
        status: 'ready',
        attention: 'unread',
        updatedAt: 998,
      }),
      idleError: makeSession('idleError', {
        status: 'failed',
        attention: 'error',
        updatedAt: 997,
      }),
      archivedRunning: makeSession('archivedRunning', {
        status: 'running',
        archivedAt: 100,
        updatedAt: 996,
      }),
      archivedProjectSession: makeSession('archivedProjectSession', {
        projectPath: '/work/archived',
        status: 'running',
        updatedAt: 995,
      }),
      routineRun: makeSession('routineRun', {
        origin: 'routine',
        status: 'running',
        updatedAt: 994,
      }),
      taskStep: makeSession('taskStep', {
        origin: 'task',
        status: 'running',
        updatedAt: 993,
      }),
    }

    const items = activitySessions(byId, projects)
    expect(items.map((item) => [item.node.summary.id, item.bucket])).toEqual([
      ['waitingQuestion', 'waiting'],
      ['waitingPerm', 'waiting'],
      ['runningTurn', 'running'],
      ['startingSession', 'running'],
      ['bgCommand', 'background'],
      ['bgMonitor', 'background'],
      ['bgSubagentParent', 'background'],
    ])

    const counts = countActivitySessions(items)
    expect(counts).toEqual({ waiting: 2, running: 2, background: 3, total: 7 })
    expect(activityButtonTone(counts)).toBe('waiting')
  })

  it('rolls up waiting sub-sessions and sub-agents to their top-level session and sorts by latest update', () => {
    const byId: Record<string, SessionSummary> = {
      parentIdle: makeSession('parentIdle', {
        status: 'ready',
        updatedAt: 100,
      }),
      childWaiting: makeSession('childWaiting', {
        parentId: 'parentIdle',
        status: 'awaiting_permission',
        permissionCount: 1,
        updatedAt: 600,
      }),
      directWaitingOlder: makeSession('directWaitingOlder', {
        status: 'awaiting_permission',
        permissionCount: 1,
        updatedAt: 500,
      }),
      parentWithWaitingSubagent: makeSession('parentWithWaitingSubagent', {
        status: 'ready',
        updatedAt: 550,
      }),
      subagentWaiting: makeSession('subagentWaiting', {
        parentId: 'parentWithWaitingSubagent',
        origin: 'subagent',
        status: 'awaiting_permission',
        permissionCount: 1,
        updatedAt: 580,
      }),
    }

    const items = activitySessions(byId, projects)
    expect(items.map((item) => [item.node.summary.id, item.bucket, item.updatedAt])).toEqual([
      ['parentIdle', 'waiting', 600],
      ['parentWithWaitingSubagent', 'waiting', 550],
      ['directWaitingOlder', 'waiting', 500],
    ])
  })

  it('includes connected remote hosts, excludes offline hosts, and respects host filter', () => {
    const byId: Record<string, SessionSummary> = {
      localRun: makeSession('localRun', {
        projectPath: '/work/alpha',
        status: 'running',
        updatedAt: 200,
      }),
      remoteOnlineWait: makeSession('remoteOnlineWait', {
        projectPath: onHost(REMOTE_ONLINE, '/srv/api'),
        status: 'awaiting_permission',
        permissionCount: 1,
        updatedAt: 150,
      }),
      remoteOfflineWait: makeSession('remoteOfflineWait', {
        projectPath: onHost(REMOTE_OFFLINE, '/srv/web'),
        status: 'awaiting_permission',
        permissionCount: 1,
        updatedAt: 999,
      }),
    }

    const allConnected = activitySessions(byId, projects, {
      hosts: [null, REMOTE_ONLINE, REMOTE_OFFLINE],
      away: [REMOTE_OFFLINE],
    })
    expect(
      allConnected.map((item) => [item.node.summary.id, item.hostId, item.projectName]),
    ).toEqual([
      ['remoteOnlineWait', REMOTE_ONLINE, 'API'],
      ['localRun', null, 'Alpha'],
    ])

    const filteredHost = activitySessions(byId, projects, {
      hosts: [REMOTE_ONLINE],
      away: [REMOTE_OFFLINE],
    })
    expect(filteredHost.map((item) => item.node.summary.id)).toEqual(['remoteOnlineWait'])
  })

  it('disambiguates projects with the same display name and formats context labels for single/multi-host', () => {
    const duplicateProjects = [
      makeProject('/work/client/app', 'app'),
      makeProject('/work/server/app', 'app'),
    ]
    const byId: Record<string, SessionSummary> = {
      s1: makeSession('s1', { projectPath: '/work/client/app', status: 'running', updatedAt: 20 }),
      s2: makeSession('s2', {
        projectPath: '/tmp/scratch-1',
        scratch: true,
        status: 'running',
        updatedAt: 10,
      }),
    }

    const items = activitySessions(byId, duplicateProjects)
    expect(items[0]!.projectName).toBe('app · client')
    expect(items[1]!.projectName).toBeNull()

    expect(
      activityContextText(items[0]!, {
        noProjectLabel: 'No project',
        hostName: 'This computer',
        showHost: false,
        separator: ' · ',
      }),
    ).toBe('app · client')
    expect(
      activityContextText(items[0]!, {
        noProjectLabel: 'No project',
        hostName: 'Mac Studio',
        showHost: true,
        separator: ' · ',
      }),
    ).toBe('app · client · Mac Studio')
    expect(
      activityContextText(items[1]!, {
        noProjectLabel: 'No project',
        hostName: 'This computer',
        showHost: false,
        separator: ' · ',
      }),
    ).toBe('No project')
  })

  it('computes button tone, localized summary text, and search shortcut labels', () => {
    expect(activityButtonTone({ waiting: 0, running: 0, background: 0, total: 0 })).toBeNull()
    expect(activityButtonTone({ waiting: 0, running: 1, background: 2, total: 3 })).toBe('running')
    expect(activityButtonTone({ waiting: 0, running: 0, background: 1, total: 1 })).toBe(
      'background',
    )

    const fakeT = ((key: string, params?: Record<string, unknown>) => {
      if (key === 'activity.separator') return ' · '
      return `${key}:${String(params?.count ?? '')}`
    }) as unknown as TFunction<'sidebar'>
    expect(
      activitySummaryText(fakeT, { waiting: 0, running: 0, background: 0, total: 0 }),
    ).toBeNull()
    expect(activitySummaryText(fakeT, { waiting: 1, running: 2, background: 1, total: 4 })).toBe(
      'activity.waitingCount:1 · activity.runningCount:2 · activity.backgroundCount:1',
    )

    expect(searchButtonLabel('Search', '⌘K')).toBe('Search ⌘K')
    expect(searchButtonLabel('Search', 'Ctrl+K')).toBe('Search Ctrl+K')
    expect(searchButtonLabel('搜索', '⌘K')).toBe('搜索 ⌘K')
    expect(searchButtonLabel('搜索', 'Ctrl+K')).toBe('搜索 Ctrl+K')
  })
})
