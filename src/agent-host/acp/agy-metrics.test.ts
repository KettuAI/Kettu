import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type * as acp from '@agentclientprotocol/sdk/unstable'
import { afterEach, describe, expect, it } from 'vitest'
import { applyPatches, threadFromSnapshot, type ThreadState } from '@shared/thread'
import type { SessionTarget } from '../connection'
import { newTurnScope } from '../session-updates'
import {
  AgyMetrics,
  agyFullTranscriptFile,
  agyTranscriptFile,
  parseAgyPlannerStep,
  readLatestAgyStep,
  type AgyStepUsage,
} from './agy-metrics'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function createTarget(turnStartedAt: number | null = 1_000) {
  let thread: ThreadState = threadFromSnapshot({
    session: {
      id: 's',
      agentId: 'antigravity',
      projectPath: '/repo',
      acpSessionId: 'conv-1',
      status: 'running',
      title: null,
      config: [],
      commands: [],
      usage: null,
      error: null,
      turnStartedAt,
      turnStartUsed: null,
      createdAt: 0,
      updatedAt: 0,
      parentId: null,
      origin: 'user',
      subagent: null,
      routine: null,
      queue: [],
      queuePaused: false,
    },
    entries: [],
    seq: 0,
  })
  const scope = newTurnScope()
  const target: SessionTarget = {
    context: () => ({
      thread,
      replaying: false,
      cancelling: false,
      scope,
      now: 5_000,
      nextId: () => 'e:1',
      sessionIdFor: () => null,
    }),
    apply: (output) => {
      thread = applyPatches(thread, output.patches)
    },
    requestPermission: async () => ({ optionId: 'allow' }),
    send: () => {},
    startMode: () => null,
  }
  return { target, session: () => thread.session }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 15))

describe('agy transcript step parsing', () => {
  it('校验会话 ID 并拼接 transcript 路径', () => {
    expect(agyTranscriptFile('../evil', '/home/u')).toBeNull()
    expect(agyFullTranscriptFile('a/b', '/home/u')).toBeNull()
    expect(agyTranscriptFile('abc_123-def', '/home/u')).toBe(
      path.join(
        '/home/u',
        '.gemini',
        'antigravity-cli',
        'brain',
        'abc_123-def',
        '.system_generated',
        'logs',
        'transcript.jsonl',
      ),
    )
  })

  it('仅解析有效的 PLANNER_RESPONSE 行', () => {
    expect(parseAgyPlannerStep('{"type":"GENERIC","step_index":2,"content":"ok"}')).toBeNull()
    expect(parseAgyPlannerStep('not json')).toBeNull()
    expect(
      parseAgyPlannerStep(
        JSON.stringify({
          step_index: 5,
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-24T19:29:54Z',
          model: 'gemini-4-neon-xhigh',
          input_tokens: 5683,
          cache_read_tokens: 38953,
          output_tokens: 679,
        }),
      ),
    ).toEqual({
      stepIndex: 5,
      model: 'gemini-4-neon-xhigh',
      createdAt: Date.parse('2026-11-24T19:29:54Z'),
      input: 5683,
      cacheRead: 38953,
      cacheWrite: null,
      output: 679,
    })
  })

  it('从磁盘倒序读取最新一条 PLANNER_RESPONSE，文件缺失时返回 null', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agy-metrics-'))
    tempDirs.push(dir)
    expect(await readLatestAgyStep(path.join(dir, 'missing.jsonl'))).toBeNull()

    const file = path.join(dir, 'transcript.jsonl')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(
      file,
      [
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          model: 'gemini-4-neon-xhigh',
          input_tokens: 1000,
          cache_read_tokens: 0,
          output_tokens: 200,
        }),
        JSON.stringify({ step_index: 2, type: 'GENERIC', content: 'tool result' }),
        JSON.stringify({
          step_index: 3,
          type: 'PLANNER_RESPONSE',
          model: 'gemini-4-neon-xhigh',
          input_tokens: 500,
          cache_read_tokens: 1200,
          output_tokens: 350,
        }),
        JSON.stringify({ step_index: 4, type: 'GENERIC', content: 'later tool' }),
      ].join('\n') + '\n',
    )
    expect(await readLatestAgyStep(file)).toMatchObject({
      stepIndex: 3,
      input: 500,
      cacheRead: 1200,
      output: 350,
    })
  })
})

describe('AgyMetrics', () => {
  it('结合流式时间戳与 transcript 单步用量算出精确 TPS 与 lastRequest，且剔除工具耗时', async () => {
    let clock = 1_000
    let latest: AgyStepUsage | null = null
    const { target, session } = createTarget(1_000)
    const metrics = new AgyMetrics(
      async () => latest,
      { target: (id) => (id === 'conv-1' ? target : undefined), now: () => clock },
      [0],
    )

    // 第一步：t=1000 发 prompt，t=2000 首个思考到达，t=6000 发起工具调用，工具跑了 10 秒到 t=16000。
    metrics.onNewSession('conv-1')
    await metrics.preparePrompt('conv-1')
    clock = 2_000
    metrics.onUpdate(
      'conv-1',
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'plan' } },
      false,
    )
    clock = 6_000
    metrics.onUpdate(
      'conv-1',
      {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'ls',
        status: 'in_progress',
      } as acp.SessionUpdate,
      false,
    )
    // 即使 usage_update 在工具开始后稍晚到达，耗时也以 firstToolAt (6000) 截断。
    clock = 10_000
    latest = {
      stepIndex: 1,
      model: 'gemini-4-neon-xhigh',
      createdAt: 1_000,
      input: 38_952,
      cacheRead: 0,
      cacheWrite: null,
      output: 400,
    }
    metrics.onUpdate(
      'conv-1',
      { sessionUpdate: 'usage_update', used: 39_352, size: 1_048_576 },
      false,
    )
    await flush()

    expect(session().speed?.last).toEqual({
      tokens: 400,
      ms: 4_000,
      approx: false,
      firstTokenMs: 1_000,
    })
    expect(session().lastRequest).toEqual({
      at: 1_000,
      input: 38_952,
      cacheRead: 0,
      cacheWrite: null,
      output: 400,
      ms: 5_000,
    })

    // 工具于 t=16000 完成，第二步从 t=16000 开始，t=17000 首个文本到达，t=19000 usage_update。
    clock = 16_000
    metrics.onUpdate(
      'conv-1',
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
      } as acp.SessionUpdate,
      false,
    )
    clock = 17_000
    metrics.onUpdate(
      'conv-1',
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } },
      false,
    )
    clock = 19_000
    latest = {
      stepIndex: 3,
      model: 'gemini-4-neon-xhigh',
      createdAt: 16_000,
      input: 5_000,
      cacheRead: 39_352,
      cacheWrite: null,
      output: 300,
    }
    metrics.onUpdate(
      'conv-1',
      { sessionUpdate: 'usage_update', used: 44_652, size: 1_048_576 },
      false,
    )
    await flush()

    expect(session().speed?.last).toEqual({
      tokens: 300,
      ms: 2_000,
      approx: false,
      firstTokenMs: 1_000,
    })
    expect(session().speed?.session).toEqual({
      tokens: 700,
      ms: 6_000,
      requests: 2,
      approx: 0,
    })
    expect(session().lastRequest).toEqual({
      at: 16_000,
      input: 5_000,
      cacheRead: 39_352,
      cacheWrite: null,
      output: 300,
      ms: 3_000,
    })

    // 非模型调用（如切换模型）触发的重复 usage_update 不产生重复计数。
    clock = 25_000
    metrics.onUpdate(
      'conv-1',
      { sessionUpdate: 'usage_update', used: 44_652, size: 200_000 },
      false,
    )
    await flush()
    expect(session().speed?.session.requests).toBe(2)
  })

  it('无流式输出直接发工具调用时退化为 approx 估算速度', async () => {
    let clock = 1_000
    const { target, session } = createTarget(1_000)
    const latest: AgyStepUsage = {
      stepIndex: 1,
      model: 'gemini-4-neon-xhigh',
      createdAt: 1_000,
      input: 10_000,
      cacheRead: 0,
      cacheWrite: null,
      output: 200,
    }
    const metrics = new AgyMetrics(
      async () => latest,
      { target: () => target, now: () => clock },
      [],
    )
    metrics.onNewSession('conv-1')
    await metrics.preparePrompt('conv-1')
    clock = 3_000
    metrics.onUpdate(
      'conv-1',
      { sessionUpdate: 'usage_update', used: 10_200, size: 1_048_576 },
      false,
    )
    await flush()

    expect(session().speed?.last).toEqual({
      tokens: 200,
      ms: 2_000,
      approx: true,
      firstTokenMs: null,
    })
  })

  it('忽略 replay 更新且不重复消费历史基线步骤', async () => {
    let clock = 5_000
    const historical: AgyStepUsage = {
      stepIndex: 10,
      model: 'gemini-4-neon-xhigh',
      createdAt: 100,
      input: 5_000,
      cacheRead: 0,
      cacheWrite: null,
      output: 500,
    }
    const { target, session } = createTarget(5_000)
    const metrics = new AgyMetrics(
      async () => historical,
      { target: () => target, now: () => clock },
      [],
    )
    metrics.onExistingSession('conv-1')
    metrics.onUpdate(
      'conv-1',
      { sessionUpdate: 'usage_update', used: 5_500, size: 1_048_576 },
      true,
    )
    await metrics.preparePrompt('conv-1')
    clock = 7_000
    metrics.onUpdate(
      'conv-1',
      { sessionUpdate: 'usage_update', used: 5_500, size: 1_048_576 },
      false,
    )
    await flush()

    expect(session().speed).toBeUndefined()
    expect(session().lastRequest).toBeUndefined()
  })
})
