// Shared types for plugin-provided bidirectional Bot channels.

import type { BotChannelReplyMode, PluginBotChannelCapabilities } from '@shared/plugin-bot-channels'

/** Normalized inbound message routed from a Bot channel plugin to a resolved local Bot. */
export interface ChannelInboundMessage {
  botId: string
  /** Global plugin channel key: `plugin:<pluginId>:<channelId>`. */
  channelKey: string
  /** Localized display title of the originating channel plugin. */
  channelTitle: string
  /** Short badge label (e.g. TG, FS, GH, WS). */
  channelShortLabel: string
  /** Capabilities declared by this channel plugin. */
  capabilities: PluginBotChannelCapabilities
  /** Unique platform delivery/message identifier used for 24h idempotent deduplication. */
  dedupId: string
  /** Chat room, direct conversation, or repository identifier. */
  chatId: string
  /** Isolated thread key (topic, root_id, issue/PR number); null for direct owner DM. */
  threadId: string | null
  /** Original message or comment ID used for threaded replies. */
  messageId: string | null
  /** Platform delivery/callback ID echoed back to the plugin on reply. */
  deliveryId: string | null
  /** Immutable platform sender ID (never display name). */
  senderId: string
  /** Human-readable display label (UI only; never used for authorization). */
  senderLabel: string
  /** True for private owner DM; false for group mentions or webhook events. */
  isDirect: boolean
  /** Cleaned user text with leading `@handle` / `/handle` stripped when routed. */
  text: string
  /** Optional external URL linking back to the issue, PR, or chat thread. */
  externalUrl?: string | null
  /** Optional platform scope identifier (such as `owner/repo`) for project matching. */
  scope?: string | null
}

/** Reply target pointing back to the originating plugin Bot channel conversation. */
export interface ChannelReplyTarget {
  botId: string
  channelKey: string
  chatId: string
  threadId?: string | null
  messageId?: string | null
  deliveryId?: string | null
  replyMode?: BotChannelReplyMode
}

/** Structured outbound reply payload sent back to a channel plugin via `botChannel.reply`. */
export interface ChannelReplyPayload {
  title?: string
  body: string
  status?: 'accepted' | 'running' | 'waiting_user' | 'done' | 'failed'
  meta?: string
}

/** Parses built-in control commands (`/pair 123456`, `/status`, `/stop`) from external messages. */
export function parseChannelCommand(
  text: string,
): { kind: 'pair'; code: string } | { kind: 'status' } | { kind: 'stop' } | null {
  const trimmed = text.trim()
  const pair = trimmed.match(/^\/pair(?:@[a-z0-9_]+)?\s+(\d{6})$/i)
  if (pair) return { kind: 'pair', code: pair[1]! }
  if (/^\/status(?:@[a-z0-9_]+)?$/i.test(trimmed)) return { kind: 'status' }
  if (/^\/stop(?:@[a-z0-9_]+)?$/i.test(trimmed)) return { kind: 'stop' }
  return null
}

/** Parses a leading `@handle` or `/handle` mention used on external messaging channels. */
export function parseExternalHandleMention(text: string): { handle: string; body: string } | null {
  const trimmed = text.trim()
  const match = trimmed.match(/^[@/]([a-z0-9][a-z0-9_-]{0,31})(?:\s+([\s\S]*))?$/i)
  if (!match) return null
  return {
    handle: match[1]!.toLowerCase(),
    body: (match[2] ?? '').trim(),
  }
}
