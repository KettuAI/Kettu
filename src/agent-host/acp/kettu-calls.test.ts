// Calls of Kettu's own tools from ACP agents, as each names them: the plan, the drafted report and
// memory writes show no row, as Claude Code's do, and an agent whose naming is unknown keeps it.

import { agent, methods, type SessionUpdate } from '@agentclientprotocol/sdk/unstable'
import { describe, expect, it } from 'vitest'
import {
  applyPatches,
  threadEntries,
  threadFromSnapshot,
  type ThreadEntry,
  type ThreadState,
} from '@shared/thread'
import type { SessionTarget } from '../connection'
import { newTurnScope } from '../session-updates'
import { AcpConnection, inProcessTransport } from './connection'
import opencodeCalls from './fixtures/opencode-kettu-tools.json'
import opencodeErrors from './fixtures/opencode-script-errors.json'

/** A permission request the agent sends for a call, in place of an update. */
interface Ask {
  ask: Record<string, unknown>
}

/** The rows a turn of `updates` leaves, from an agent `initialize` names as `info`. */
async function rows(
  info: { name: string; version: string },
  updates: readonly (Ask | unknown)[],
): Promise<ThreadEntry[]> {
  const app = agent({ name: 'kettu-calls-test' })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: 1,
      agentCapabilities: { mcpCapabilities: { http: true } },
      agentInfo: info,
    }))
    .onRequest(methods.agent.session.new, () => ({ sessionId: 's-1' }))
    .onRequest(methods.agent.session.prompt, async (ctx) => {
      for (const update of updates) {
        if (typeof update === 'object' && update !== null && 'ask' in update) {
          await ctx.client.request(methods.client.session.requestPermission, {
            sessionId: ctx.params.sessionId,
            toolCall: (update as Ask).ask as never,
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
          })
          continue
        }
        await ctx.client.notify(methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: update as SessionUpdate,
        })
      }
      return { stopReason: 'end_turn' as const }
    })
  const connection = AcpConnection.connect(inProcessTransport(app), {
    traffic: () => {},
    account: () => {},
    ignored: () => {},
    log: () => {},
  })
  let thread: ThreadState = threadFromSnapshot({
    session: {
      id: 's',
      agentId: 'opencode',
      projectPath: '/tmp/probe',
      acpSessionId: 's-1',
      status: 'running',
      title: null,
      config: [],
      commands: [],
      usage: null,
      error: null,
      turnStartedAt: null,
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
  let n = 0
  const scope = newTurnScope()
  const target: SessionTarget = {
    context: () => ({
      thread,
      replaying: false,
      cancelling: false,
      scope,
      now: 5_000,
      nextId: () => `e:${++n}`,
      sessionIdFor: () => null,
    }),
    apply: (output) => {
      thread = applyPatches(thread, output.patches)
    },
    requestPermission: async (request) => {
      target.apply(request.output)
      return { optionId: 'allow' }
    },
    send: () => {},
    startMode: () => null,
  }
  await connection.initialize('1.0.0')
  const { sessionId } = await connection.newSession('/tmp/probe')
  connection.register(sessionId, target)
  await connection.prompt(sessionId, [{ type: 'text', text: 'go' }])
  connection.close()
  return threadEntries(thread)
}

const tools = (entries: ThreadEntry[]) =>
  entries.flatMap((entry) =>
    entry.kind === 'tool' ? [{ id: entry.id, title: entry.title, status: entry.status }] : [],
  )

/** A call titled as Claude Code names it, from its start to its end. */
function call(id: string, tool: string, end: 'completed' | 'failed' = 'completed'): unknown[] {
  return [
    {
      sessionUpdate: 'tool_call',
      toolCallId: id,
      title: `mcp__kettu__${tool}`,
      kind: 'other',
      status: 'in_progress',
      rawInput: { title: 'Run tests with pnpm test' },
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: id,
      status: end,
      ...(end === 'failed'
        ? { content: [{ type: 'content', content: { type: 'text', text: 'No memory run-tests' } }] }
        : {}),
    },
  ]
}

describe("OpenCode's Kettu calls", () => {
  it('hide a script that only sets the plan or writes memory, and keep any other', async () => {
    const entries = await rows({ name: 'OpenCode', version: '2.0.32' }, opencodeCalls)
    expect(tools(entries)).toEqual([
      // OpenCode's own resource listing.
      { id: 't:call_dca3fded7eb34b94a8122d2a', title: 'execute', status: 'completed' },
      // A memory write that failed wrote nothing, so its script keeps the row, failed as it threw.
      { id: 't:call_00_ET_h0GlZLyDZ8fzusvyTSA06300', title: 'execute', status: 'failed' },
      // A script that also lists the sessions.
      { id: 't:call_00_QYgqMYloexdcQH1YVCTn0546', title: 'execute', status: 'completed' },
    ])
  })

  it('keep every row on a version not checked', async () => {
    const entries = await rows({ name: 'OpenCode', version: '2.0.31' }, opencodeCalls)
    expect(tools(entries)).toHaveLength(5)
  })
})

describe("OpenCode's scripts that threw", () => {
  it('fail, with the error they threw, though OpenCode ends them as completed', async () => {
    const entries = await rows({ name: 'OpenCode', version: '2.0.32' }, opencodeErrors)
    expect(
      entries.flatMap((entry) =>
        entry.kind === 'tool' ? [{ id: entry.id, status: entry.status, text: textOf(entry) }] : [],
      ),
    ).toEqual([
      { id: 't:call_5e7f656c99f44e598d882fe6', status: 'failed', text: 'Error: boom from probe' },
      // It threw after a call of Kettu's that went through.
      { id: 't:call_00_ET_3S1xAYBvBBN3oMs3dznM1763', status: 'failed', text: 'Error: after list' },
    ])
  })
})

/** The text a tool row shows. */
function textOf(entry: ThreadEntry): string {
  if (entry.kind !== 'tool') return ''
  return entry.content
    .map((item) => (item.type === 'markdown' ? item.markdown : JSON.stringify(item)))
    .join('\n')
}

describe("Kettu's calls named as Claude Code names them", () => {
  it('hide the plan and the report, and memory writes unless they fail', async () => {
    const entries = await rows({ name: 'fake-agent', version: '0.1.0' }, [
      ...call('c1', 'remember'),
      ...call('c2', 'update_memory', 'failed'),
      ...call('c3', 'read_memory'),
      ...call('c4', 'set_plan'),
      ...call('c5', 'report_problem'),
      ...call('c6', 'set_plan', 'failed'),
    ])
    expect(entries.map((e) => [e.id, e.kind === 'tool' ? e.status : null])).toEqual([
      ['t:c2', 'failed'],
      ['t:c3', 'completed'],
    ])
    expect(entries[0]).toMatchObject({ title: 'mcp__kettu__update_memory', content: [{}] })
  })

  it('keep the row of a call that asked for permission, through to its end', async () => {
    const [start, end] = call('c1', 'remember')
    const entries = await rows({ name: 'fake-agent', version: '0.1.0' }, [
      start,
      { ask: { ...(start as object), sessionUpdate: undefined, status: 'pending' } },
      end,
    ])
    expect(tools(entries)).toEqual([
      { id: 't:c1', title: 'mcp__kettu__remember', status: 'completed' },
    ])
  })

  it('keep every row from an agent whose naming is unknown', async () => {
    const entries = await rows({ name: 'some-agent', version: '9.9.9' }, [
      ...call('c1', 'remember'),
      ...call('c2', 'set_plan'),
    ])
    expect(tools(entries).map((row) => row.title)).toEqual([
      'mcp__kettu__remember',
      'mcp__kettu__set_plan',
    ])
  })
})
