import { tmpdir } from 'node:os'
import { client, methods, type AnyMessage } from '@agentclientprotocol/sdk/unstable'
import { expect, it } from 'vitest'
import { createFakeAgent } from './agent.ts'

/** A fresh agent process, as after the app or the daemon restarts, and the tool calls it sends. */
async function start() {
  const toAgent = new TransformStream<AnyMessage, AnyMessage>()
  const toClient = new TransformStream<AnyMessage, AnyMessage>()
  createFakeAgent({ env: { FAKE_AGENT_DELAY_SCALE: '0' }, log: () => {} }).connect({
    readable: toAgent.readable,
    writable: toClient.writable,
  })
  const toolCalls: string[] = []
  const { agent } = client({ name: 'test' })
    .onNotification(methods.client.session.update, (ctx) => {
      const { update } = ctx.params
      if (update.sessionUpdate === 'tool_call') toolCalls.push(update.toolCallId)
    })
    .connect({ readable: toClient.readable, writable: toAgent.writable })
  await agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })
  const prompt = (sessionId: string, text: string) =>
    agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] })
  return { agent, toolCalls, prompt }
}

it('names no tool call twice in a session another process resumes', async () => {
  const cwd = tmpdir()
  const first = await start()
  const { sessionId } = await first.agent.request(methods.agent.session.new, {
    cwd,
    mcpServers: [],
  })
  await first.prompt(sessionId, '/tool-storm --count 3')

  const second = await start()
  await second.agent.request(methods.agent.session.resume, { sessionId, cwd, mcpServers: [] })
  await second.prompt(sessionId, '/tool-storm --count 3')

  expect(first.toolCalls).toHaveLength(3)
  expect(second.toolCalls).toHaveLength(3)
  expect(second.toolCalls.filter((id) => first.toolCalls.includes(id))).toEqual([])
})
