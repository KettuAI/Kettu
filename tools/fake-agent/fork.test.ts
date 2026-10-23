import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { client, methods, type AnyMessage } from '@agentclientprotocol/sdk/unstable'
import { expect, it } from 'vitest'
import { createFakeAgent } from './agent.ts'

it('forks at an unknown message by its fingerprint and occurrence, as the adapters fall back', async () => {
  const toAgent = new TransformStream<AnyMessage, AnyMessage>()
  const toClient = new TransformStream<AnyMessage, AnyMessage>()
  createFakeAgent({ env: { FAKE_AGENT_DELAY_SCALE: '0' }, log: () => {} }).connect({
    readable: toAgent.readable,
    writable: toClient.writable,
  })
  const said = new Map<string, string>()
  const { agent } = client({ name: 'test' })
    .onNotification(methods.client.session.update, (ctx) => {
      const { update } = ctx.params
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        const key = `${ctx.params.sessionId} ${update.messageId ?? ''}`
        said.set(key, (said.get(key) ?? '') + update.content.text)
      }
    })
    .connect({ readable: toClient.readable, writable: toAgent.writable })
  await agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })
  const cwd = tmpdir()
  const { sessionId } = await agent.request(methods.agent.session.new, { cwd, mcpServers: [] })
  const prompt = (id: string, text: string) =>
    agent.request(methods.agent.session.prompt, { sessionId: id, prompt: [{ type: 'text', text }] })
  await prompt(sessionId, 'First question')
  await prompt(sessionId, 'Second question')
  // Each reply ends with the same message, so the first reply's last one occurs twice.
  const texts = [...said].filter(([key]) => key.startsWith(sessionId)).map(([, text]) => text)
  const firstEnd = texts[texts.length / 2 - 1]
  expect(firstEnd).toBe(texts.at(-1))
  const fork = (messageFingerprint: string) =>
    agent.request(methods.agent.session.fork, {
      sessionId,
      cwd,
      mcpServers: [],
      _meta: {
        jetbrains: {
          air: {
            fork: { version: 1, messageId: 'unknown', messageFingerprint, messageOccurrence: 1 },
          },
        },
      },
    })

  const fingerprint = `sha256:${createHash('sha256').update(firstEnd!, 'utf8').digest('hex')}`
  const forked = await fork(fingerprint)
  await prompt(forked.sessionId, '/recall')
  expect([...said].find(([key]) => key.startsWith(forked.sessionId))?.[1]).toBe(
    'Your last message was: First question',
  )
  await expect(fork(`sha256:${'0'.repeat(64)}`)).rejects.toThrow(/not found/)
})
