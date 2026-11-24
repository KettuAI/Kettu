// Notification channels of plugins, format 1. A plugin declares a channel in its manifest, the user
// picks which kinds of Kettu's notices go to it (none by default), and Kettu tells the plugin's
// script of each one as an event. A plugin with the `requests.answer` permission may relay the
// user's answer to a permission request that a notice told it of.

import { ATTENTION_SETTING } from './attention'
import type { PluginTexts } from './plugins'
import type { ToolKind } from './thread'

/**
 * The kinds the user picks from, which are the switches of Settings > Notifications. Kettu's own
 * update notice comes from the app rather than the host, so it is not among them.
 */
export const PLUGIN_NOTICE_KINDS = [
  'permission',
  'turnEnded',
  'error',
  'routines',
  'planLimits',
] as const
export type PluginNoticeKind = (typeof PLUGIN_NOTICE_KINDS)[number]

export function isPluginNoticeKind(value: unknown): value is PluginNoticeKind {
  return (PLUGIN_NOTICE_KINDS as readonly unknown[]).includes(value)
}

/** The kind a notice of the host counts as. */
export function noticeKindOf(attention: keyof typeof ATTENTION_SETTING): PluginNoticeKind {
  return ATTENTION_SETTING[attention]
}

/** A channel's id in a manifest, which also names what wakes the plugin for its notices. */
export const PLUGIN_CHANNEL_ID = /^[a-z][a-z0-9-]{0,39}$/
/** What a script is told of the channel that wakes it: `channel:` and its id. */
export const PLUGIN_CHANNEL_TRIGGER = 'channel:'
/** The event a channel's notices are delivered as. */
export const PLUGIN_CHANNEL_EVENT = 'channel.notice'

export function channelTrigger(channelId: string): string {
  return `${PLUGIN_CHANNEL_TRIGGER}${channelId}`
}

export const PLUGIN_CHANNEL_LIMITS = {
  /** Channels one plugin declares. */
  channels: 8,
  title: 80,
  description: 300,
  /** The notice's title and text as a script gets them. */
  noticeTitle: 200,
  noticeText: 500,
  /** The words a relayed answer names where the user gave it. */
  from: 60,
} as const

/** What a manifest declares of a channel; the script gets its notices as an event. */
export interface PluginChannelDecl {
  id: string
  /** By language tag, such as `en` and `zh-CN`; at least one. */
  title: PluginTexts
  description?: PluginTexts
}

/**
 * What a script is told of a notice. The text is conversation content, such as a reply's summary,
 * so it comes only with `sessions.content`; a notice that tells nothing of a conversation always
 * has it. A plugin that may relay answers is also told what a permission request asks for, in the
 * shape of the `session.permissionRequested` hook, and the session's title, since an answer is
 * not worth relaying without it.
 */
export interface PluginChannelNotice {
  channel: string
  kind: PluginNoticeKind
  title: string
  text?: string
  /** For a permission request that may be answered from here: what the answer names it by. */
  request?: {
    id: string
    tool: string
    kind: ToolKind
    command: string | null
    paths: string[]
  }
}

/** The answers a relay may give: allow once, or deny; never always allow. */
export const PLUGIN_RELAY_DECISIONS = ['allow_once', 'deny'] as const
export type PluginRelayDecision = (typeof PLUGIN_RELAY_DECISIONS)[number]

export function isPluginRelayDecision(value: unknown): value is PluginRelayDecision {
  return (PLUGIN_RELAY_DECISIONS as readonly unknown[]).includes(value)
}

/** Where an answer was relayed from, as a permission result keeps it. */
export interface PermissionRelay {
  pluginId: string
  /** The plugin's title. */
  plugin: string
  /** Where the user gave the answer, in the plugin's words; null when it said none. */
  from: string | null
}
