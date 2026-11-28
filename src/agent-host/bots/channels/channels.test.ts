// Unit tests for plugin-driven Bot channels: BotChannelManager shared pairing, @handle / /handle /
// scope / default-Bot routing, 24h deduplication, plugin lifecycle, network.custom origin locking
// and PluginWebSockets binary/text framing.

import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { DEFAULT_BOT_LIMITS, type Bot, type BotChannelView } from '@shared/bots'
import { botChannelKey, PLUGIN_BOT_CHANNEL_EVENTS } from '@shared/plugin-bot-channels'
import type { InstalledBotChannel } from '../../plugins/service'
import { networkFetch } from '../../plugin-runtime/network'
import { PluginWebSockets } from '../../plugin-runtime/ws'
import { BotChannelManager, type BotChannelPluginTransport } from './manager'
import type { ChannelInboundMessage } from './types'

function makeBot(id: string, handle: string, overrides: Partial<Bot> = {}): Bot {
  return {
    id,
    name: handle.toUpperCase(),
    handle,
    description: '',
    avatar: { kind: 'preset', preset: 'architect', palette: 'fox' },
    agentId: 'fake-agent',
    model: null,
    effort: null,
    targets: [],
    scope: { level: 'commands', web: true },
    limits: { ...DEFAULT_BOT_LIMITS },
    paused: false,
    mainSessionId: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function makeInstalledChannel(
  pluginId: string,
  channelId: string,
  overrides: Partial<InstalledBotChannel> = {},
): InstalledBotChannel {
  return {
    channelKey: botChannelKey(pluginId, channelId),
    pluginId,
    pluginName: `${channelId}-bot`,
    pluginTitle: `${channelId.toUpperCase()} Bot`,
    pluginIcon: null,
    channel: {
      id: channelId,
      title: { en: `${channelId.toUpperCase()} Channel` },
      shortLabel: channelId.slice(0, 2).toUpperCase(),
      capabilities: { direct: true, group: true, pairing: true, replyModes: ['summary', 'full'] },
      howToAsk: '@{{handle}} ...',
    },
    permissions: ['bots.bridge'],
    missingRequiredSettings: [],
    ...overrides,
  }
}

describe('Plugin-driven BotChannelManager', () => {
  let tmpDir = ''
  let installed: InstalledBotChannel[] = []
  let bots: Bot[] = []
  let deliveredEvents: { pluginId: string; trigger: string; event: string; payload: unknown }[] = []
  let inboundMessages: ChannelInboundMessage[] = []
  let broadcasts: BotChannelView[][] = []
  let manager: BotChannelManager

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kettu-plugin-channels-'))
    const tg = makeInstalledChannel('p111111111111', 'telegram')
    const gh = makeInstalledChannel('p222222222222', 'github', {
      channel: {
        id: 'github',
        title: { en: 'GitHub' },
        shortLabel: 'GH',
        capabilities: {
          direct: false,
          group: false,
          pairing: false,
          scopes: true,
          replyModes: ['review_first', 'auto', 'kettu_only'],
        },
        howToAsk: '@kettu-bots {{handle}} ...',
      },
    })
    installed = [tg, gh]
    bots = [
      makeBot('bot-dev', 'dev', {
        channels: {
          [tg.channelKey]: { enabled: true, replyMode: 'summary' },
          [gh.channelKey]: { enabled: true, replyMode: 'review_first', scope: ['KettuAI/Kettu'] },
        },
      }),
      makeBot('bot-rev', 'reviewer', {
        channels: {
          [tg.channelKey]: { enabled: true, replyMode: 'full' },
          [gh.channelKey]: { enabled: true, replyMode: 'auto' },
        },
      }),
    ]
    deliveredEvents = []
    inboundMessages = []
    broadcasts = []

    const transport: BotChannelPluginTransport = {
      installedChannels: () => installed,
      deliver: async (pluginId, trigger, event, payload) => {
        deliveredEvents.push({ pluginId, trigger, event, payload })
      },
      hook: async () => [{ ok: true, label: '@demo_bot' }],
    }

    manager = new BotChannelManager({
      userDataPath: tmpDir,
      locale: () => 'en',
      bots: () => bots,
      botById: (id) => bots.find((b) => b.id === id),
      plugins: transport,
      onAuthorizedMessage: async (msg) => {
        inboundMessages.push(msg)
        return { accepted: true, reply: 'Queued' }
      },
      onStatusCommand: (botId) => `status:${botId}`,
      onStopCommand: async (botId) => `stopped:${botId}`,
      onChannelsChanged: (list) => broadcasts.push(list),
      log: () => {},
    })
    await manager.load()
  })

  afterEach(async () => {
    await manager.dispose()
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
  })

  it('starts and stops plugin channels based on shared config and required settings', async () => {
    const key = botChannelKey('p111111111111', 'telegram')
    expect(deliveredEvents).toHaveLength(0)

    await manager.configureChannel(key, { enabled: true, defaultBotId: 'bot-dev' })
    expect(
      deliveredEvents.some(
        (e) => e.pluginId === 'p111111111111' && e.event === PLUGIN_BOT_CHANNEL_EVENTS.start,
      ),
    ).toBe(true)

    await manager.configureChannel(key, { enabled: false })
    expect(
      deliveredEvents.some(
        (e) => e.pluginId === 'p111111111111' && e.event === PLUGIN_BOT_CHANNEL_EVENTS.stop,
      ),
    ).toBe(true)
  })

  it('enforces shared /pair binding across all Bots and routes by @handle, /handle or defaultBotId', async () => {
    const key = botChannelKey('p111111111111', 'telegram')
    await manager.configureChannel(key, { enabled: true, defaultBotId: 'bot-dev' })

    // Unpaired owner is rejected.
    const rejected = await manager.handlePluginInbound('p111111111111', {
      channel: 'telegram',
      dedupId: 'msg-1',
      chatId: 'chat-1',
      senderId: 'user-42',
      senderLabel: 'Alice',
      isDirect: true,
      text: 'Hello',
    })
    expect(rejected.accepted).toBe(false)
    expect(inboundMessages).toHaveLength(0)

    // Pair once on the channel -> shared by both dev and reviewer Bots.
    const pair = manager.startPairing(key)
    const paired = await manager.handlePluginInbound('p111111111111', {
      channel: 'telegram',
      dedupId: 'msg-2',
      chatId: 'chat-1',
      senderId: 'user-42',
      senderLabel: 'Alice',
      isDirect: true,
      text: `/pair ${pair.code}`,
    })
    expect(paired).toEqual({ accepted: true, action: 'paired' })

    // Explicit @reviewer routes to reviewer with prefix stripped.
    const toReviewer = await manager.handlePluginInbound('p111111111111', {
      channel: 'telegram',
      dedupId: 'msg-3',
      chatId: 'chat-1',
      senderId: 'user-42',
      senderLabel: 'Alice',
      isDirect: true,
      text: '@reviewer check PR #12',
    })
    expect(toReviewer).toEqual({ accepted: true, action: 'routed', botId: 'bot-rev' })
    expect(inboundMessages[0]?.botId).toBe('bot-rev')
    expect(inboundMessages[0]?.text).toBe('check PR #12')

    // Slash prefix `/reviewer` also routes cleanly.
    const slashToReviewer = await manager.handlePluginInbound('p111111111111', {
      channel: 'telegram',
      dedupId: 'msg-4',
      chatId: 'chat-1',
      senderId: 'user-42',
      senderLabel: 'Alice',
      isDirect: true,
      text: '/reviewer audit auth.ts',
    })
    expect(slashToReviewer).toEqual({ accepted: true, action: 'routed', botId: 'bot-rev' })

    // Plain message without handle falls back to defaultBotId (bot-dev).
    const toDefault = await manager.handlePluginInbound('p111111111111', {
      channel: 'telegram',
      dedupId: 'msg-5',
      chatId: 'chat-1',
      senderId: 'user-42',
      senderLabel: 'Alice',
      isDirect: true,
      text: 'Summarize today work',
    })
    expect(toDefault).toEqual({ accepted: true, action: 'routed', botId: 'bot-dev' })

    // Duplicate dedupId is ignored idempotently.
    const dup = await manager.handlePluginInbound('p111111111111', {
      channel: 'telegram',
      dedupId: 'msg-5',
      chatId: 'chat-1',
      senderId: 'user-42',
      senderLabel: 'Alice',
      isDirect: true,
      text: 'Summarize today work',
    })
    expect(dup.action).toBe('deduped')
    expect(inboundMessages).toHaveLength(3)
  })

  it('routes non-pairing webhook channels by explicit handle or scope and invokes test hook', async () => {
    const ghKey = botChannelKey('p222222222222', 'github')
    await manager.configureChannel(ghKey, { enabled: true })

    const res = await manager.handlePluginInbound('p222222222222', {
      channel: 'github',
      dedupId: 'del-99',
      chatId: 'KettuAI/Kettu',
      threadId: '42',
      deliveryId: 'del-99',
      senderId: 'gh-1',
      senderLabel: 'octocat',
      isDirect: false,
      scope: 'KettuAI/Kettu',
      text: 'Please review the diff',
    })
    expect(res).toEqual({ accepted: true, action: 'routed', botId: 'bot-dev' })
    expect(inboundMessages[0]?.channelShortLabel).toBe('GH')

    const testRes = await manager.testChannel(ghKey)
    expect(testRes).toEqual({ ok: true, label: '@demo_bot' })
  })
})

describe('Plugin network.custom origin lock & PluginWebSockets', () => {
  it('allows network.custom only for explicitly configured URL origins and rejects other internal hosts', async () => {
    const customCalls: string[] = []
    const fetchCall = networkFetch(async () => ({ status: 200, headers: {}, body: 'public' }), {
      customOrigins: (id) => (id === 'p1' ? ['http://127.0.0.1:8787'] : []),
      customTransport: async (req) => {
        customCalls.push(req.url.toString())
        return { status: 200, headers: {}, body: 'custom-ok' }
      },
    })

    const ok = await fetchCall.run({ pluginId: 'p1', permissions: ['network.custom'] }, [
      'http://127.0.0.1:8787/hook',
      { timeoutMs: 35_000 },
    ])
    expect(ok).toEqual({ status: 200, headers: {}, body: 'custom-ok' })
    expect(customCalls).toEqual(['http://127.0.0.1:8787/hook'])

    // Any other loopback or private origin not in the user's URL setting is rejected.
    await expect(
      fetchCall.run({ pluginId: 'p1', permissions: ['network.custom'] }, [
        'http://127.0.0.1:9999/secret',
      ]),
    ).rejects.toThrow(/https/i)
  })

  it('bridges text and base64 binary frames over host-managed WebSockets and cleans up on closeAll', () => {
    const events: { pluginId: string; event: string; payload: unknown }[] = []
    class FakeSocket extends EventEmitter {
      readyState: number = WebSocket.OPEN
      sent: (string | Buffer)[] = []
      send(data: string | Buffer) {
        this.sent.push(data)
      }
      close(code = 1000, reason = '') {
        this.readyState = WebSocket.CLOSED
        this.emit('close', code, Buffer.from(reason))
      }
      terminate() {
        this.readyState = WebSocket.CLOSED
      }
    }
    const created: FakeSocket[] = []
    const sockets = new PluginWebSockets({
      deliver: (pluginId, event, payload) => events.push({ pluginId, event, payload }),
      customOrigins: () => ['http://127.0.0.1:8787'],
      createSocket: () => {
        const s = new FakeSocket()
        created.push(s)
        return s as unknown as WebSocket
      },
    })

    const { id } = sockets.open('p1', ['network.custom'], { url: 'ws://127.0.0.1:8787/ws' })
    created[0]!.emit('open')
    created[0]!.emit('message', Buffer.from([1, 2, 3]), true)
    sockets.send('p1', { id, data: Buffer.from([4, 5]).toString('base64'), encoding: 'base64' })

    expect(events[0]).toEqual({ pluginId: 'p1', event: 'network.ws.open', payload: { id } })
    expect(events[1]).toEqual({
      pluginId: 'p1',
      event: 'network.ws.message',
      payload: { id, data: Buffer.from([1, 2, 3]).toString('base64'), encoding: 'base64' },
    })
    expect(Buffer.isBuffer(created[0]!.sent[0])).toBe(true)

    sockets.closeAll('p1')
    expect(() => sockets.send('p1', { id, data: 'hi' })).toThrow(/Unknown WebSocket/)
  })
})
