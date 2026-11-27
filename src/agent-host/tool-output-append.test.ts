import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Patch, ThreadEntry, ToolEntry } from '@shared/thread'
import { FakeAppServer, turn } from './testing/fake-app-server'
import { startTestHost, type TestHost, type TestPort } from './testing/harness'

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

const PROMPT = 'run build'

function receivedPatches(port: TestPort, sessionId: string): Patch[] {
  return port.events.flatMap((event) =>
    event.type === 'session.patches' && event.batch.sessionId === sessionId
      ? event.batch.patches
      : [],
  )
}

describe('tool-output-append 能力协商与旧设备透明降级', () => {
  it('桌面窗口与新设备收到增量 entry.appendOutput，旧设备自动降级为完整 entry.update 且最终状态一致', async () => {
    const server = new FakeAppServer()
    const started: { threadId?: string; turnId?: string } = {}
    server.on('turn/start', (params, self) => {
      const turnId = self.nextTurnId()
      const input = params.input as { text?: string }[]
      if (input[0]?.text === PROMPT) Object.assign(started, { threadId: params.threadId, turnId })
      return { turn: turn(turnId) }
    })

    const host = await startTestHost({
      fakeAppServer: server,
      sessionTimings: { flushMs: 0 },
    })
    hosts.push(host)

    const window = host.connect()
    const modern = host.connect({
      id: `${'0'.repeat(31)}1`,
      name: 'New Phone',
      toolOutputAppend: true,
    })
    const legacy = host.connect({
      id: `${'0'.repeat(31)}2`,
      name: 'Old Phone',
    })

    const { id } = await window.request('sessions.create', {
      agentId: 'codex',
      projectPath: host.project,
    })
    await window.open(id)
    await modern.open(id)
    await legacy.open(id)
    await window.untilStatus(id, 'ready')

    void window.request('sessions.prompt', {
      sessionId: id,
      content: [{ type: 'text', text: PROMPT }],
    })
    await vi.waitFor(() => expect(started.turnId).toBeDefined())

    const item = {
      type: 'commandExecution',
      id: 'cmd1',
      command: 'make',
      cwd: host.project,
      status: 'inProgress',
      commandActions: [{ type: 'unknown', command: 'make' }],
      aggregatedOutput: null,
      exitCode: null,
    }
    server.notify('item/started', { ...started, item })
    await Promise.all([
      window.untilEntry(id, (e) => e.id === 't:cmd1'),
      modern.untilEntry(id, (e) => e.id === 't:cmd1'),
      legacy.untilEntry(id, (e) => e.id === 't:cmd1'),
    ])

    // 分两段推送流式命令输出，触发两批补丁下发
    server.notify('item/commandExecution/outputDelta', {
      ...started,
      itemId: 'cmd1',
      delta: 'line 1\n',
    })
    const hasLine1 = (e: ThreadEntry): boolean =>
      e.id === 't:cmd1' &&
      e.kind === 'tool' &&
      e.content[0]?.type === 'markdown' &&
      e.content[0].markdown.includes('line 1')
    await Promise.all([
      window.untilEntry(id, hasLine1),
      modern.untilEntry(id, hasLine1),
      legacy.untilEntry(id, hasLine1),
    ])

    server.notify('item/commandExecution/outputDelta', {
      ...started,
      itemId: 'cmd1',
      delta: 'line 2\n',
    })
    const hasLine2 = (e: ThreadEntry): boolean =>
      e.id === 't:cmd1' &&
      e.kind === 'tool' &&
      e.content[0]?.type === 'markdown' &&
      e.content[0].markdown.includes('line 2')
    await Promise.all([
      window.untilEntry(id, hasLine2),
      modern.untilEntry(id, hasLine2),
      legacy.untilEntry(id, hasLine2),
    ])

    // 桌面窗口与支持新能力的设备收到 entry.appendOutput 增量补丁
    expect(receivedPatches(window, id).filter((p) => p.op === 'entry.appendOutput')).toEqual([
      { op: 'entry.appendOutput', id: 't:cmd1', text: 'line 1\n' },
      { op: 'entry.appendOutput', id: 't:cmd1', text: 'line 2\n' },
    ])
    expect(receivedPatches(modern, id).filter((p) => p.op === 'entry.appendOutput')).toEqual([
      { op: 'entry.appendOutput', id: 't:cmd1', text: 'line 1\n' },
      { op: 'entry.appendOutput', id: 't:cmd1', text: 'line 2\n' },
    ])

    // 未声明能力的旧设备绝不收到 entry.appendOutput，而是收到降级后的 entry.update（且不含内部字段 trailingNewline）
    const legacyPatches = receivedPatches(legacy, id)
    expect(legacyPatches.some((p) => p.op === 'entry.appendOutput')).toBe(false)
    const legacyUpdates = legacyPatches.filter(
      (p) => p.op === 'entry.update' && p.id === 't:cmd1' && 'content' in p.changes,
    )
    expect(legacyUpdates.length).toBeGreaterThanOrEqual(2)
    for (const patch of legacyUpdates) {
      if (patch.op !== 'entry.update') continue
      const content = (patch.changes as Partial<ToolEntry>).content
      expect(content?.[0]).not.toHaveProperty('trailingNewline')
    }

    // 三端最终渲染的 markdown 完全一致
    const expectedMarkdown = '```\nline 1\nline 2\n```'
    for (const port of [window, modern, legacy]) {
      const tool = port.entries(id).find((e) => e.id === 't:cmd1') as ToolEntry | undefined
      expect(tool?.content[0]).toMatchObject({ type: 'markdown', markdown: expectedMarkdown })
    }

    server.notify('item/completed', {
      ...started,
      item: { ...item, status: 'completed', aggregatedOutput: 'line 1\nline 2\n', exitCode: 0 },
    })
    server.notify('turn/completed', { ...started, turn: turn(started.turnId!, 'completed') })
    await window.untilStatus(id, 'ready')
  })
})
