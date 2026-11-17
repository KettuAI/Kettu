// Pi's model scope as Kettu reads it: pi-acp 0.0.34 lists every signed-in model, and Kettu's
// extension writes the models Pi scoped the session to into the file `session/new` names.

import { stat, writeFile } from 'node:fs/promises'
import { agent, methods } from '@agentclientprotocol/sdk/unstable'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyPatches,
  threadFromSnapshot,
  type ConfigOption,
  type ThreadState,
} from '@shared/thread'
import { MODEL_SCOPE_META, type SessionTarget } from '../connection'
import { newTurnScope } from '../session-updates'
import { AcpConnection, inProcessTransport } from './connection'

const MODELS = [
  'deepseek/deepseek-flash',
  'deepseek/deepseek-v4-pro',
  'google/gemini-2.5-flash',
  'google/gemini-2.5-pro',
  'kettutest/test-alpha',
]

// pi-acp's model option, at `current`.
const modelOption = (current: string) => ({
  id: 'model',
  name: 'Model',
  category: 'model' as const,
  type: 'select' as const,
  currentValue: current,
  options: MODELS.map((value) => ({ value, name: value })),
})

const connections: AcpConnection[] = []

// Closing a connection removes its folder of scope files.
afterEach(() => {
  for (const connection of connections.splice(0)) connection.close()
})

/** A pi-acp whose Pi, with Kettu's extension, writes `scope` once the session starts. */
function connect(scope: string[] | null, kettuExtension = true) {
  const files: (string | null)[] = []
  const app = agent({ name: 'pi-acp' })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      agentInfo: { name: 'pi-acp', version: '0.0.34' },
    }))
    .onRequest(methods.agent.session.new, async (ctx) => {
      const file = (ctx.params._meta as Record<string, unknown> | undefined)?.[MODEL_SCOPE_META]
      files.push(typeof file === 'string' ? file : null)
      if (typeof file === 'string' && scope) {
        await writeFile(file, JSON.stringify({ models: scope }))
      }
      return { sessionId: `s-${files.length}`, configOptions: [modelOption(MODELS[0]!)] }
    })
    .onRequest(methods.agent.session.setConfigOption, async (ctx) => {
      const configOptions = [modelOption(String(ctx.params.value))]
      // pi-acp sends the options again after a model change.
      await ctx.client.notify(methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: 'config_option_update', configOptions },
      })
      return { configOptions }
    })
  const connection = AcpConnection.connect(inProcessTransport(app), {
    traffic: () => {},
    account: () => {},
    ignored: () => {},
    log: () => {},
    agentId: 'pi',
    name: 'Pi',
    kettuExtension,
  })
  connections.push(connection)
  return { connection, files }
}

/** A session's thread that takes the updates the connection maps. */
function threadTarget() {
  let thread: ThreadState = threadFromSnapshot({
    session: {
      id: 's',
      agentId: 'pi',
      projectPath: '/tmp/pi-probe',
      acpSessionId: 's-1',
      status: 'ready',
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
    requestPermission: async () => ({ optionId: 'allow' }),
    send: () => {},
    startMode: () => null,
  }
  return { target, config: () => thread.session.config }
}

const models = (config: readonly ConfigOption[]) =>
  config.find((option) => option.category === 'model')?.choices?.map((choice) => choice.value)

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  )

describe("Pi's model scope", () => {
  it('lists only the scoped models, keeping the current one, and removes the file', async () => {
    const { connection, files } = connect(['kettutest/test-alpha', 'google/gemini-2.5-pro'])
    await connection.initialize('1.0.0')
    const { config } = await connection.newSession('/tmp/pi-probe')
    expect(models(config)).toEqual([
      'deepseek/deepseek-flash',
      'google/gemini-2.5-pro',
      'kettutest/test-alpha',
    ])
    expect(files[0]).toEqual(expect.any(String))
    expect(await exists(files[0]!)).toBe(false)
  })

  it('keeps the scope in the answer to a change and in the options sent after it', async () => {
    const { connection } = connect(['kettutest/test-alpha', 'google/gemini-2.5-pro'])
    await connection.initialize('1.0.0')
    const { sessionId } = await connection.newSession('/tmp/pi-probe')
    const thread = threadTarget()
    connection.register(sessionId, thread.target)
    const answer = await connection.setConfigOption(sessionId, 'model', 'kettutest/test-alpha')
    expect(models(answer)).toEqual(['google/gemini-2.5-pro', 'kettutest/test-alpha'])
    expect(models(thread.config())).toEqual(['google/gemini-2.5-pro', 'kettutest/test-alpha'])
  })

  it('lists every model when Pi has no scope or wrote none', async () => {
    for (const scope of [[], null]) {
      const { connection, files } = connect(scope)
      await connection.initialize('1.0.0')
      const { config } = await connection.newSession('/tmp/pi-probe')
      expect(models(config)).toEqual(MODELS)
      expect(await exists(files[0]!)).toBe(false)
    }
  })

  it('names no file to an agent without the extension', async () => {
    const { connection, files } = connect(['kettutest/test-alpha'], false)
    await connection.initialize('1.0.0')
    const { config } = await connection.newSession('/tmp/pi-probe')
    expect(files).toEqual([null])
    expect(models(config)).toEqual(MODELS)
  })
})
