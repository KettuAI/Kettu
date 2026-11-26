// Bot 核心单元测试：覆盖持久化 CRUD、自由指定 Harness、6 步跨机派发管线、离线待办与上线提醒、
// 合并回报与无人值守回合上限、受控 MCP 强制确认卡片，以及第 3 层 Bot 记忆。

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatus, HostEvent, Project } from '@shared/agent-host'
import type { BotHostTarget, BotRemoteAnswer, BotRemoteCall } from '@shared/bots'
import { DEFAULT_SETTINGS, type HostSettings } from '@shared/settings'
import { MemoryService } from '../memory/service'
import { BotManager, type BotSessionBridge } from './manager'
import {
  BotTools,
  CREATE_BOT,
  DELETE_BOT,
  DISPATCH_BOT_SESSION,
  HANDOFF_TO_BOT,
  LIST_BOTS,
  UPDATE_BOT,
  type BotAnswer,
  type BotAsk,
} from './tools'

function makeHostSettings(overrides: Partial<HostSettings> = {}): HostSettings {
  return {
    locale: 'en',
    initialSetupDone: true,
    agents: {},
    addedAgents: [],
    disabledAgents: [],
    proxy: { mode: 'environment' },
    git: { backgroundFetch: false, worktreeRoot: null },
    mcp: { kettu: { off: [] } },
    marketplace: { mcp: [], skills: [] },
    startModes: {},
    idleSessions: DEFAULT_SETTINGS.idleSessions,
    workflow: DEFAULT_SETTINGS.workflow,
    startedSessions: DEFAULT_SETTINGS.startedSessions,
    bots: { maxConcurrent: 6, allowAgentHandoff: true },
    usage: { fromComputer: false },
    sessionTitles: true,
    promptSuggestions: true,
    continueAfterLimit: true,
    agentPasswords: false,
    lightModel: { mode: 'small' },
    defaultAgent: 'claude-code',
    computerUse: DEFAULT_SETTINGS.computerUse,
    downloadService: false,
    ...overrides,
  }
}

function fakeAgent(
  id: AgentStatus['id'],
  name: string,
  mcpHttp: boolean | null = true,
): AgentStatus {
  return {
    id,
    name,
    harnessId: id as AgentStatus['harnessId'],
    harnessName: name,
    isDefault: true,
    hidden: false,
    disabled: false,
    apiKey: null,
    state: 'ready',
    version: '1.0.0',
    package: null,
    signIn: 'signed-in',
    authMethods: [],
    canLogout: false,
    account: null,
    limits: [],
    detail: null,
    installUrl: null,
    progress: [],
    launchCommand: id,
    binaryOverride: null,
    binaryCommand: null,
    update: null,
    updateCheckedAt: null,
    updateSkipped: false,
    task: null,
    installMethods: [],
    cli: null,
    configDir: null,
    kettuServer: { runs: true, active: true },
    capabilities: {
      loadSession: true,
      listSessions: true,
      resumeSession: true,
      closeSession: true,
      deleteSession: true,
      forkSession: false,
      forkAtMessage: false,
      steering: true,
      reports: false,
      context: false,
      liveContext: false,
      account: false,
      mcpHttp,
      prompt: null,
    },
  }
}

function makeFakeSessionBridge() {
  let seq = 1
  const sent: { sessionId: string; text: string; kettu?: true }[] = []
  const dispatches: Array<{ sessionId: string; requestId: string; status: string }> = []
  const archived: string[] = []
  const deleted: string[] = []
  const detachedBots: string[] = []
  const handoffs: Array<{
    sessionId: string
    entryId: string
    status: string
    summary: string | null
  }> = []
  const workCount = new Map<string, number>()

  const bridge: BotSessionBridge = {
    createMainSession: vi.fn(async () => ({ sessionId: `main-${seq++}` })),
    createWorkSession: vi.fn(async ({ bot }) => {
      workCount.set(bot.botId, (workCount.get(bot.botId) ?? 0) + 1)
      return { sessionId: `work-${seq++}`, branch: 'feat/demo' }
    }),
    sendMessage: vi.fn(async (sessionId, content, options) => {
      const text = content
        .map((c: { type: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : ''))
        .join('\n')
      sent.push({ sessionId, text, kettu: options?.kettu })
    }),
    readLatestReply: vi.fn(async (sessionId) => `Done reply from ${sessionId}`),
    archiveSession: vi.fn(async (sessionId) => {
      archived.push(sessionId)
    }),
    deleteSession: vi.fn(async (sessionId) => {
      deleted.push(sessionId)
    }),
    detachBotSessions: vi.fn(async (botId) => {
      detachedBots.push(botId)
      return workCount.get(botId) ?? 0
    }),
    countBotWorkSessions: (botId) => workCount.get(botId) ?? 0,
    isSessionRunning: () => false,
    upsertDispatchEntry: vi.fn((sessionId, entry) => {
      dispatches.push({ sessionId, requestId: entry.requestId, status: entry.status })
    }),
    addHandoffEntry: vi.fn((sessionId) => {
      const entryId = `handoff-${seq++}`
      handoffs.push({ sessionId, entryId, status: 'sent', summary: null })
      return entryId
    }),
    updateHandoffEntry: vi.fn((sessionId, entryId, changes) => {
      const row = handoffs.find((h) => h.sessionId === sessionId && h.entryId === entryId)
      if (row) {
        row.status = changes.status
        row.summary = changes.summary
      }
    }),
  }
  return { bridge, sent, dispatches, archived, deleted, detachedBots, handoffs }
}

describe('BotManager & BotTools', () => {
  let tmpDir: string
  let events: HostEvent[]
  let remoteTargets: BotHostTarget[]
  let remoteCalls: BotRemoteCall[]
  let manager: BotManager
  let sessions: ReturnType<typeof makeFakeSessionBridge>
  let settings: HostSettings

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kettu-bots-test-'))
    events = []
    remoteCalls = []
    remoteTargets = [
      {
        hostId: 'host-linux',
        name: 'Linux Build Box',
        platform: 'linux',
        online: false,
        self: false,
        projects: [{ path: '/srv/api', name: 'api' }],
        agents: [{ id: 'codex', name: 'Codex', ready: true, mcp: true }],
        load: null,
      },
    ]
    sessions = makeFakeSessionBridge()
    settings = makeHostSettings()
    const projects: Project[] = [
      { path: '/Users/dev/app', name: 'app', missing: false, lastOpenedAt: 1000 },
    ]
    const agents: AgentStatus[] = [
      fakeAgent('claude-code', 'Claude Code', true),
      fakeAgent('codex', 'Codex', true),
      fakeAgent('opencode', 'OpenCode', true),
      fakeAgent('gemini', 'Gemini CLI', false),
    ]
    manager = new BotManager({
      userDataPath: tmpDir,
      platform: 'darwin',
      hostName: () => 'MacBook Pro',
      settings: () => settings,
      projects: () => projects,
      agents: () => agents,
      sessions: sessions.bridge,
      remote: async (call): Promise<BotRemoteAnswer> => {
        remoteCalls.push(call)
        if (call.kind === 'list_targets') return { ok: true, data: remoteTargets }
        if (call.kind === 'dispatch_session') {
          const target = remoteTargets.find((t) => t.hostId === call.hostId)
          if (!target?.online) return { ok: false, code: 'offline', message: 'offline' }
          return {
            ok: true,
            data: { sessionId: `remote-sess-${remoteCalls.length}`, branch: 'main' },
          }
        }
        if (call.kind === 'read_session_reply') return { ok: true, data: 'Remote build green' }
        return { ok: true, data: null }
      },
      emit: (event) => events.push(event),
      log: () => {},
      reportDebounceMs: 10,
    })
    await manager.load()
  })

  afterEach(async () => {
    manager.dispose()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('支持自由选择任意启用且支持 MCP 的 Harness，并拒绝重复 handle 与无 MCP 的 Harness', async () => {
    const bot = await manager.create({
      name: '研发管家',
      handle: 'dev',
      agentId: 'opencode',
      description: '跨电脑协调项目',
      roleMarkdown: '# Role\n管项目',
    })
    expect(bot.handle).toBe('dev')
    expect(bot.agentId).toBe('opencode')
    expect(bot.roleMarkdown).toContain('管项目')

    // 重复 handle 拒绝
    await expect(
      manager.create({ name: '另一个', handle: 'dev', agentId: 'claude-code' }),
    ).rejects.toThrow(/already exists/i)

    // 不支持 MCP over HTTP 的 Harness 拒绝
    await expect(
      manager.create({ name: '无 MCP', handle: 'nomcp', agentId: 'gemini' }),
    ).rejects.toThrow(/MCP/i)

    // 自定义头像上传（合法 png）与读取
    const tinyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')
    const updated = await manager.uploadAvatar(bot.id, 'image/png', tinyPng)
    expect(updated.avatar.kind).toBe('image')
    const dataUrl = await manager.readAvatar(bot.id)
    expect(dataUrl?.dataUrl).toMatch(/^data:image\/png;base64,/)
  })

  it('实现 6 步管线：去重、并发排队、离线待办落盘、上线提醒、确认重派与合并回报', async () => {
    const bot = await manager.create({
      name: '管家',
      handle: 'mgr',
      agentId: 'claude-code',
      limits: { maxConcurrent: 1, maxDaily: 5, timeLimitMinutes: 30, maxUnattendedRounds: 2 },
    })
    await manager.sendMain({ botId: bot.id, text: '帮我看下两个项目' })
    expect(sessions.sent[0]?.text).toContain('<kettu-bot-context>')

    // 1. 本机派活 + 幂等 dedupKey
    const r1 = await manager.dispatch({
      botId: bot.id,
      targetHostId: null,
      projectPath: '/Users/dev/app',
      title: '修复登录',
      prompt: 'Fix login bug',
      dedupKey: 'pr-42',
    })
    expect(r1.status).toBe('running')
    const r1Dup = await manager.dispatch({
      botId: bot.id,
      targetHostId: null,
      projectPath: '/Users/dev/app',
      title: '修复登录重复',
      prompt: 'Fix login bug again',
      dedupKey: 'pr-42',
    })
    expect(r1Dup.id).toBe(r1.id)

    // 2. 达到单 Bot 并发上限（1）自动进入 queued
    const r2 = await manager.dispatch({
      botId: bot.id,
      targetHostId: null,
      projectPath: '/Users/dev/app',
      title: '补充单测',
      prompt: 'Add unit tests',
    })
    expect(r2.status).toBe('queued')

    // 3. D2 目标远端电脑离线 → 本地落盘 waiting_host 待办
    const rOffline = await manager.dispatch({
      botId: bot.id,
      targetHostId: 'host-linux',
      projectPath: '/srv/api',
      title: '跑集成测试',
      prompt: 'Run integration tests',
    })
    expect(rOffline.status).toBe('waiting_host')

    // 4. 远端主机重连上线 → 推送 bot.hostOnline 通知（不会自动盲发）
    remoteTargets[0]!.online = true
    await manager.onRemoteEvent({
      kind: 'host_online',
      hostId: 'host-linux',
      hostName: 'Linux Build Box',
    })
    const onlineEvt = events.find((e) => e.type === 'bot.hostOnline')
    expect(onlineEvt).toMatchObject({
      type: 'bot.hostOnline',
      hostId: 'host-linux',
      pendingCount: 1,
    })

    // 5. r1 等待用户拍板 → 切 waiting_user，但不自动唤醒主对话
    const sentBeforeWait = sessions.sent.length
    await manager.onLocalSessionUpdate({
      sessionId: r1.sessionId!,
      status: 'awaiting_permission',
      permissionCount: 1,
    })
    expect((await manager.get(bot.id)).status).toBe('needs_you')
    await new Promise((r) => setTimeout(r, 30))
    expect(sessions.sent.length).toBe(sentBeforeWait)

    // 6. r1 完成 → 自动出队 r2，并合并回报唤醒主对话
    await manager.onLocalSessionUpdate({
      sessionId: r1.sessionId!,
      status: 'ready',
      permissionCount: 0,
    })
    await new Promise((r) => setTimeout(r, 30))
    const work = await manager.workOf(bot.id)
    expect(work.find((w) => w.id === r1.id)?.status).toBe('delivered')
    expect(work.find((w) => w.id === r2.id)?.status).toBe('running')
    expect(sessions.sent.some((s) => s.kettu && s.text.includes('Bot work report'))).toBe(true)

    // 7. r2 完成后用户手动确认重派 rOffline 到远端主机
    await manager.onLocalSessionUpdate({
      sessionId: work.find((w) => w.id === r2.id)!.sessionId!,
      status: 'ready',
      permissionCount: 0,
    })
    const retried = await manager.retryPending(rOffline.id)
    expect(retried.status).toBe('running')
    expect(retried.sessionId).toMatch(/^remote-sess-/)

    // 8. 一键归档已完成会话
    const arch = await manager.archiveDone(bot.id)
    expect(arch.archived).toBe(2)

    // 9. 默认删除 Bot 保留历史会话转为普通会话
    await manager.delete(bot.id, true)
    expect(sessions.detachedBots).toContain(bot.id)
    expect(sessions.deleted).toHaveLength(0)
  })

  it('受控 MCP 工具 create_bot / update_bot / delete_bot 强制弹出确认卡片且单次限提议 1 个', async () => {
    let pendingResolve: ((answer: BotAnswer) => void) | null = null
    const asks: BotAsk[] = []
    const settled: Array<{ entryId: string; kind: string }> = []

    const tools = new BotTools({
      list: () => manager.list(),
      get: (id) => manager.get(id),
      findByHandle: (handle) => {
        const b = manager.findByHandle(handle)
        return b
          ? {
              ...b,
              roleMarkdown: '',
              status: 'idle',
              activeCount: 0,
              needsYouCount: 0,
              pendingHostCount: 0,
              todayCount: 0,
              memoryCount: 0,
              lastActivityAt: null,
            }
          : null
      },
      create: (d) => manager.create(d),
      update: (id, c) => manager.update(id, c),
      delete: (id, keep) => manager.delete(id, keep),
      listTargets: () => manager.listTargets(),
      dispatch: (p) => manager.dispatch(p),
      workOf: (id) => manager.workOf(id),
      sendToWorkSession: (id, text) => manager.sendToWorkSession(id, text),
      archiveRequest: (id) => manager.archiveRequest(id),
      handoff: (p) => manager.handoff(p),
      countSessions: (id) => manager.countSessions(id),
      allowAgentHandoff: () => settings.bots?.allowAgentHandoff !== false,
      botIdOfSession: (sid) => manager.botIdOfMainSession(sid),
      sessionAgent: () => 'claude-code',
      agents: () => [fakeAgent('claude-code', 'Claude Code', true)],
      ask: (_sid, ask) => {
        asks.push(ask)
        const entryId = `card-${asks.length}`
        const answer = new Promise<BotAnswer>((resolve) => {
          pendingResolve = resolve
        })
        return { entryId, answer }
      },
      settle: (_sid, entryId, outcome) => settled.push({ entryId, kind: outcome.kind }),
    })

    const caller = { sessionId: 'user-sess-1', project: '/Users/dev/app' }

    // 提议创建 Bot → 必须弹确认卡；在卡片未决议前发起第二个提议必须拒绝
    const createPromise = tools.call(caller, CREATE_BOT, {
      name: 'PR 审查官',
      handle: 'reviewer',
      scope: 'read',
    })
    expect(asks).toHaveLength(1)
    expect(asks[0]?.action).toBe('create')

    const secondTry = await tools.call(caller, CREATE_BOT, { name: '第二个', handle: 'second' })
    expect(secondTry.isError).toBe(true)

    pendingResolve!({ decision: 'confirm' })
    const createdRes = await createPromise
    expect(createdRes.isError).toBeUndefined()
    expect(settled.at(-1)?.kind).toBe('done')

    // list_bots 能读到刚创建的 Bot
    const listRes = await tools.call(caller, LIST_BOTS, {})
    expect((listRes.content[0] as { text: string }).text).toContain('@reviewer')

    // update_bot 用户拒绝 → 不修改
    const updPromise = tools.call(caller, UPDATE_BOT, { bot: '@reviewer', name: '改名失败' })
    await new Promise((r) => setTimeout(r, 0))
    pendingResolve!({ decision: 'decline' })
    const updRes = await updPromise
    expect((updRes.content[0] as { text: string }).text).toContain('declined')
    expect(manager.findByHandle('reviewer')?.name).toBe('PR 审查官')

    // dispatch_bot_session 显式指定 botId 可正常派发
    const botId = manager.findByHandle('reviewer')!.id
    const dispRes = await tools.call(caller, DISPATCH_BOT_SESSION, {
      botId,
      projectPath: '/Users/dev/app',
      title: '审查 PR #10',
      prompt: 'Review PR #10',
    })
    expect(dispRes.isError).toBeUndefined()

    // handoff_to_bot 受 allowAgentHandoff 开关控制
    settings.bots = { maxConcurrent: 6, allowAgentHandoff: false }
    const deniedHandoff = await tools.call(caller, HANDOFF_TO_BOT, {
      bot: 'reviewer',
      text: '帮看下这段 diff',
    })
    expect(deniedHandoff.isError).toBe(true)

    // delete_bot 默认 keepSessions=true，确认后删除
    const delPromise = tools.call(caller, DELETE_BOT, { bot: 'reviewer' })
    await new Promise((r) => setTimeout(r, 0))
    expect(asks.at(-1)?.action).toBe('delete')
    expect(asks.at(-1)?.bot.keepSessions).toBe(true)
    pendingResolve!({ decision: 'confirm', keepSessions: true })
    const delRes = await delPromise
    expect(delRes.isError).toBeUndefined()
    expect(manager.findByHandle('reviewer')).toBeNull()
  })

  it('支持第 3 层 Bot 记忆读写、索引生成与撤销回滚', async () => {
    const memory = new MemoryService({
      root: path.join(tmpDir, 'memory'),
      log: () => {},
      projects: () => [],
      claudeAgents: () => [],
    })
    await memory.load()
    const scope = { layer: 'bot' as const, botId: 'bot-aabbcc112233' }
    const saved = await memory.save(
      scope,
      null,
      {
        title: '优先跑 Mac Studio',
        description: 'iOS 编译和模拟器任务默认路由到 Mac Studio',
        body: 'Mac Studio 已安装 Xcode 16 与所有模拟器镜像。',
      },
      { agentId: 'claude-code', sessionId: 'main-1' },
    )
    const entries = await memory.list(scope)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.title).toBe('优先跑 Mac Studio')

    const idx = await memory.botIndex(scope.botId)
    expect(idx).toContain('优先跑 Mac Studio')

    // 撤销写入恢复为空
    expect(await memory.undo(saved.undo)).toBe('undone')
    expect(await memory.list(scope)).toHaveLength(0)
  })
})
