// The connection against recorded answers: routing of session updates, the startup note it drops
// for an agent marked so, and the legacy modes it ignores.

import os from 'node:os'
import { describe, expect, it } from 'vitest'
import type { AnyMessage } from '@agentclientprotocol/sdk/unstable'
import { applyPatches, threadEntries, threadFromSnapshot, type ThreadState } from '@shared/thread'
import { loadFakeAgent } from '../testing/harness'
import {
  AgentConnection,
  inProcessTransport,
  type AcpTransport,
  type SessionTarget,
} from './connection'
import { newTurnScope } from './mapper'

/** A target that applies the patches to a thread, so the test reads what reached the thread. */
function threadTarget(): {
  target: SessionTarget
  entries: () => ReturnType<typeof threadEntries>
} {
  let thread: ThreadState = threadFromSnapshot({
    session: {
      id: 's',
      agentId: 'pi',
      projectPath: os.tmpdir(),
      acpSessionId: 'pi-session-1',
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
  return {
    target: {
      context: () => ({
        thread,
        replaying: false,
        thoughtParts: false,
        cancelling: false,
        scope,
        now: Date.now(),
        nextId: () => `e:${++n}`,
        sessionIdFor: () => null,
      }),
      apply: (output) => {
        thread = applyPatches(thread, output.patches)
      },
      requestPermission: () => Promise.resolve('cancelled'),
    },
    entries: () => threadEntries(thread),
  }
}

/** A transport to a scripted agent that answers with the given pi-acp 0.0.34 messages. */
function scripted(
  answer: (message: { id?: number; method?: string; params?: unknown }) => AnyMessage[],
): AcpTransport {
  const toAgent = new TransformStream<AnyMessage, AnyMessage>()
  const toClient = new TransformStream<AnyMessage, AnyMessage>()
  const reader = toAgent.readable.getReader()
  const writer = toClient.writable.getWriter()
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      const message = value as { id?: number; method?: string; params?: unknown }
      if (message.method === undefined) continue
      for (const reply of answer(message)) await writer.write(reply)
    }
  })()
  return { stream: { readable: toClient.readable, writable: toAgent.writable }, close: () => {} }
}

// pi-acp 0.0.34's `initialize` answer, as it reads in its source on 2026-10-26.
const PI_INITIALIZE = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    sessionCapabilities: { list: {}, delete: {} },
    promptCapabilities: { image: true, embeddedContext: true },
    mcpCapabilities: { http: false, sse: false },
  },
  authMethods: [
    {
      id: 'pi_terminal_login',
      name: 'Launch pi in the terminal',
      description: 'Signs in to pi in a terminal',
      type: 'terminal',
      args: ['--terminal-login'],
    },
  ],
  agentInfo: { name: 'pi-acp', title: 'pi-acp', version: '0.0.34' },
}

const STARTUP_NOTE =
  'pi 0.83.0\nContext files:\n  AGENTS.md\nSkills: none\nExtensions: none\n\nAn update is available: 0.84.0'

// Its `session/new` answer: the startup note in `_meta`, the model, and its levels as legacy modes.
const PI_NEW_SESSION = {
  sessionId: 'pi-session-1',
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'anthropic/claude-sonnet-4-5',
      options: [{ value: 'anthropic/claude-sonnet-4-5', name: 'claude-sonnet-4-5' }],
    },
    {
      id: 'thought_level',
      name: 'Thinking',
      category: 'thought_level',
      type: 'select',
      currentValue: 'high',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ],
    },
  ],
  modes: {
    currentModeId: 'Thinking: high',
    availableModes: [
      { id: 'Thinking: low', name: 'Thinking: low' },
      { id: 'Thinking: high', name: 'Thinking: high' },
    ],
  },
  _meta: { piAcp: { startupInfo: STARTUP_NOTE } },
}

function piAgent(messages: AnyMessage[] = []): AcpTransport {
  return scripted((message) => {
    switch (message.method) {
      case 'initialize':
        return [{ jsonrpc: '2.0', id: message.id!, result: PI_INITIALIZE }]
      case 'session/new':
        return [{ jsonrpc: '2.0', id: message.id!, result: PI_NEW_SESSION }, ...messages]
      case 'session/prompt':
        return [{ jsonrpc: '2.0', id: message.id!, result: { stopReason: 'end_turn' } }]
      default:
        return [{ jsonrpc: '2.0', id: message.id!, result: {} }]
    }
  })
}

function chunk(sessionId: string, text: string): AnyMessage {
  return {
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    },
  }
}

describe('AgentConnection', () => {
  it('drops the buffered updates of a session it unregisters before any target took them', async () => {
    const module = await loadFakeAgent()
    const app = module.createFakeAgent({ env: { FAKE_AGENT_DELAY_SCALE: '0' } })
    const connection = AgentConnection.connect(inProcessTransport(app), {
      traffic: () => {},
      account: () => {},
      ignored: () => {},
      log: () => {},
    })
    await connection.initialize('0.0.0-test')
    const { acpSessionId } = await connection.newSession(os.tmpdir())
    // The agent announces its commands right after it answers, before anyone registers.
    await new Promise((resolve) => setTimeout(resolve, 50))
    connection.unregister(acpSessionId)
    let applied = 0
    connection.register(acpSessionId, {
      context: () => {
        throw new Error('no update should reach the target')
      },
      apply: () => applied++,
      requestPermission: () => Promise.resolve('cancelled'),
    })
    expect(applied).toBe(0)
    connection.close()
  })

  it('drops the startup note recorded pi-acp repeats, and keeps the rest of the session', async () => {
    const ignored: string[] = []
    const connection = AgentConnection.connect(
      piAgent([
        chunk('pi-session-1', STARTUP_NOTE),
        chunk('pi-session-1', 'What would you like to work on?'),
      ]),
      {
        traffic: () => {},
        account: () => {},
        ignored: (_sessionId, what) => ignored.push(what),
        log: () => {},
        startupNote: true,
      },
    )
    await connection.initialize('0.0.0-test')
    const { acpSessionId } = await connection.newSession(os.tmpdir())
    const { target, entries } = threadTarget()
    connection.register(acpSessionId, target)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(ignored).toContain('startup note')
    expect(entries()).toHaveLength(1)
    expect(entries()[0]).toMatchObject({
      kind: 'agent',
      markdown: 'What would you like to work on?',
    })
    connection.close()
  })

  it('keeps the startup note for an agent not marked with it', async () => {
    const connection = AgentConnection.connect(
      piAgent([
        chunk('pi-session-1', STARTUP_NOTE),
        chunk('pi-session-1', 'What would you like to work on?'),
      ]),
      { traffic: () => {}, account: () => {}, ignored: () => {}, log: () => {} },
    )
    await connection.initialize('0.0.0-test')
    const { acpSessionId } = await connection.newSession(os.tmpdir())
    const { target, entries } = threadTarget()
    connection.register(acpSessionId, target)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const agentText = entries()
      .filter((entry) => entry.kind === 'agent')
      .map((entry) => (entry as { markdown: string }).markdown)
      .join('')
    expect(agentText).toContain(STARTUP_NOTE)
    expect(agentText).toContain('What would you like to work on?')
    connection.close()
  })

  it('turns legacy modes into a mode option for an agent not marked levelsAsModes', async () => {
    const connection = AgentConnection.connect(piAgent(), {
      traffic: () => {},
      account: () => {},
      ignored: () => {},
      log: () => {},
    })
    await connection.initialize('0.0.0-test')
    const { config } = await connection.newSession(os.tmpdir())
    expect(config.find((option) => option.category === 'mode')).toMatchObject({
      id: '__mode',
      value: 'Thinking: high',
    })
    connection.close()
  })

  it('ignores the legacy modes for an agent marked levelsAsModes, which sends its levels as an option', async () => {
    const connection = AgentConnection.connect(
      piAgent([
        chunk('pi-session-1', 'Ready'),
        {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'pi-session-1',
            update: { sessionUpdate: 'current_mode_update', currentModeId: 'Thinking: low' },
          },
        },
      ]),
      {
        traffic: () => {},
        account: () => {},
        ignored: () => {},
        log: () => {},
        levelsAsModes: true,
      },
    )
    await connection.initialize('0.0.0-test')
    const { acpSessionId, config } = await connection.newSession(os.tmpdir())
    expect(config.map((option) => option.id)).toEqual(['model', 'thought_level'])
    // A `current_mode_update` finds no mode option and is dropped, so nothing changes.
    const thread = threadTarget()
    connection.register(acpSessionId, thread.target)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(thread.entries()).toHaveLength(1)
    connection.close()
  })

  it('still answers with the session capabilities and the terminal sign-in pi-acp offers', async () => {
    const connection = AgentConnection.connect(piAgent(), {
      traffic: () => {},
      account: () => {},
      ignored: () => {},
      log: () => {},
    })
    const init = await connection.initialize('0.0.0-test')
    expect(init.capabilities).toMatchObject({
      loadSession: true,
      listSessions: true,
      deleteSession: true,
      closeSession: false,
      mcpHttp: false,
    })
    expect(init.authMethods).toEqual([
      {
        id: 'pi_terminal_login',
        name: 'Launch pi in the terminal',
        description: 'Signs in to pi in a terminal',
        type: 'terminal',
        args: ['--terminal-login'],
        env: {},
      },
    ])
    connection.close()
  })
})
