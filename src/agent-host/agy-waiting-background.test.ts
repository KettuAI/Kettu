// End-to-end host tests for Antigravity (agy 1.5.15+) sessions that keep `session/prompt` open
// while waiting on background tasks, sub-agents, or scheduled timers:
// 1. Finished replies leave Writing / streaming state and surface `waiting_background`.
// 2. Follow-up messages sent through default queueing (`sessions.queue`) deliver immediately via
//    agy's prompt-chain steering instead of being trapped in the queue.
// 3. Active streaming, queued-before-waiting messages, background wakeups, and permission cards
//    all behave cleanly.

import {
  agent,
  methods,
  RequestError,
  type AgentContext,
  type SessionUpdate,
} from '@agentclientprotocol/sdk/unstable'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ThreadEntry } from '@shared/thread'
import { inProcessTransport } from './acp/connection'
import type { ExitInfo } from './agent-process'
import type { AgentLauncher } from './agents'
import { startTestHost, type TestHost } from './testing/harness'

vi.setConfig({ testTimeout: 30_000 })

const WAITING_FOR_CARD = 'the running prompt is waiting for a permission or question answer'
const USAGE = { inputTokens: 10, outputTokens: 2, totalTokens: 12 }

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

interface ScriptedPrompt {
  text: string
  client: AgentContext
  sessionId: string
  resolve: (reason: 'end_turn' | 'cancelled') => void
}

/**
 * In-process fake agy 1.5.18 supporting prompt-chain steering and controllable background waits.
 */
function createScriptedAgy() {
  const prompts: ScriptedPrompt[] = []
  let active: ScriptedPrompt | null = null
  let asking = false
  let used = 1_000

  const notify = (sessionId: string, client: AgentContext, value: object) =>
    client.notify(methods.client.session.update, {
      sessionId,
      update: value as SessionUpdate,
    })

  const app = agent({ name: 'agy-bg-test' })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } },
      agentInfo: { name: 'Antigravity ACP Server', version: '1.5.18' },
      authMethods: [],
    }))
    .onRequest(methods.agent.session.new, () => ({ sessionId: 'agy-s-1' }))
    .onRequest(methods.agent.session.close, () => ({}))
    .onRequest(methods.agent.session.prompt, async (ctx) => {
      if (asking) throw new RequestError(-32603, `${WAITING_FOR_CARD}; answer it first`)
      const text = ctx.params.prompt
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n')
      // agy 1.5.15+ ends the previous held prompt with end_turn as soon as a new prompt arrives.
      active?.resolve('end_turn')
      const stopReason = await new Promise<'end_turn' | 'cancelled'>((resolve) => {
        const entry: ScriptedPrompt = {
          text,
          client: ctx.client,
          sessionId: ctx.params.sessionId,
          resolve,
        }
        active = entry
        prompts.push(entry)
      })
      return { stopReason, usage: USAGE }
    })
    .onNotification(methods.agent.session.cancel, () => {
      active?.resolve('cancelled')
      active = null
    })

  const launcher: AgentLauncher = {
    launch: () => {
      const transport = inProcessTransport(app)
      let resolveExit!: (info: ExitInfo) => void
      const exited = new Promise<ExitInfo>((resolve) => (resolveExit = resolve))
      let done = false
      const finish = (info: ExitInfo) => {
        if (done) return
        done = true
        transport.close()
        resolveExit(info)
      }
      return {
        pid: null,
        startedAt: Date.now(),
        transport,
        exited,
        get hasExited() {
          return done
        },
        stop: async () => {
          finish({ code: 0, signal: null })
          return exited
        },
        kill: async () => finish({ code: null, signal: 'SIGKILL' }),
      }
    },
  }

  return {
    launcher,
    prompts,
    get current() {
      return active
    },
    setAsking(value: boolean) {
      asking = value
    },
    async sendText(text: string) {
      const cur = active!
      await notify(cur.sessionId, cur.client, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
      })
    },
    async sendThought(text: string) {
      const cur = active!
      await notify(cur.sessionId, cur.client, {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text },
      })
    },
    async sendTool(toolCallId: string, name: string, status: 'in_progress' | 'completed') {
      const cur = active!
      await notify(cur.sessionId, cur.client, {
        sessionUpdate: status === 'in_progress' ? 'tool_call' : 'tool_call_update',
        toolCallId,
        name,
        kind: name === 'run_command' ? 'execute' : 'other',
        title: `Run ${name}`,
        rawInput:
          name === 'schedule'
            ? { DurationSeconds: 60, Prompt: 'Check status' }
            : name === 'run_command'
              ? { CommandLine: 'npm run build', WaitMsBeforeAsync: 500, toolSummary: 'Build' }
              : { Role: 'Worker', Prompt: 'Do work', TypeName: 'self' },
        status,
      })
    },
    async sendUsage() {
      const cur = active!
      used += 500
      await notify(cur.sessionId, cur.client, {
        sessionUpdate: 'usage_update',
        used,
        size: 1_048_576,
      })
    },
    async requestPermission(toolCallId: string) {
      const cur = active!
      asking = true
      try {
        await notify(cur.sessionId, cur.client, {
          sessionUpdate: 'tool_call',
          toolCallId,
          name: 'run_command',
          kind: 'execute',
          title: 'rm -rf /tmp/demo',
          rawInput: { CommandLine: 'rm -rf /tmp/demo', toolSummary: 'Remove demo' },
          status: 'pending',
        })
        return await cur.client.request(methods.client.session.requestPermission, {
          sessionId: cur.sessionId,
          toolCall: {
            toolCallId,
            name: 'run_command',
            kind: 'execute',
            title: 'rm -rf /tmp/demo',
            rawInput: { CommandLine: 'rm -rf /tmp/demo', toolSummary: 'Remove demo' },
            status: 'pending',
          } as never,
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
          ],
        })
      } finally {
        asking = false
      }
    },
    finish(reason: 'end_turn' | 'cancelled' = 'end_turn') {
      active?.resolve(reason)
      active = null
    },
  }
}

async function openAgySession() {
  const agy = createScriptedAgy()
  const host = await startTestHost({
    fakeAs: ['antigravity'],
    launcher: agy.launcher,
  })
  hosts.push(host)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'antigravity',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  return { agy, host, window, id }
}

const agentReplies = (entries: ThreadEntry[]) =>
  entries.filter(
    (entry): entry is Extract<ThreadEntry, { kind: 'agent' }> => entry.kind === 'agent',
  )

describe('Antigravity (agy) waiting on background tasks', () => {
  it('clears Writing/streaming state and delivers follow-ups sent via default queue while waiting on background work', async () => {
    const { agy, window, id } = await openAgySession()

    // Start a turn that schedules a timer, replies to the user, and keeps session/prompt open.
    await window.request('sessions.queue', {
      sessionId: id,
      content: [{ type: 'text', text: 'Set a 1-minute timer and let me know.' }],
    })
    await vi.waitFor(() => expect(agy.prompts).toHaveLength(1))

    // Step 1: calls `schedule` and completes the tool call.
    await agy.sendTool('call-sched', 'schedule', 'in_progress')
    await agy.sendTool('call-sched', 'schedule', 'completed')
    await agy.sendUsage()

    // Step 2: writes the reply with no tool calls, then pauses waiting for the timer.
    await agy.sendText('Timer set for 1 minute.')
    await window.until(() => agentReplies(window.entries(id)).some((entry) => entry.streaming))
    expect(window.summary(id)?.phase).toBe('writing')

    await agy.sendUsage()

    // Half A: once the tool-less step settles while session/prompt stays open, streaming stops and
    // phase switches from Writing to waiting_background.
    await window.until(() => window.thread(id).session.waitingBackground === true)
    expect(agentReplies(window.entries(id))).toEqual([
      expect.objectContaining({ markdown: 'Timer set for 1 minute.', streaming: false }),
    ])
    expect(window.summary(id)?.phase).toBe('waiting_background')
    expect(window.summary(id)?.status).toBe('running')

    // Half B: follow-up sent via default `sessions.queue` is delivered straight into agy instead of
    // getting trapped in the queue.
    const followUp = await window.request('sessions.queue', {
      sessionId: id,
      content: [{ type: 'text', text: 'While waiting, what is 2 + 2?' }],
    })
    expect(followUp).toEqual({ itemId: null })
    await window.until(() => window.thread(id).session.waitingBackground === false)
    expect(window.thread(id).session.queue).toEqual([])
    await vi.waitFor(() => expect(agy.prompts).toHaveLength(2))
    expect(agy.prompts[1]!.text).toContain('While waiting, what is 2 + 2?')

    // agy answers the follow-up while the background timer is still running -> settles back to waiting.
    await agy.sendText('2 + 2 is 4.')
    await window.until(() => agentReplies(window.entries(id)).length === 2)
    expect(agentReplies(window.entries(id))[1]).toMatchObject({
      markdown: '2 + 2 is 4.',
      streaming: true,
    })
    await agy.sendUsage()
    await window.until(() => window.thread(id).session.waitingBackground === true)
    expect(agentReplies(window.entries(id))[1]).toMatchObject({ streaming: false })

    // Finally the timer fires and agy resolves the open prompt chain.
    agy.finish('end_turn')
    await window.untilStatus(id, 'ready')
    expect(window.thread(id).session.waitingBackground).toBe(false)
    expect(window.thread(id).session.usage?.tokens).toMatchObject({ total: 24, output: 4 })
  })

  it('keeps messages queued during active streaming, then auto-steers them when agy enters background wait', async () => {
    const { agy, window, id } = await openAgySession()

    await window.request('sessions.queue', {
      sessionId: id,
      content: [{ type: 'text', text: 'Run build in background' }],
    })
    await vi.waitFor(() => expect(agy.prompts).toHaveLength(1))

    // Step 1: starts a background shell command that stays in_progress.
    await agy.sendTool('call-bg-cmd', 'run_command', 'in_progress')
    await agy.sendUsage()

    // Step 2: agy is actively streaming text (NOT waiting yet).
    await agy.sendText('Build started in the background.')
    await window.until(() => agentReplies(window.entries(id)).some((entry) => entry.streaming))
    expect(window.thread(id).session.waitingBackground).not.toBe(true)

    // User sends a message with default queue while agy is genuinely mid-stream -> stays queued.
    const queued = await window.request('sessions.queue', {
      sessionId: id,
      content: [{ type: 'text', text: 'Check lint too' }],
    })
    expect(queued.itemId).not.toBeNull()
    expect(window.thread(id).session.queue).toHaveLength(1)
    expect(agy.prompts).toHaveLength(1)

    // Now agy finishes speaking and pauses on the background build -> queued message auto-steers!
    await agy.sendUsage()
    await vi.waitFor(() => expect(agy.prompts).toHaveLength(2))
    expect(agy.prompts[1]!.text).toContain('Check lint too')
    await window.until(() => window.thread(id).session.queue.length === 0)
    // The background command tool entry stays in_progress (never cancelled by settling streaming).
    expect(window.entries(id).find((entry) => entry.id === 't:call-bg-cmd')).toMatchObject({
      status: 'in_progress',
    })

    await agy.sendText('Lint is clean.')
    agy.finish('end_turn')
    await window.untilStatus(id, 'ready')
  })

  it('resumes cleanly into a fresh streaming reply when a background wakeup arrives on the open prompt', async () => {
    const { agy, window, id } = await openAgySession()

    await window.request('sessions.queue', {
      sessionId: id,
      content: [{ type: 'text', text: 'Launch worker sub-agent' }],
    })
    await vi.waitFor(() => expect(agy.prompts).toHaveLength(1))

    await agy.sendTool('call-sub', 'invoke_subagent', 'in_progress')
    await agy.sendTool('call-sub', 'invoke_subagent', 'completed')
    await agy.sendUsage()
    await agy.sendText('Worker started.')
    await agy.sendUsage()
    await window.until(() => window.thread(id).session.waitingBackground === true)

    // Background sub-agent finishes later and wakes agy up with a direct agent reply (no tool/thought first).
    await agy.sendText('Worker finished with 0 errors.')
    await window.until(() => window.thread(id).session.waitingBackground === false)
    await window.until(() => agentReplies(window.entries(id)).length === 2)

    expect(agentReplies(window.entries(id)).map((e) => [e.markdown, e.streaming])).toEqual([
      ['Worker started.', false],
      ['Worker finished with 0 errors.', true],
    ])
    expect(window.summary(id)?.phase).toBe('writing')

    agy.finish('end_turn')
    await window.untilStatus(id, 'ready')
    expect(agentReplies(window.entries(id)).every((entry) => !entry.streaming)).toBe(true)
  })

  it('does not auto-steer or enter waitingBackground while a permission card waits for the user', async () => {
    const { agy, window, id } = await openAgySession()

    await window.request('sessions.queue', {
      sessionId: id,
      content: [{ type: 'text', text: 'Clean temp folder' }],
    })
    await vi.waitFor(() => expect(agy.prompts).toHaveLength(1))

    const permissionPromise = agy.requestPermission('call-rm')
    await window.untilStatus(id, 'awaiting_permission')
    await agy.sendUsage()
    await new Promise((resolve) => setTimeout(resolve, 450))

    expect(window.thread(id).session.waitingBackground).not.toBe(true)
    expect(window.summary(id)?.phase).toBeNull()

    // Message sent while waiting on permission card stays queued (never bypasses refusal handling).
    const queued = await window.request('sessions.queue', {
      sessionId: id,
      content: [{ type: 'text', text: 'Wait, skip that' }],
    })
    expect(queued.itemId).not.toBeNull()
    expect(window.thread(id).session.queue).toHaveLength(1)
    expect(agy.prompts).toHaveLength(1)

    // Answer the permission card and finish the turn -> queued message runs next as a normal turn.
    const tool = window.entries(id).find((entry) => entry.id === 't:call-rm')
    const requestId = tool?.kind === 'tool' ? tool.permission!.requestId : ''
    await window.request('permissions.respond', {
      sessionId: id,
      requestId,
      optionId: 'deny',
    })
    await permissionPromise
    agy.finish('end_turn')
    await vi.waitFor(() => expect(agy.prompts).toHaveLength(2))
    expect(agy.prompts[1]!.text).toContain('Wait, skip that')
    agy.finish('end_turn')
    await window.untilStatus(id, 'ready')
  })
})
