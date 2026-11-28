// Shared domain contracts for Kettu Bots: coordinator definitions, origami/monogram/image
// avatars, cross-computer targets, plugin-provided external channels, Routines,
// 6-step dispatch ledger, confirmation cards and starter templates.

import { isAgentId, type AgentId } from './agents'
import type { Platform } from './platform'
import {
  isBotChannelReplyMode,
  parseBotChannelKey,
  type BotChannelReplyMode,
  type PluginBotChannelCapabilities,
} from './plugin-bot-channels'
import type { PluginTexts } from './plugins'
import {
  isPermissionScope,
  isTimeLimit,
  type PermissionScope,
  type TimeLimitMinutes,
} from './routines'

/** Eight flagship origami character presets (never reuse underlying agent vendor logos). */
export const BOT_AVATAR_PRESETS = [
  'architect',
  'owl',
  'sentinel',
  'scribe',
  'courier',
  'compass',
  'anvil',
  'spark',
] as const
export type BotAvatarPreset = (typeof BOT_AVATAR_PRESETS)[number]

/** Eight curated avatar theme palettes mapped to --bot-avatar-* tokens in tokens.css. */
export const BOT_AVATAR_PALETTES = [
  'fox',
  'slate',
  'sage',
  'indigo',
  'amber',
  'rose',
  'cyan',
  'plum',
] as const
export type BotAvatarPalette = (typeof BOT_AVATAR_PALETTES)[number]

/** Bot avatar descriptor: flagship origami preset, monogram tile, or cropped local image. */
export type BotAvatar =
  | { kind: 'preset'; preset: BotAvatarPreset; palette: BotAvatarPalette }
  | { kind: 'monogram'; text: string; palette: BotAvatarPalette }
  | {
      kind: 'image'
      /** File name relative to the Bot directory, e.g. avatar.webp. */
      file: string
      crop?: { x: number; y: number; scale: number }
    }

/** Bot status ordered by visual priority: needs_you > running > paused > idle. */
export type BotStatus = 'needs_you' | 'running' | 'paused' | 'idle'

/** Live connection state of a plugin-provided Bot channel. */
export type BotChannelConnectionState =
  'off' | 'connecting' | 'connected' | 'reconnecting' | 'error'

/** Per-Bot lightweight binding to an installed plugin Bot channel (`plugin:<pluginId>:<channelId>`). */
export interface BotChannelBinding {
  enabled: boolean
  /** Optional reply strategy override when supported by the channel plugin. */
  replyMode?: BotChannelReplyMode
  /** Optional routing scopes matched by the channel (e.g. `owner/repo` on GitHub). */
  scope?: string[]
}

/** Per-Bot channel bindings keyed by `plugin:<pluginId>:<channelId>` (zero plaintext secrets). */
export type BotChannelsConfig = Record<string, BotChannelBinding>

/** Host-level shared configuration for one plugin Bot channel (persisted once across all Bots). */
export interface BotChannelConfig {
  enabled: boolean
  /** Default Bot receiving messages that omit an explicit `@handle` or `/handle`. */
  defaultBotId: string | null
  /** Authorized owner sender IDs paired via 6-digit `/pair <code>` (shared across all Bots). */
  ownerIds: string[]
  /** Whether group/topic mentions are accepted (always isolated from main chat). */
  allowGroupMention: boolean
  /** Optional allowlist of group/room chat IDs; empty allows any group where an owner mentions a Bot. */
  allowedChatIds: string[]
}

export const DEFAULT_BOT_CHANNEL_CONFIG: Readonly<BotChannelConfig> = {
  enabled: false,
  defaultBotId: null,
  ownerIds: [],
  allowGroupMention: false,
  allowedChatIds: [],
}

/** Active 6-digit owner pairing code generated for a channel on the Home Host. */
export interface BotPairingCode {
  code: string
  expiresAt: number
}

/** Live snapshot of an installed Bot channel plugin broadcast to desktop and mobile clients. */
export interface BotChannelView {
  /** Global channel key: `plugin:<pluginId>:<channelId>`. */
  channelKey: string
  pluginId: string
  pluginName: string
  pluginTitle: string
  pluginIcon: string | null
  channelId: string
  title: PluginTexts
  description?: PluginTexts
  /** Short badge text shown on Bot headers and dispatch cards (e.g. TG, FS, GH). */
  shortLabel: string
  capabilities: PluginBotChannelCapabilities
  /** Template illustrating how to address a Bot on this channel, e.g. `@{{handle}} ...`. */
  howToAsk: string
  /** Required plugin settings not yet configured in the plugin's settings page. */
  missingRequiredSettings: string[]
  config: BotChannelConfig
  state: BotChannelConnectionState
  detail: string | null
  connectedAt: number | null
  pairingCode: BotPairingCode | null
}

/** Single managed project target; hostId === null refers to the local Home Host. */
export interface BotTargetRef {
  hostId: string | null
  projectPath: string
  projectName?: string
}

/** Per-Bot configurable runtime guardrails. */
export interface BotLimits {
  /** Maximum concurrent in-flight work sessions for this Bot. */
  maxConcurrent: number
  /** Maximum work sessions this Bot can dispatch per local calendar day. */
  maxDaily: number
  /** Single work session timeout in minutes. */
  timeLimitMinutes: TimeLimitMinutes
  /** Maximum unattended back-and-forth wakeups before pausing for the user. */
  maxUnattendedRounds: number
}

/** Host-wide Bot settings persisted in SettingsFile.bots. */
export interface BotGlobalSettings {
  /** Combined concurrency cap across all Bots on this host. */
  maxConcurrent: number
  /** Whether agents inside normal sessions may invoke handoff_to_bot. */
  allowAgentHandoff: boolean
}

export const DEFAULT_BOT_LIMITS: Readonly<BotLimits> = {
  maxConcurrent: 3,
  maxDaily: 50,
  timeLimitMinutes: 60,
  maxUnattendedRounds: 10,
}

export const DEFAULT_BOT_GLOBAL_SETTINGS: Readonly<BotGlobalSettings> = {
  maxConcurrent: 6,
  allowAgentHandoff: true,
}

export const BOT_NAME_CHARS = 60
export const BOT_HANDLE_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
export const BOT_DESCRIPTION_CHARS = 240
export const BOT_ROLE_CHARS = 20_000
export const BOT_MAX_TARGETS = 100
export const BOT_MAX_CONCURRENT_MIN = 1
export const BOT_MAX_CONCURRENT_MAX = 20
export const BOT_MAX_DAILY_MIN = 1
export const BOT_MAX_DAILY_MAX = 500
export const BOT_MAX_ROUNDS_MIN = 1
export const BOT_MAX_ROUNDS_MAX = 50
export const BOT_GLOBAL_CONCURRENT_MIN = 1
export const BOT_GLOBAL_CONCURRENT_MAX = 50
export const BOT_AVATAR_MAX_BYTES = 64 * 1024
export const BOT_AVATAR_MIME_TYPES = ['image/webp', 'image/png', 'image/jpeg'] as const
export type BotAvatarMimeType = (typeof BOT_AVATAR_MIME_TYPES)[number]

/** Bot configuration persisted in <userData>/bots/<botId>/bot.json. */
export interface Bot {
  id: string
  name: string
  /** Unique lowercase handle used for @mentions and external channel routing. */
  handle: string
  description: string
  avatar: BotAvatar
  /** Harness / Agent driving the Bot's isolated main conversation. */
  agentId: AgentId
  model: string | null
  effort: string | null
  /** Managed local and paired-host projects; empty allows dynamic dispatch on demand. */
  targets: BotTargetRef[]
  /** Maximum permission ceiling for dispatched work sessions. */
  scope: PermissionScope
  limits: BotLimits
  /** External channels attached to this Bot (Telegram, Feishu, GitHub). */
  channels?: BotChannelsConfig
  paused: boolean
  /** Bound main conversation session ID; created lazily on first message. */
  mainSessionId: string | null
  createdAt: number
  updatedAt: number
}

/** Full Bot view sent to clients, combining bot.json, ROLE.md and live aggregate counts. */
export interface BotView extends Bot {
  roleMarkdown: string
  status: BotStatus
  /** Unarchived requests currently active or waiting for user approval. */
  activeCount: number
  /** Requests requiring user approval or attention after failure. */
  needsYouCount: number
  /** Local pending dispatches waiting for an offline target host to reconnect. */
  pendingHostCount: number
  /** Dispatches initiated today on the local calendar day. */
  todayCount: number
  /** Number of entries in this Bot's dedicated memory layer. */
  memoryCount: number
  lastActivityAt: number | null
}

/** Payload for creating a new Bot. */
export interface BotDraft {
  name: string
  handle?: string
  description?: string
  avatar?: BotAvatar
  agentId: AgentId
  model?: string | null
  effort?: string | null
  targets?: BotTargetRef[]
  scope?: PermissionScope
  limits?: Partial<BotLimits>
  channels?: BotChannelsConfig
  roleMarkdown?: string
}

/** Partial update payload for an existing Bot. */
export interface BotChanges {
  name?: string
  handle?: string
  description?: string
  avatar?: BotAvatar
  agentId?: AgentId
  model?: string | null
  effort?: string | null
  targets?: BotTargetRef[]
  scope?: PermissionScope
  limits?: Partial<BotLimits>
  channels?: BotChannelsConfig
  roleMarkdown?: string
  paused?: boolean
}

/** Lifecycle status of a single Bot dispatch / offline pending request. */
export type BotRequestStatus =
  | 'received'
  | 'queued'
  | 'waiting_host'
  | 'running'
  | 'waiting_user'
  | 'delivered'
  | 'failed'
  | 'cancelled'
  | 'expired'

export const BOT_WORKING_STATUSES: ReadonlySet<BotRequestStatus> = new Set([
  'received',
  'queued',
  'running',
  'waiting_user',
])

export const BOT_TERMINAL_STATUSES: ReadonlySet<BotRequestStatus> = new Set([
  'delivered',
  'failed',
  'cancelled',
  'expired',
])

/** All possible request origins for Bot dispatches and isolated external threads. */
export type BotRequestSourceKind = 'main' | 'mention' | 'handoff' | 'channel' | 'routine'

/** Trigger provenance attached to a BotRequest for routing, UI badges and reply delivery. */
export interface BotRequestSource {
  kind: BotRequestSourceKind
  /** Originating normal session and host when triggered via @Bot mention or handoff. */
  sessionId?: string
  hostId?: string | null
  /** Plugin Bot channel key (`plugin:<pluginId>:<channelId>`) when kind === 'channel'. */
  channelKey?: string
  /** Display title of the originating channel plugin for UI badges. */
  channelTitle?: string
  /** Short badge label (e.g. TG, FS, GH, WS) supplied by the channel plugin. */
  channelShortLabel?: string
  /** Platform delivery/callback reference echoed back to the plugin on reply. */
  deliveryId?: string | null
  /** External chat, room, or repository identifier. */
  chatId?: string
  /** Isolated thread key (topic, root_id, issue/PR number); null for DM. */
  threadId?: string | null
  /** External message or comment ID used for reply threading. */
  messageId?: string | null
  /** Human-readable sender or thread label (display only; never used for auth). */
  senderLabel?: string | null
  /** Linked Routine and run IDs when triggered from a scheduled Routine. */
  routineId?: string
  runId?: string
  /** Optional external link (e.g. issue, PR, or chat thread URL). */
  externalUrl?: string | null
  /** Timestamp when the final summary was posted back to the external channel. */
  repliedAt?: number | null
}

/** Single work dispatch / offline pending item recorded in the Home Host ledger. */
export interface BotRequest {
  id: string
  botId: string
  title: string
  prompt: string
  source: BotRequestSource
  /** Target computer ID; null means the local Home Host. */
  targetHostId: string | null
  targetHostName: string
  targetPlatform: Platform
  projectPath: string
  projectName: string
  agentId: AgentId
  model: string | null
  scope: PermissionScope
  worktree: boolean
  branch: string | null
  /** Real session ID created on the target host once dispatched. */
  sessionId: string | null
  status: BotRequestStatus
  /** Latest outcome summary or completion snippet. */
  summary: string | null
  error: string | null
  /** Idempotency deduplication key (e.g. external channel delivery or issue key). */
  dedupKey: string | null
  createdAt: number
  updatedAt: number
  startedAt: number | null
  endedAt: number | null
  archivedAt: number | null
}

/** Live snapshot of a target host's online state, projects, agents and load. */
export interface BotHostTarget {
  /** null for this local Home Host. */
  hostId: string | null
  name: string
  platform: Platform
  online: boolean
  self: boolean
  projects: { path: string; name: string }[]
  agents: { id: AgentId; name: string; ready: boolean; mcp: boolean }[]
  load: { cpuPct: number | null; memPct: number | null; workingSessions: number } | null
}

/** Bot ownership metadata carried on a SessionSummary / SessionView. */
export interface BotSessionRef {
  botId: string
  /** main for the Bot's isolated coordinator thread; work for dispatched or external threads. */
  role: 'main' | 'work'
  requestId?: string
  homeHostId?: string | null
  botName?: string
  botHandle?: string
  /** Source kind of this Bot session (external sessions trigger memory write confirmation). */
  sourceKind?: BotRequestSourceKind
}

/** Controlled MCP self-management actions (always require user confirmation card). */
export type BotChangeAction = 'create' | 'update' | 'delete' | 'role_edit'

/** Snapshot of Bot fields shown on a confirmation card. */
export interface BotCardFields {
  name: string
  handle: string
  description: string
  avatar: BotAvatar
  agentId: AgentId
  model: string | null
  effort: string | null
  targets: BotTargetRef[]
  scope: PermissionScope
  limits: BotLimits
  roleMarkdown?: string
  /** Delete action only: keep historical work sessions as normal project sessions (default true). */
  keepSessions?: boolean
}

/** Outcome recorded on a Bot confirmation card. */
export type BotChangeOutcome =
  | { kind: 'done'; botId: string }
  | { kind: 'declined' | 'expired' | 'ended' }
  | { kind: 'failed'; message: string }

/** Response payload for bots.list. */
export interface BotList {
  bots: BotView[]
  requests: BotRequest[]
  channels: BotChannelView[]
}

/** Bridge calls from local AgentHost to main/remote-host for cross-computer dispatch and cloud auth. */
export type BotRemoteCall =
  | { kind: 'list_targets' }
  | { kind: 'account_context' }
  | {
      kind: 'dispatch_session'
      hostId: string
      projectPath: string
      agentId: AgentId
      model?: string | null
      prompt: string
      title: string
      scope: PermissionScope
      worktree?: boolean
      bot: BotSessionRef
    }
  | { kind: 'send_session'; hostId: string; sessionId: string; text: string }
  | { kind: 'archive_session'; hostId: string; sessionId: string }
  | { kind: 'read_session_reply'; hostId: string; sessionId: string }

/** Result returned by the main/remote-host bridge. */
export type BotRemoteAnswer =
  | { ok: true; data: unknown }
  | { ok: false; code: 'offline' | 'not_found' | 'failed'; message: string }

/** Remote host lifecycle and session events pushed into the local BotManager. */
export type BotRemoteEvent =
  | { kind: 'host_online'; hostId: string; hostName: string }
  | { kind: 'host_offline'; hostId: string }
  | {
      kind: 'session_update'
      hostId: string
      sessionId: string
      status: string
      permissionCount: number
      error?: string | null
      title?: string | null
      branch?: string | null
      archivedAt?: number | null
    }

/** Three starter Bot template IDs. */
export const BOT_EXAMPLE_IDS = ['dev-manager', 'pr-reviewer', 'ci-oncall'] as const
export type BotExampleId = (typeof BOT_EXAMPLE_IDS)[number]

export interface BotExampleSpec {
  id: BotExampleId
  defaultHandle: string
  avatar: BotAvatar
  scope: PermissionScope
  limits: BotLimits
}

/** Starter Bot specs (localized copy lives in bots.json). */
export const BOT_EXAMPLES: readonly BotExampleSpec[] = [
  {
    id: 'dev-manager',
    defaultHandle: 'dev',
    avatar: { kind: 'preset', preset: 'architect', palette: 'fox' },
    scope: { level: 'commands', web: true },
    limits: { ...DEFAULT_BOT_LIMITS, maxConcurrent: 4 },
  },
  {
    id: 'pr-reviewer',
    defaultHandle: 'reviewer',
    avatar: { kind: 'preset', preset: 'owl', palette: 'indigo' },
    scope: { level: 'read', web: false },
    limits: { ...DEFAULT_BOT_LIMITS, maxConcurrent: 3 },
  },
  {
    id: 'ci-oncall',
    defaultHandle: 'oncall',
    avatar: { kind: 'preset', preset: 'sentinel', palette: 'amber' },
    scope: { level: 'commands', web: true },
    limits: { ...DEFAULT_BOT_LIMITS, maxConcurrent: 2, timeLimitMinutes: 30 },
  },
]

export function isBotAvatarPreset(value: unknown): value is BotAvatarPreset {
  return (BOT_AVATAR_PRESETS as readonly unknown[]).includes(value)
}

export function isBotAvatarPalette(value: unknown): value is BotAvatarPalette {
  return (BOT_AVATAR_PALETTES as readonly unknown[]).includes(value)
}

export function isBotAvatar(value: unknown): value is BotAvatar {
  if (typeof value !== 'object' || value === null) return false
  const o = value as Record<string, unknown>
  if (o.kind === 'preset') {
    return isBotAvatarPreset(o.preset) && isBotAvatarPalette(o.palette)
  }
  if (o.kind === 'monogram') {
    return (
      typeof o.text === 'string' &&
      o.text.trim().length >= 1 &&
      [...o.text.trim()].length <= 2 &&
      isBotAvatarPalette(o.palette)
    )
  }
  if (o.kind === 'image') {
    if (typeof o.file !== 'string' || !/^[a-z0-9._-]+$/i.test(o.file)) return false
    if (o.crop !== undefined) {
      if (typeof o.crop !== 'object' || o.crop === null) return false
      const c = o.crop as Record<string, unknown>
      if (
        typeof c.x !== 'number' ||
        typeof c.y !== 'number' ||
        typeof c.scale !== 'number' ||
        !Number.isFinite(c.x) ||
        !Number.isFinite(c.y) ||
        !Number.isFinite(c.scale) ||
        c.scale < 0.5 ||
        c.scale > 4
      ) {
        return false
      }
    }
    return true
  }
  return false
}

export function isBotTargetRef(value: unknown): value is BotTargetRef {
  if (typeof value !== 'object' || value === null) return false
  const o = value as Record<string, unknown>
  return (
    (o.hostId === null || (typeof o.hostId === 'string' && o.hostId.length > 0)) &&
    typeof o.projectPath === 'string' &&
    o.projectPath.length > 0 &&
    (o.projectName === undefined || typeof o.projectName === 'string')
  )
}

export function isBotLimits(value: unknown): value is BotLimits {
  if (typeof value !== 'object' || value === null) return false
  const o = value as Record<string, unknown>
  return (
    typeof o.maxConcurrent === 'number' &&
    Number.isInteger(o.maxConcurrent) &&
    o.maxConcurrent >= BOT_MAX_CONCURRENT_MIN &&
    o.maxConcurrent <= BOT_MAX_CONCURRENT_MAX &&
    typeof o.maxDaily === 'number' &&
    Number.isInteger(o.maxDaily) &&
    o.maxDaily >= BOT_MAX_DAILY_MIN &&
    o.maxDaily <= BOT_MAX_DAILY_MAX &&
    isTimeLimit(o.timeLimitMinutes) &&
    typeof o.maxUnattendedRounds === 'number' &&
    Number.isInteger(o.maxUnattendedRounds) &&
    o.maxUnattendedRounds >= BOT_MAX_ROUNDS_MIN &&
    o.maxUnattendedRounds <= BOT_MAX_ROUNDS_MAX
  )
}

export function isBotGlobalSettings(value: unknown): value is BotGlobalSettings {
  if (typeof value !== 'object' || value === null) return false
  const o = value as Record<string, unknown>
  return (
    typeof o.maxConcurrent === 'number' &&
    Number.isInteger(o.maxConcurrent) &&
    o.maxConcurrent >= BOT_GLOBAL_CONCURRENT_MIN &&
    o.maxConcurrent <= BOT_GLOBAL_CONCURRENT_MAX &&
    typeof o.allowAgentHandoff === 'boolean'
  )
}

export function isBotHandle(value: unknown): value is string {
  return typeof value === 'string' && BOT_HANDLE_RE.test(value)
}

export function isBotRequestSourceKind(value: unknown): value is BotRequestSourceKind {
  return (
    value === 'main' ||
    value === 'mention' ||
    value === 'handoff' ||
    value === 'channel' ||
    value === 'routine'
  )
}

/** Whether a request originated from an external or unattended source rather than in-app user chat. */
export function isExternalBotSource(kind: BotRequestSourceKind | undefined): boolean {
  return kind === 'channel' || kind === 'routine'
}

function cleanStringList(value: unknown, max = 100): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed || trimmed.length > 200 || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
    if (out.length >= max) break
  }
  return out
}

/** Normalizes per-Bot plugin channel bindings (`Record<channelKey, BotChannelBinding>`). */
export function normalizeBotChannels(raw: unknown): BotChannelsConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const result: BotChannelsConfig = {}
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!parseBotChannelKey(key)) continue
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const o = entry as Record<string, unknown>
    const binding: BotChannelBinding = { enabled: o.enabled === true }
    if (isBotChannelReplyMode(o.replyMode)) binding.replyMode = o.replyMode
    const scope = cleanStringList(o.scope, 200)
    if (scope.length > 0) binding.scope = scope
    result[key] = binding
  }
  return result
}

/** Normalizes host-level shared config for a plugin Bot channel. */
export function normalizeBotChannelConfig(raw: unknown): BotChannelConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ...DEFAULT_BOT_CHANNEL_CONFIG, ownerIds: [], allowedChatIds: [] }
  }
  const o = raw as Record<string, unknown>
  return {
    enabled: o.enabled === true,
    defaultBotId:
      typeof o.defaultBotId === 'string' && o.defaultBotId.trim().length > 0
        ? o.defaultBotId.trim().slice(0, 128)
        : null,
    ownerIds: cleanStringList(o.ownerIds, 100),
    allowGroupMention: o.allowGroupMention === true,
    allowedChatIds: cleanStringList(o.allowedChatIds, 200),
  }
}

/** Converts a user-provided Bot display name into a valid default @handle. */
export function slugifyBotHandle(input: string): string {
  const clean = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return clean && BOT_HANDLE_RE.test(clean) ? clean : 'bot'
}

/** Computes the highest-priority badge status for a Bot avatar. */
export function computeBotStatus(
  bot: Pick<Bot, 'paused'>,
  counts: { needsYouCount: number; activeCount: number; mainRunning?: boolean },
): BotStatus {
  if (counts.needsYouCount > 0) return 'needs_you'
  if (counts.activeCount > 0 || counts.mainRunning) return 'running'
  if (bot.paused) return 'paused'
  return 'idle'
}

/** Clamps and fills missing fields in a partial BotLimits object. */
export function normalizeBotLimits(partial?: Partial<BotLimits>): BotLimits {
  const clamp = (value: unknown, min: number, max: number, fallback: number): number =>
    typeof value === 'number' && Number.isInteger(value)
      ? Math.min(max, Math.max(min, value))
      : fallback
  return {
    maxConcurrent: clamp(
      partial?.maxConcurrent,
      BOT_MAX_CONCURRENT_MIN,
      BOT_MAX_CONCURRENT_MAX,
      DEFAULT_BOT_LIMITS.maxConcurrent,
    ),
    maxDaily: clamp(
      partial?.maxDaily,
      BOT_MAX_DAILY_MIN,
      BOT_MAX_DAILY_MAX,
      DEFAULT_BOT_LIMITS.maxDaily,
    ),
    timeLimitMinutes: isTimeLimit(partial?.timeLimitMinutes)
      ? partial.timeLimitMinutes
      : DEFAULT_BOT_LIMITS.timeLimitMinutes,
    maxUnattendedRounds: clamp(
      partial?.maxUnattendedRounds,
      BOT_MAX_ROUNDS_MIN,
      BOT_MAX_ROUNDS_MAX,
      DEFAULT_BOT_LIMITS.maxUnattendedRounds,
    ),
  }
}

/** Validates a BotCardFields snapshot used by thread entries and MCP tools. */
export function isBotCardFields(value: unknown): value is BotCardFields {
  if (typeof value !== 'object' || value === null) return false
  const o = value as Record<string, unknown>
  return (
    typeof o.name === 'string' &&
    o.name.length > 0 &&
    o.name.length <= BOT_NAME_CHARS &&
    isBotHandle(o.handle) &&
    typeof o.description === 'string' &&
    o.description.length <= BOT_DESCRIPTION_CHARS &&
    isBotAvatar(o.avatar) &&
    isAgentId(o.agentId) &&
    (o.model === null || typeof o.model === 'string') &&
    (o.effort === null || typeof o.effort === 'string') &&
    Array.isArray(o.targets) &&
    o.targets.length <= BOT_MAX_TARGETS &&
    o.targets.every(isBotTargetRef) &&
    isPermissionScope(o.scope) &&
    isBotLimits(o.limits) &&
    (o.roleMarkdown === undefined || typeof o.roleMarkdown === 'string') &&
    (o.keepSessions === undefined || typeof o.keepSessions === 'boolean')
  )
}

/** Extracts the target Bot handle and remaining text from a leading `@handle` message. */
export function parseLeadingBotMention(text: string): { handle: string; body: string } | null {
  const match = text.match(/^@([a-z0-9][a-z0-9_-]{0,31})(?:\s+([\s\S]*))?$/i)
  if (!match) return null
  return {
    handle: match[1]!.toLowerCase(),
    body: (match[2] ?? '').trim(),
  }
}

/** Formats a channel's `howToAsk` template for a specific Bot handle. */
export function formatChannelHowToAsk(template: string, handle: string): string {
  return template.replace(/\{\{\s*handle\s*\}\}/g, handle)
}
