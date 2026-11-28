// Pure plugin-driven external channel orchestrator for Kettu Bots.
// Every external platform (Telegram, Feishu/Lark, GitHub, self-hosted bridges, etc.) is supplied
// by an installed Kettu plugin declaring `botChannels` and holding the `bots.bridge` permission.
// Credentials live inside each plugin's own settings/keychain. This manager owns shared channel
// routing (by `@handle` / `/handle`, scope, or default Bot), 6-digit `/pair` owner binding,
// 24h idempotent deduplication, plugin start/stop lifecycle, outbound reply dispatch and alerts.

import { randomInt } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  DEFAULT_BOT_CHANNEL_CONFIG,
  normalizeBotChannelConfig,
  type Bot,
  type BotChannelConfig,
  type BotChannelConnectionState,
  type BotChannelView,
  type BotPairingCode,
  type BotRequest,
} from '@shared/bots'
import {
  botChannelKey,
  botChannelTrigger,
  PLUGIN_BOT_CHANNEL_EVENTS,
  type BotChannelReplyMode,
} from '@shared/plugin-bot-channels'
import { pluginText } from '@shared/plugins'
import type { InstalledBotChannel } from '../../plugins/service'
import { writeFileAtomic, type LogFn } from '../../storage'
import {
  parseChannelCommand,
  parseExternalHandleMention,
  type ChannelInboundMessage,
  type ChannelReplyPayload,
  type ChannelReplyTarget,
} from './types'

const PAIRING_TTL_MS = 5 * 60_000
const DEDUP_TTL_MS = 24 * 60 * 60_000
const VALID_STATES = new Set<BotChannelConnectionState>([
  'off',
  'connecting',
  'connected',
  'reconnecting',
  'error',
])

interface RuntimeState {
  state: BotChannelConnectionState
  detail: string | null
  connectedAt: number | null
}

interface PersistedChannelStore {
  version: 2
  configs: Record<string, BotChannelConfig>
  dedup: Record<string, number>
  /** Remembered owner DM chats (keyed by channelKey) so Routine failure alerts can reach the owner. */
  ownerDmChats: Record<string, { channelKey: string; chatId: string }>
}

export interface BotChannelPluginTransport {
  /** Lists all enabled plugin-declared Bot channels. */
  installedChannels(): InstalledBotChannel[]
  /** Activates a plugin (if needed) and delivers a fire-and-forget event. */
  deliver(pluginId: string, trigger: string, event: string, payload: unknown): Promise<void>
  /** Activates a plugin (if needed) and invokes a hook returning listener answers. */
  hook(pluginId: string, trigger: string, event: string, payload: unknown): Promise<unknown[]>
}

export interface BotChannelManagerDeps {
  userDataPath: string
  locale: () => string
  bots: () => readonly Bot[]
  botById: (botId: string) => Bot | undefined
  plugins: BotChannelPluginTransport
  /** Handles an authorized inbound DM (main chat) or isolated external thread message. */
  onAuthorizedMessage: (
    message: ChannelInboundMessage,
  ) => Promise<{ accepted: boolean; reply?: string; reason?: string }>
  /** Returns a concise live status string for `/status`. */
  onStatusCommand: (botId: string) => string
  /** Stops running work on this thread/Bot for `/stop`. */
  onStopCommand: (botId: string, threadId: string | null) => Promise<string>
  onChannelsChanged: (channels: BotChannelView[]) => void
  log: LogFn
  now?: () => number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function defaultShortLabel(decl: InstalledBotChannel): string {
  if (decl.channel.shortLabel) return decl.channel.shortLabel
  const clean = decl.channel.id.replace(/[^a-z0-9]/gi, '').toUpperCase()
  return clean.slice(0, 4) || 'CH'
}

function defaultHowToAsk(decl: InstalledBotChannel): string {
  return decl.channel.howToAsk ?? '@{{handle}} ...'
}

function defaultReplyMode(decl: InstalledBotChannel): BotChannelReplyMode {
  return decl.channel.capabilities?.replyModes?.[0] ?? 'summary'
}

function botAllowsChannel(bot: Bot, channelKey: string, defaultBotId: string | null): boolean {
  if (bot.paused) return false
  const binding = bot.channels?.[channelKey]
  if (binding) return binding.enabled
  // The channel's explicit default Bot accepts traffic unless explicitly turned off.
  return defaultBotId === bot.id
}

export class BotChannelManager {
  private readonly metaFile: string
  private readonly configs = new Map<string, BotChannelConfig>()
  private readonly runtimeStates = new Map<string, RuntimeState>()
  private readonly runningKeys = new Set<string>()
  private readonly pairingCodes = new Map<string, BotPairingCode>()
  private readonly dedup = new Map<string, number>()
  private readonly ownerDmChats = new Map<string, { channelKey: string; chatId: string }>()
  private readonly now: () => number
  private disposed = false

  constructor(private readonly deps: BotChannelManagerDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.metaFile = path.join(deps.userDataPath, 'state', 'bots-channels.json')
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.metaFile, 'utf8')
      const parsed = JSON.parse(text) as Partial<PersistedChannelStore>
      if (parsed.version === 2 && isRecord(parsed.configs)) {
        for (const [key, raw] of Object.entries(parsed.configs)) {
          this.configs.set(key, normalizeBotChannelConfig(raw))
        }
      }
      const cutoff = this.now() - DEDUP_TTL_MS
      if (isRecord(parsed.dedup)) {
        for (const [k, ts] of Object.entries(parsed.dedup)) {
          if (typeof ts === 'number' && ts >= cutoff) this.dedup.set(k, ts)
        }
      }
      if (isRecord(parsed.ownerDmChats)) {
        for (const [key, entry] of Object.entries(parsed.ownerDmChats)) {
          if (
            isRecord(entry) &&
            typeof entry.channelKey === 'string' &&
            typeof entry.chatId === 'string'
          ) {
            this.ownerDmChats.set(key, { channelKey: entry.channelKey, chatId: entry.chatId })
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.deps.log('warn', `Could not read bot channel config: ${(error as Error).message}`)
      }
    }
    await this.syncAll()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const installed = new Map(
      this.deps.plugins.installedChannels().map((item) => [item.channelKey, item]),
    )
    for (const key of [...this.runningKeys]) {
      this.runningKeys.delete(key)
      const item = installed.get(key)
      if (!item) continue
      await this.deps.plugins
        .deliver(
          item.pluginId,
          botChannelTrigger(item.channel.id),
          PLUGIN_BOT_CHANNEL_EVENTS.stop,
          { channel: item.channel.id },
        )
        .catch(() => {})
    }
  }

  /** Lists all installed Bot channel plugins together with shared config and live status. */
  listChannels(): BotChannelView[] {
    return this.deps.plugins.installedChannels().map((item) => this.buildView(item))
  }

  /** Updates shared host-level config for an installed channel plugin, then reconciles runtime. */
  async configureChannel(
    channelKey: string,
    patch: Partial<BotChannelConfig>,
  ): Promise<BotChannelView> {
    const installed = this.findInstalled(channelKey)
    if (!installed) throw new Error(`Bot channel "${channelKey}" is not installed or enabled.`)
    const prev = this.configOf(channelKey)
    const next = normalizeBotChannelConfig({
      ...prev,
      ...patch,
      ownerIds: patch.ownerIds ?? prev.ownerIds,
      allowedChatIds: patch.allowedChatIds ?? prev.allowedChatIds,
    })
    if (next.defaultBotId && !this.deps.botById(next.defaultBotId)) {
      next.defaultBotId = null
    }
    this.configs.set(channelKey, next)
    await this.persist()
    await this.syncAll()
    this.emitChanged()
    return this.buildView(installed)
  }

  /** Generates a 5-minute 6-digit `/pair <code>` token shared across all Bots on this channel. */
  startPairing(channelKey: string): BotPairingCode {
    const installed = this.findInstalled(channelKey)
    if (!installed) throw new Error(`Bot channel "${channelKey}" is not installed or enabled.`)
    const code = String(randomInt(100_000, 1_000_000))
    const pair: BotPairingCode = { code, expiresAt: this.now() + PAIRING_TTL_MS }
    this.pairingCodes.set(channelKey, pair)
    this.emitChanged()
    return pair
  }

  /** Invokes the channel plugin's `botChannel.test` hook to verify its configured settings. */
  async testChannel(channelKey: string): Promise<{ ok: boolean; label?: string; error?: string }> {
    const installed = this.findInstalled(channelKey)
    if (!installed) {
      return { ok: false, error: 'Channel plugin is not installed or enabled.' }
    }
    if (installed.missingRequiredSettings.length > 0) {
      return {
        ok: false,
        error: `Missing required plugin settings: ${installed.missingRequiredSettings.join(', ')}`,
      }
    }
    try {
      const answers = await this.deps.plugins.hook(
        installed.pluginId,
        botChannelTrigger(installed.channel.id),
        PLUGIN_BOT_CHANNEL_EVENTS.test,
        { channel: installed.channel.id },
      )
      const first = answers.find(isRecord)
      if (!first) {
        return { ok: false, error: 'The plugin did not return a test result.' }
      }
      return {
        ok: first.ok === true,
        ...(typeof first.label === 'string' ? { label: first.label } : {}),
        ...(typeof first.error === 'string' ? { error: first.error } : {}),
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Reconciles running channel plugins against installed plugins, shared configs, and active Bots. */
  async syncAll(): Promise<void> {
    if (this.disposed) return
    const installedList = this.deps.plugins.installedChannels()
    const installedMap = new Map(installedList.map((item) => [item.channelKey, item]))
    const bots = this.deps.bots()

    // Drop state for uninstalled/disabled plugins.
    for (const key of [...this.runningKeys]) {
      if (!installedMap.has(key)) {
        this.runningKeys.delete(key)
        this.runtimeStates.delete(key)
      }
    }

    for (const item of installedList) {
      const cfg = this.configOf(item.channelKey)
      // Clean stale defaultBotId if the Bot was deleted.
      if (cfg.defaultBotId && !bots.some((b) => b.id === cfg.defaultBotId)) {
        cfg.defaultBotId = null
        this.configs.set(item.channelKey, cfg)
      }
      const hasReadyBot = bots.some((b) => botAllowsChannel(b, item.channelKey, cfg.defaultBotId))
      const shouldRun = cfg.enabled && item.missingRequiredSettings.length === 0 && hasReadyBot

      if (shouldRun && !this.runningKeys.has(item.channelKey)) {
        this.runningKeys.add(item.channelKey)
        this.runtimeStates.set(item.channelKey, {
          state: 'connecting',
          detail: null,
          connectedAt: null,
        })
        try {
          await this.deps.plugins.deliver(
            item.pluginId,
            botChannelTrigger(item.channel.id),
            PLUGIN_BOT_CHANNEL_EVENTS.start,
            { channel: item.channel.id },
          )
        } catch (error) {
          this.runningKeys.delete(item.channelKey)
          this.runtimeStates.set(item.channelKey, {
            state: 'error',
            detail: error instanceof Error ? error.message : String(error),
            connectedAt: null,
          })
        }
      } else if (!shouldRun && this.runningKeys.has(item.channelKey)) {
        this.runningKeys.delete(item.channelKey)
        this.runtimeStates.set(item.channelKey, {
          state: 'off',
          detail: null,
          connectedAt: null,
        })
        await this.deps.plugins
          .deliver(
            item.pluginId,
            botChannelTrigger(item.channel.id),
            PLUGIN_BOT_CHANNEL_EVENTS.stop,
            { channel: item.channel.id },
          )
          .catch(() => {})
      } else if (!shouldRun) {
        const cur = this.runtimeStates.get(item.channelKey)
        if (cur && cur.state !== 'off') {
          this.runtimeStates.set(item.channelKey, {
            state: 'off',
            detail: null,
            connectedAt: null,
          })
        }
      }
    }

    this.emitChanged()
  }

  /** Removes references to a deleted Bot (such as defaultBotId) and reconciles running plugins. */
  async removeBot(botId: string): Promise<void> {
    let changed = false
    for (const [key, cfg] of this.configs.entries()) {
      if (cfg.defaultBotId === botId) {
        this.configs.set(key, { ...cfg, defaultBotId: null })
        changed = true
      }
    }
    if (changed) await this.persist()
    await this.syncAll()
  }

  /** Delivers an outbound reply back to the originating channel plugin. */
  async sendReply(target: ChannelReplyTarget, payload: ChannelReplyPayload): Promise<boolean> {
    const installed = this.findInstalled(target.channelKey)
    if (!installed) return false
    const bot = this.deps.botById(target.botId)
    const replyMode =
      target.replyMode ??
      bot?.channels?.[target.channelKey]?.replyMode ??
      defaultReplyMode(installed)
    try {
      await this.deps.plugins.deliver(
        installed.pluginId,
        botChannelTrigger(installed.channel.id),
        PLUGIN_BOT_CHANNEL_EVENTS.reply,
        {
          channel: installed.channel.id,
          botId: target.botId,
          botName: bot?.name ?? 'Bot',
          botHandle: bot?.handle ?? 'bot',
          chatId: target.chatId,
          threadId: target.threadId ?? null,
          messageId: target.messageId ?? null,
          deliveryId: target.deliveryId ?? null,
          replyMode,
          payload,
        },
      )
      return true
    } catch (error) {
      this.deps.log(
        'warn',
        `Failed to deliver reply to ${target.channelKey}: ${(error as Error).message}`,
      )
      return false
    }
  }

  /** Notifies the originating external channel that an operation awaits approval in Kettu. */
  async notifyWaitingApproval(req: BotRequest): Promise<void> {
    const src = req.source
    if (src.kind !== 'channel' || !src.channelKey || !src.chatId) return
    await this.sendReply(
      {
        botId: req.botId,
        channelKey: src.channelKey,
        chatId: src.chatId,
        threadId: src.threadId ?? null,
        messageId: src.messageId ?? null,
        deliveryId: src.deliveryId ?? null,
      },
      {
        title: `Waiting for approval · ${req.projectName}`,
        body:
          'An action requires your approval in Kettu (Desktop or Mobile). ' +
          'Open Kettu to review and confirm.',
        status: 'waiting_user',
      },
    )
  }

  /** Sends a proactive Routine failure alert to the most recent paired owner DM channel. */
  async notifyOwnerAlert(botId: string, title: string, body: string): Promise<boolean> {
    const bot = this.deps.botById(botId)
    if (!bot || bot.paused) return false
    for (const item of this.deps.plugins.installedChannels()) {
      const cfg = this.configOf(item.channelKey)
      if (!cfg.enabled || !botAllowsChannel(bot, item.channelKey, cfg.defaultBotId)) continue
      const dm = this.ownerDmChats.get(item.channelKey)
      if (!dm) continue
      const ok = await this.sendReply(
        { botId, channelKey: item.channelKey, chatId: dm.chatId },
        { title, body, status: 'failed' },
      )
      if (ok) return true
    }
    return false
  }

  // ---------------------------------------------------------------------------
  // Plugin API bridge handlers (`bots.list`, `bots.channelStatus`, `bots.inbound`)
  // ---------------------------------------------------------------------------

  handlePluginList(
    pluginId: string,
    rawOptions: unknown,
  ): {
    bots: {
      id: string
      handle: string
      name: string
      paused: boolean
      isDefault: boolean
      replyMode: BotChannelReplyMode | null
      scope: string[]
    }[]
    defaultBotId: string | null
  } {
    const channelId = this.requireChannelId(pluginId, rawOptions)
    const key = botChannelKey(pluginId, channelId)
    const cfg = this.configOf(key)
    const bots = this.deps
      .bots()
      .filter((b) => botAllowsChannel(b, key, cfg.defaultBotId))
      .map((b) => {
        const binding = b.channels?.[key]
        return {
          id: b.id,
          handle: b.handle,
          name: b.name,
          paused: b.paused,
          isDefault: cfg.defaultBotId === b.id,
          replyMode: binding?.replyMode ?? null,
          scope: binding?.scope ?? [],
        }
      })
    return { bots, defaultBotId: cfg.defaultBotId }
  }

  handlePluginStatus(pluginId: string, rawOptions: unknown): null {
    const channelId = this.requireChannelId(pluginId, rawOptions)
    const o = rawOptions as Record<string, unknown>
    const state = o.state as BotChannelConnectionState
    if (!VALID_STATES.has(state)) {
      throw new Error('state must be off, connecting, connected, reconnecting or error')
    }
    const detail =
      o.detail === undefined || o.detail === null
        ? null
        : typeof o.detail === 'string'
          ? o.detail.slice(0, 200)
          : null
    const key = botChannelKey(pluginId, channelId)
    const prev = this.runtimeStates.get(key)
    this.runtimeStates.set(key, {
      state,
      detail,
      connectedAt:
        state === 'connected' ? (prev?.connectedAt ?? this.now()) : (prev?.connectedAt ?? null),
    })
    this.emitChanged()
    return null
  }

  async handlePluginInbound(
    pluginId: string,
    rawMessage: unknown,
  ): Promise<{
    accepted: boolean
    action: 'routed' | 'paired' | 'command' | 'ignored' | 'deduped'
    botId?: string
    reason?: string
  }> {
    if (!isRecord(rawMessage)) throw new Error('Inbound message must be an object')
    const channelId = this.requireChannelId(pluginId, rawMessage)
    const key = botChannelKey(pluginId, channelId)
    const installed = this.findInstalled(key)
    if (!installed) {
      return { accepted: false, action: 'ignored', reason: 'Channel is not active' }
    }
    const cfg = this.configOf(key)
    if (!cfg.enabled) {
      return { accepted: false, action: 'ignored', reason: 'Channel is turned off' }
    }

    const dedupId = this.requireString(rawMessage, 'dedupId', 200)
    const chatId = this.requireString(rawMessage, 'chatId', 200)
    const senderId = this.requireString(rawMessage, 'senderId', 200)
    const senderLabel = this.requireString(rawMessage, 'senderLabel', 120)
    const text = typeof rawMessage.text === 'string' ? rawMessage.text.slice(0, 16_000) : ''
    const isDirect = rawMessage.isDirect === true
    const threadId =
      typeof rawMessage.threadId === 'string' && rawMessage.threadId.trim()
        ? rawMessage.threadId.trim().slice(0, 200)
        : null
    const messageId =
      typeof rawMessage.messageId === 'string' && rawMessage.messageId.trim()
        ? rawMessage.messageId.trim().slice(0, 200)
        : null
    const deliveryId =
      typeof rawMessage.deliveryId === 'string' && rawMessage.deliveryId.trim()
        ? rawMessage.deliveryId.trim().slice(0, 200)
        : null
    const externalUrl =
      typeof rawMessage.externalUrl === 'string' && rawMessage.externalUrl.trim()
        ? rawMessage.externalUrl.trim().slice(0, 500)
        : null
    const explicitHandle =
      typeof rawMessage.botHandle === 'string' && rawMessage.botHandle.trim()
        ? rawMessage.botHandle.trim().toLowerCase()
        : null
    const scope =
      typeof rawMessage.scope === 'string' && rawMessage.scope.trim()
        ? rawMessage.scope.trim().slice(0, 200)
        : null

    // 1. 24h idempotent deduplication.
    const dedupKey = `${key}:${dedupId}`
    if (this.isDuplicate(dedupKey)) {
      return { accepted: false, action: 'deduped', reason: 'Duplicate delivery' }
    }
    this.markDedup(dedupKey)

    const channelTitle = pluginText(
      installed.channel.title,
      installed.pluginTitle,
      this.deps.locale(),
    )
    const shortLabel = defaultShortLabel(installed)
    const replyBase = (botId: string): ChannelReplyTarget => ({
      botId,
      channelKey: key,
      chatId,
      threadId,
      messageId,
      deliveryId,
    })

    // 2. Built-in /pair <code> command & owner authorization (when pairing capability is enabled).
    const usesPairing = installed.channel.capabilities?.pairing !== false
    const cmd = parseChannelCommand(text)
    if (usesPairing && cmd?.kind === 'pair') {
      const active = this.freshPairing(key)
      const fallbackBotId = cfg.defaultBotId ?? this.deps.bots()[0]?.id ?? 'kettu'
      if (!active || active.code !== cmd.code) {
        await this.sendReply(replyBase(fallbackBotId), {
          body: 'Invalid or expired pairing code. Generate a new code in Kettu Settings › Agents › Bots.',
          status: 'failed',
        })
        return { accepted: false, action: 'command', reason: 'Invalid pairing code' }
      }
      this.pairingCodes.delete(key)
      const owners = cfg.ownerIds.includes(senderId) ? cfg.ownerIds : [...cfg.ownerIds, senderId]
      this.configs.set(key, { ...cfg, ownerIds: owners })
      if (isDirect) {
        this.ownerDmChats.set(key, { channelKey: key, chatId })
      }
      await this.persist()
      this.emitChanged()
      await this.sendReply(replyBase(fallbackBotId), {
        title: `${channelTitle} paired`,
        body: 'Pairing succeeded. You can now talk to your Bots here (prefix @handle to address a specific Bot).',
        status: 'done',
      })
      return { accepted: true, action: 'paired' }
    }

    if (usesPairing && !cfg.ownerIds.includes(senderId)) {
      if (isDirect) {
        const fallbackBotId = cfg.defaultBotId ?? this.deps.bots()[0]?.id ?? 'kettu'
        await this.sendReply(replyBase(fallbackBotId), {
          body: 'This account is not paired yet. Generate a 6-digit code in Kettu and reply with `/pair <code>`.',
          status: 'failed',
        })
      }
      return { accepted: false, action: 'ignored', reason: 'Sender is not a paired owner' }
    }

    if (!isDirect && installed.channel.capabilities?.group) {
      if (!cfg.allowGroupMention) {
        return { accepted: false, action: 'ignored', reason: 'Group mentions are disabled' }
      }
      if (cfg.allowedChatIds.length > 0 && !cfg.allowedChatIds.includes(chatId)) {
        return { accepted: false, action: 'ignored', reason: 'Chat is not in allowlist' }
      }
    }

    // 3. Route to a target Bot (explicit handle > leading @handle|/handle > scope match > defaultBotId > single enabled Bot).
    const eligible = this.deps.bots().filter((b) => botAllowsChannel(b, key, cfg.defaultBotId))
    if (eligible.length === 0) {
      return { accepted: false, action: 'ignored', reason: 'No active Bots bound to this channel' }
    }

    let cleanedText = text.trim()
    let targetBot: Bot | undefined

    if (explicitHandle) {
      targetBot = eligible.find((b) => b.handle === explicitHandle)
    }
    if (!targetBot) {
      const parsed = parseExternalHandleMention(cleanedText)
      if (parsed) {
        const matched = eligible.find((b) => b.handle === parsed.handle)
        if (matched) {
          targetBot = matched
          cleanedText = parsed.body
        }
      }
    }
    if (!targetBot && scope) {
      const lowerScope = scope.toLowerCase()
      targetBot = eligible.find((b) =>
        (b.channels?.[key]?.scope ?? []).some((item) => item.toLowerCase() === lowerScope),
      )
    }
    if (!targetBot && cfg.defaultBotId) {
      targetBot = eligible.find((b) => b.id === cfg.defaultBotId)
    }
    if (!targetBot && eligible.length === 1) {
      targetBot = eligible[0]
    }
    if (!targetBot) {
      if (isDirect) {
        const handles = eligible.map((b) => `@${b.handle} (${b.name})`).join(', ')
        await this.sendReply(replyBase(eligible[0]!.id), {
          body: `No default Bot is set for ${channelTitle}. Prefix your message with one of: ${handles}`,
          status: 'failed',
        })
      }
      return { accepted: false, action: 'ignored', reason: 'No matching or default Bot' }
    }

    // 4. Handle /status and /stop commands.
    if (cmd?.kind === 'status') {
      const statusText = this.deps.onStatusCommand(targetBot.id)
      await this.sendReply(replyBase(targetBot.id), {
        title: `${targetBot.name} · Status`,
        body: statusText,
        status: 'done',
      })
      return { accepted: true, action: 'command', botId: targetBot.id }
    }
    if (cmd?.kind === 'stop') {
      const stopText = await this.deps.onStopCommand(targetBot.id, isDirect ? null : threadId)
      await this.sendReply(replyBase(targetBot.id), {
        title: `${targetBot.name} · Stopped`,
        body: stopText,
        status: 'done',
      })
      return { accepted: true, action: 'command', botId: targetBot.id }
    }

    if (!cleanedText) {
      return { accepted: false, action: 'ignored', reason: 'Empty message body' }
    }

    if (isDirect) {
      this.ownerDmChats.set(key, { channelKey: key, chatId })
      void this.persist()
    }

    const inbound: ChannelInboundMessage = {
      botId: targetBot.id,
      channelKey: key,
      channelTitle,
      channelShortLabel: shortLabel,
      capabilities: installed.channel.capabilities ?? {},
      dedupId,
      chatId,
      threadId,
      messageId,
      deliveryId,
      senderId,
      senderLabel,
      isDirect,
      text: cleanedText,
      externalUrl,
      scope,
    }

    const res = await this.deps.onAuthorizedMessage(inbound)
    if (res.reply) {
      await this.sendReply(replyBase(targetBot.id), {
        body: res.reply,
        status: res.accepted ? 'accepted' : 'failed',
      })
    }
    return {
      accepted: res.accepted,
      action: 'routed',
      botId: targetBot.id,
      ...(res.reason ? { reason: res.reason } : {}),
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private findInstalled(channelKey: string): InstalledBotChannel | undefined {
    return this.deps.plugins.installedChannels().find((item) => item.channelKey === channelKey)
  }

  private configOf(channelKey: string): BotChannelConfig {
    return (
      this.configs.get(channelKey) ?? {
        ...DEFAULT_BOT_CHANNEL_CONFIG,
        ownerIds: [],
        allowedChatIds: [],
      }
    )
  }

  private freshPairing(channelKey: string): BotPairingCode | null {
    const pair = this.pairingCodes.get(channelKey)
    if (!pair) return null
    if (pair.expiresAt <= this.now()) {
      this.pairingCodes.delete(channelKey)
      return null
    }
    return pair
  }

  private buildView(item: InstalledBotChannel): BotChannelView {
    const rt = this.runtimeStates.get(item.channelKey)
    return {
      channelKey: item.channelKey,
      pluginId: item.pluginId,
      pluginName: item.pluginName,
      pluginTitle: item.pluginTitle,
      pluginIcon: item.pluginIcon,
      channelId: item.channel.id,
      title: item.channel.title,
      description: item.channel.description,
      shortLabel: defaultShortLabel(item),
      capabilities: item.channel.capabilities ?? {},
      howToAsk: defaultHowToAsk(item),
      missingRequiredSettings: item.missingRequiredSettings,
      config: this.configOf(item.channelKey),
      state: rt?.state ?? 'off',
      detail: rt?.detail ?? null,
      connectedAt: rt?.connectedAt ?? null,
      pairingCode: this.freshPairing(item.channelKey),
    }
  }

  private requireChannelId(pluginId: string, raw: unknown): string {
    if (!isRecord(raw) || typeof raw.channel !== 'string' || !raw.channel.trim()) {
      throw new Error('options.channel must be a declared botChannel id')
    }
    const channelId = raw.channel.trim()
    const key = botChannelKey(pluginId, channelId)
    if (!this.findInstalled(key)) {
      throw new Error(`Plugin does not declare an active botChannel "${channelId}"`)
    }
    return channelId
  }

  private requireString(o: Record<string, unknown>, field: string, max: number): string {
    const val = o[field]
    if (typeof val !== 'string' || !val.trim()) {
      throw new Error(`${field} must be a non-empty string`)
    }
    return val.trim().slice(0, max)
  }

  private isDuplicate(dedupKey: string): boolean {
    const ts = this.dedup.get(dedupKey)
    if (ts === undefined) return false
    if (this.now() - ts > DEDUP_TTL_MS) {
      this.dedup.delete(dedupKey)
      return false
    }
    return true
  }

  private markDedup(dedupKey: string): void {
    this.dedup.set(dedupKey, this.now())
    if (this.dedup.size > 2000) {
      const cutoff = this.now() - DEDUP_TTL_MS
      for (const [k, ts] of this.dedup.entries()) {
        if (ts < cutoff) this.dedup.delete(k)
      }
    }
    void this.persist()
  }

  private emitChanged(): void {
    this.deps.onChannelsChanged(this.listChannels())
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(path.dirname(this.metaFile), { recursive: true })
      const payload: PersistedChannelStore = {
        version: 2,
        configs: Object.fromEntries(this.configs.entries()),
        dedup: Object.fromEntries(this.dedup.entries()),
        ownerDmChats: Object.fromEntries(this.ownerDmChats.entries()),
      }
      await writeFileAtomic(this.metaFile, JSON.stringify(payload, null, 2))
    } catch (error) {
      this.deps.log('warn', `Could not save bot channel config: ${(error as Error).message}`)
    }
  }
}
