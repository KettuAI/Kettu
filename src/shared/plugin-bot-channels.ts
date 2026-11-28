// Bot channel declarations for Kettu plugins (format 1). A plugin with the `bots.bridge`
// permission may declare one or more bidirectional Bot channels under `extensions["sh.kettu"].botChannels`.
// Kettu manages credentials via plugin settings, routes inbound messages by @handle or default Bot,
// enforces 6-digit /pair owner binding, 24h deduplication and client-only approval, and delivers
// outbound replies and alerts back to the plugin via `botChannel.reply`.

import type { PluginTexts } from './plugins'

/** Reply modes a Bot channel binding may declare or select. */
export const BOT_CHANNEL_REPLY_MODES = [
  'review_first',
  'auto',
  'kettu_only',
  'summary',
  'full',
] as const
export type BotChannelReplyMode = (typeof BOT_CHANNEL_REPLY_MODES)[number]

export function isBotChannelReplyMode(value: unknown): value is BotChannelReplyMode {
  return (BOT_CHANNEL_REPLY_MODES as readonly unknown[]).includes(value)
}

/** Valid channel ID inside a plugin manifest (`botChannels[].id`). */
export const PLUGIN_BOT_CHANNEL_ID = /^[a-z][a-z0-9-]{0,39}$/

/** Activation trigger prefix waking a plugin for a declared Bot channel. */
export const PLUGIN_BOT_CHANNEL_TRIGGER = 'botChannel:'

export function botChannelTrigger(channelId: string): string {
  return `${PLUGIN_BOT_CHANNEL_TRIGGER}${channelId}`
}

/** Global channel key addressing a plugin-provided Bot channel across host and clients. */
export function botChannelKey(pluginId: string, channelId: string): string {
  return `plugin:${pluginId}:${channelId}`
}

/** Parses a `plugin:<pluginId>:<channelId>` channel key; null if malformed. */
export function parseBotChannelKey(key: string): { pluginId: string; channelId: string } | null {
  if (!key.startsWith('plugin:')) return null
  const rest = key.slice('plugin:'.length)
  const colon = rest.indexOf(':')
  if (colon < 1) return null
  const pluginId = rest.slice(0, colon)
  const channelId = rest.slice(colon + 1)
  if (!pluginId || !PLUGIN_BOT_CHANNEL_ID.test(channelId)) return null
  return { pluginId, channelId }
}

/** Limits enforced when validating `botChannels` in a plugin manifest. */
export const PLUGIN_BOT_CHANNEL_LIMITS = {
  channels: 8,
  title: 80,
  description: 300,
  shortLabel: 8,
  howToAsk: 120,
} as const

/** Capability flags declared by a plugin Bot channel. */
export interface PluginBotChannelCapabilities {
  /** Supports private 1:1 owner DMs routed to the Bot's main chat. */
  direct?: boolean
  /** Supports group/topic mentions routed to isolated external threads. */
  group?: boolean
  /** Uses Kettu's built-in 6-digit `/pair` owner binding flow. */
  pairing?: boolean
  /** Reply modes offered for per-Bot overrides on this channel. */
  replyModes?: BotChannelReplyMode[]
  /** Supports per-Bot routing scopes such as repository lists (`owner/repo`). */
  scopes?: boolean
}

/** Manifest declaration for a single bidirectional Bot channel provided by a plugin. */
export interface PluginBotChannelDecl {
  id: string
  title: PluginTexts
  description?: PluginTexts
  /** Short badge text rendered on Bot header pills and cards (e.g. TG, FS, GH). */
  shortLabel?: string
  capabilities?: PluginBotChannelCapabilities
  /** Template illustrating how to address a Bot on this platform, e.g. `@{{handle}} ...`. */
  howToAsk?: string
}

/** Events delivered between agent-host and Bot channel plugin scripts. */
export const PLUGIN_BOT_CHANNEL_EVENTS = {
  start: 'botChannel.start',
  stop: 'botChannel.stop',
  reply: 'botChannel.reply',
  test: 'botChannel.test',
} as const

/** Events delivered for host-managed plugin WebSocket connections. */
export const PLUGIN_WS_EVENTS = {
  open: 'network.ws.open',
  message: 'network.ws.message',
  close: 'network.ws.close',
  error: 'network.ws.error',
} as const

/** Per-plugin WebSocket resource caps enforced by the agent host. */
export const PLUGIN_WS_LIMITS = {
  maxSockets: 4,
  maxFrameBytes: 256 * 1024,
} as const

/** Normalizes a user-configured endpoint URL to a canonical origin (`http(s)://host[:port]`). */
export function customUrlOrigin(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const parsed = URL.parse(trimmed)
  if (!parsed) return null
  if (parsed.username !== '' || parsed.password !== '') return null
  if (
    parsed.protocol !== 'https:' &&
    parsed.protocol !== 'http:' &&
    parsed.protocol !== 'wss:' &&
    parsed.protocol !== 'ws:'
  ) {
    return null
  }
  if (!parsed.hostname) return null
  const scheme =
    parsed.protocol === 'wss:' ? 'https:' : parsed.protocol === 'ws:' ? 'http:' : parsed.protocol
  const defaultPort = scheme === 'https:' ? '443' : '80'
  const port = parsed.port && parsed.port !== defaultPort ? `:${parsed.port}` : ''
  return `${scheme}//${parsed.hostname.toLowerCase()}${port}`
}
