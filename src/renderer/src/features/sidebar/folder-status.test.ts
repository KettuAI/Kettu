import i18next, { type TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'
import { i18nOptions } from '@shared/locale'
import enSidebar from '@shared/locales/en/sidebar.json'
import zhSidebar from '@shared/locales/zh-CN/sidebar.json'
import type { TaskSummary } from '@shared/workflow'
import { sessionTree, type SessionNode } from '@renderer/stores/sessions'
import { collapsedFolderStatus, folderStatusText } from './folder-status'

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    agentId: 'claude-code',
    projectPath: '/proj/a',
    scratch: false,
    title: id,
    status: 'ready',
    attention: 'none',
    permissionCount: 0,
    createdAt: 1,
    updatedAt: 1,
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

function task(id: string, overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id,
    projectPath: '/proj/a',
    title: id,
    workflowId: 'wf-1',
    workflowName: 'Workflow',
    status: 'done',
    end: 'done',
    steps: [],
    at: null,
    needsYou: false,
    error: false,
    running: false,
    branch: null,
    worktreePath: null,
    agents: ['claude-code'],
    pinnedAt: null,
    archivedAt: null,
    unread: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function makeT(locale: 'en' | 'zh-CN'): TFunction<'sidebar'> {
  const instance = i18next.createInstance()
  void instance.init(
    i18nOptions(
      locale,
      {
        en: { sidebar: enSidebar },
        'zh-CN': { sidebar: zhSidebar },
      },
      'sidebar',
    ),
  )
  return instance.getFixedT(locale, 'sidebar') as TFunction<'sidebar'>
}

describe('collapsedFolderStatus', () => {
  it('returns null while the folder is expanded or the host is away', () => {
    const byId = {
      s1: summary('s1', { status: 'awaiting_permission', permissionCount: 1 }),
      s2: summary('s2', { status: 'running', phase: 'writing' }),
    }
    const tree = sessionTree(byId, '/proj/a')

    expect(collapsedFolderStatus(tree, { collapsed: false })).toBeNull()
    expect(collapsedFolderStatus(tree, { collapsed: true, away: true })).toBeNull()
    expect(collapsedFolderStatus([], { collapsed: true })).toBeNull()
  })

  it('returns null when every visible session in the collapsed folder is idle', () => {
    const byId = {
      s1: summary('s1', { status: 'ready', attention: 'none' }),
      s2: summary('s2', { status: 'closed', attention: 'none' }),
    }
    const tree = sessionTree(byId, '/proj/a')

    expect(collapsedFolderStatus(tree, { collapsed: true })).toBeNull()
  })

  it('prioritizes waiting > failed > running > starting > unread', () => {
    const unreadOnly = sessionTree(
      { s1: summary('s1', { status: 'ready', attention: 'unread' }) },
      '/proj/a',
    )
    expect(collapsedFolderStatus(unreadOnly, { collapsed: true })).toEqual({
      kind: 'unread',
      counts: { waiting: 0, failed: 0, running: 0, starting: 0, unread: 1 },
      row: {
        waiting: 0,
        failed: false,
        running: false,
        background: null,
        starting: false,
        unread: true,
      },
    })

    const withStarting = sessionTree(
      {
        s1: summary('s1', { status: 'ready', attention: 'unread' }),
        s2: summary('s2', { status: 'starting' }),
      },
      '/proj/a',
    )
    expect(collapsedFolderStatus(withStarting, { collapsed: true })).toMatchObject({
      kind: 'starting',
      counts: { waiting: 0, failed: 0, running: 0, starting: 1, unread: 1 },
      row: { starting: true, running: false, unread: true },
    })

    const withRunning = sessionTree(
      {
        s1: summary('s1', { status: 'ready', attention: 'unread' }),
        s2: summary('s2', { status: 'starting' }),
        s3: summary('s3', { status: 'running', phase: 'writing' }),
      },
      '/proj/a',
    )
    expect(collapsedFolderStatus(withRunning, { collapsed: true })).toMatchObject({
      kind: 'running',
      counts: { waiting: 0, failed: 0, running: 1, starting: 1, unread: 1 },
      row: { running: true, starting: true, unread: true },
    })

    const withFailed = sessionTree(
      {
        s1: summary('s1', { status: 'running', phase: 'thinking' }),
        s2: summary('s2', { status: 'ready', attention: 'error' }),
        s3: summary('s3', { status: 'failed' }),
      },
      '/proj/a',
    )
    expect(collapsedFolderStatus(withFailed, { collapsed: true })).toMatchObject({
      kind: 'failed',
      counts: { waiting: 0, failed: 2, running: 1, starting: 0, unread: 0 },
      row: { waiting: 0, failed: true, running: true },
    })

    const withWaiting = sessionTree(
      {
        s1: summary('s1', { status: 'awaiting_permission', permissionCount: 2 }),
        s2: summary('s2', { status: 'ready', attention: 'error' }),
        s3: summary('s3', { status: 'running', phase: 'writing' }),
        s4: summary('s4', { status: 'ready', attention: 'unread' }),
      },
      '/proj/a',
    )
    // An awaiting_permission session counts once under waiting and is not double-counted as running.
    expect(collapsedFolderStatus(withWaiting, { collapsed: true })).toEqual({
      kind: 'waiting',
      counts: { waiting: 1, failed: 1, running: 1, starting: 0, unread: 1 },
      row: {
        waiting: 1,
        failed: true,
        running: true,
        background: null,
        starting: false,
        unread: true,
      },
    })
  })

  it('excludes silent waiting_background sessions and wakes back up on active turns', () => {
    const waitingBg = sessionTree(
      {
        s1: summary('s1', {
          agentId: 'antigravity',
          status: 'running',
          phase: 'waiting_background',
          stillRunning: { commands: 1, subagents: 0, reportsBack: true },
        }),
        s2: summary('s2', {
          agentId: 'antigravity',
          status: 'running',
          phase: 'waiting_background',
          stillRunning: { commands: 0, subagents: 0, reportsBack: true, unnamed: true },
        }),
      },
      '/proj/a',
    )
    expect(collapsedFolderStatus(waitingBg, { collapsed: true })).toBeNull()

    // Unread reply with waiting_background still surfaces as unread rather than running.
    const waitingBgUnread = sessionTree(
      {
        s1: summary('s1', {
          agentId: 'antigravity',
          status: 'running',
          phase: 'waiting_background',
          attention: 'unread',
          stillRunning: { commands: 0, subagents: 1, reportsBack: true },
        }),
      },
      '/proj/a',
    )
    expect(collapsedFolderStatus(waitingBgUnread, { collapsed: true })).toMatchObject({
      kind: 'unread',
      counts: { waiting: 0, failed: 0, running: 0, starting: 0, unread: 1 },
      row: { running: false, background: null, unread: true },
    })

    // Once the turn resumes active work, it immediately promotes to running.
    const woken = sessionTree(
      {
        s1: summary('s1', {
          agentId: 'antigravity',
          status: 'running',
          phase: 'writing',
          stillRunning: null,
        }),
      },
      '/proj/a',
    )
    expect(collapsedFolderStatus(woken, { collapsed: true })).toMatchObject({
      kind: 'running',
      counts: { running: 1 },
      row: { running: true, background: null },
    })
  })

  it('excludes archived and pinned sessions while aggregating visible sub-sessions and sub-agent waits', () => {
    const byId = {
      archivedRunning: summary('archivedRunning', {
        status: 'running',
        phase: 'writing',
        archivedAt: 100,
      }),
      archivedWaiting: summary('archivedWaiting', {
        status: 'awaiting_permission',
        permissionCount: 1,
        archivedAt: 101,
      }),
      pinnedRunning: summary('pinnedRunning', {
        status: 'running',
        phase: 'writing',
        pinnedAt: 200,
      }),
      idleParent: summary('idleParent', { status: 'ready', attention: 'none' }),
      activeChild: summary('activeChild', {
        parentId: 'idleParent',
        status: 'running',
        phase: null,
      }),
      archivedChild: summary('archivedChild', {
        parentId: 'idleParent',
        status: 'awaiting_permission',
        permissionCount: 1,
        archivedAt: 102,
      }),
    }
    const tree = sessionTree(byId, '/proj/a')
    expect(collapsedFolderStatus(tree, { collapsed: true })).toMatchObject({
      kind: 'running',
      counts: { waiting: 0, failed: 0, running: 1, starting: 0, unread: 0 },
    })

    // Sub-agent permission requests roll up onto their parent node.
    const withSubagentWait = sessionTree(
      {
        root: summary('root', { status: 'ready', attention: 'none' }),
        sub: summary('sub', {
          parentId: 'root',
          origin: 'subagent',
          status: 'awaiting_permission',
          permissionCount: 1,
        }),
      },
      '/proj/a',
    )
    expect(collapsedFolderStatus(withSubagentWait, { collapsed: true })).toMatchObject({
      kind: 'waiting',
      counts: { waiting: 1, failed: 0, running: 0, starting: 0, unread: 0 },
    })

    // Defensive check: directly passed archived nodes are ignored too.
    const archivedNode: SessionNode = {
      summary: summary('directArchived', { status: 'running', archivedAt: 123 }),
      children: [
        {
          summary: summary('nestedUnderArchived', { status: 'running' }),
          children: [],
          subagents: [],
          permissionCount: 0,
          running: true,
          own: { permissionCount: 0, running: true },
        },
      ],
      subagents: [],
      permissionCount: 0,
      running: true,
      own: { permissionCount: 0, running: true },
    }
    expect(collapsedFolderStatus([archivedNode], { collapsed: true })).toBeNull()
  })

  it('aggregates non-archived workflow tasks inside a collapsed project folder', () => {
    const result = collapsedFolderStatus([], {
      collapsed: true,
      tasks: [
        task('t1', { status: 'running', needsYou: true, error: false, running: false }),
        task('t2', { status: 'running', needsYou: false, error: false, running: true }),
        task('t3', { status: 'done', unread: true }),
        task('t4', { status: 'running', running: true, archivedAt: 50 }),
        task('t5', { status: 'done', unread: false }),
      ],
    })
    expect(result).toMatchObject({
      kind: 'waiting',
      counts: { waiting: 1, failed: 0, running: 1, starting: 0, unread: 1 },
      row: { waiting: 1, failed: false, running: true, background: null, unread: true },
    })
  })
})

describe('folderStatusText', () => {
  const tEn = makeT('en')
  const tZh = makeT('zh-CN')

  it('formats single-bucket summaries with singular and plural copy in English and Chinese', () => {
    expect(
      folderStatusText(tEn, { waiting: 1, failed: 0, running: 0, starting: 0, unread: 0 }),
    ).toBe('1 session waiting for you')
    expect(
      folderStatusText(tEn, { waiting: 2, failed: 0, running: 0, starting: 0, unread: 0 }),
    ).toBe('2 sessions waiting for you')
    expect(
      folderStatusText(tEn, { waiting: 0, failed: 1, running: 0, starting: 0, unread: 0 }),
    ).toBe('1 session with an error')
    expect(
      folderStatusText(tEn, { waiting: 0, failed: 2, running: 0, starting: 0, unread: 0 }),
    ).toBe('2 sessions with errors')
    expect(
      folderStatusText(tEn, { waiting: 0, failed: 0, running: 1, starting: 0, unread: 0 }),
    ).toBe('1 session running')
    expect(
      folderStatusText(tEn, { waiting: 0, failed: 0, running: 3, starting: 0, unread: 0 }),
    ).toBe('3 sessions running')
    expect(
      folderStatusText(tEn, { waiting: 0, failed: 0, running: 0, starting: 1, unread: 0 }),
    ).toBe('1 session starting')
    expect(
      folderStatusText(tEn, { waiting: 0, failed: 0, running: 0, starting: 0, unread: 1 }),
    ).toBe('1 unread session')
    expect(
      folderStatusText(tEn, { waiting: 0, failed: 0, running: 0, starting: 0, unread: 2 }),
    ).toBe('2 unread sessions')

    expect(
      folderStatusText(tZh, { waiting: 1, failed: 0, running: 0, starting: 0, unread: 0 }),
    ).toBe('1 个会话等待确认')
    expect(
      folderStatusText(tZh, { waiting: 0, failed: 1, running: 0, starting: 0, unread: 0 }),
    ).toBe('1 个会话出错')
    expect(
      folderStatusText(tZh, { waiting: 0, failed: 0, running: 2, starting: 0, unread: 0 }),
    ).toBe('2 个会话运行中')
    expect(
      folderStatusText(tZh, { waiting: 0, failed: 0, running: 0, starting: 1, unread: 0 }),
    ).toBe('1 个会话正在启动')
    expect(
      folderStatusText(tZh, { waiting: 0, failed: 0, running: 0, starting: 0, unread: 2 }),
    ).toBe('2 个会话有未读回复')
  })

  it('joins multiple buckets in priority order', () => {
    expect(
      folderStatusText(tEn, { waiting: 1, failed: 1, running: 2, starting: 0, unread: 3 }),
    ).toBe('1 session waiting for you · 1 error · 2 running · 3 unread')
    expect(
      folderStatusText(tEn, { waiting: 0, failed: 0, running: 2, starting: 0, unread: 1 }),
    ).toBe('2 sessions running · 1 unread')

    expect(
      folderStatusText(tZh, { waiting: 1, failed: 1, running: 2, starting: 0, unread: 3 }),
    ).toBe('1 个会话等待确认 · 1 个出错 · 2 个运行中 · 3 个未读')
    expect(
      folderStatusText(tZh, { waiting: 0, failed: 0, running: 2, starting: 0, unread: 1 }),
    ).toBe('2 个会话运行中 · 1 个未读')
  })
})
