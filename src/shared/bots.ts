// Kettu Bot 共享领域契约：角色定义、专属头像组件库模型、跨电脑目标、6 步派发台账、确认卡片与默认示例。

import { isAgentId, type AgentId } from './agents'
import type { Platform } from './platform'
import {
  isPermissionScope,
  isTimeLimit,
  type PermissionScope,
  type TimeLimitMinutes,
} from './routines'

/** Bot 头像 8 款原创矢量插画预设 ID（严禁复用 Agent 厂商 Logo）。 */
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

/** Bot 头像 8 套主题配色 ID（对应 tokens.css 中的 --bot-avatar-* 双色令牌）。 */
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

/** Bot 头像规格：原创插画预设、字标预设，或裁切压缩后的本地自定义图片。 */
export type BotAvatar =
  | { kind: 'preset'; preset: BotAvatarPreset; palette: BotAvatarPalette }
  | { kind: 'monogram'; text: string; palette: BotAvatarPalette }
  | {
      kind: 'image'
      /** 相对于 Bot 目录的文件名，例如 avatar.webp。 */
      file: string
      crop?: { x: number; y: number; scale: number }
    }

/** Bot 状态优先级：needs_you > running > paused > idle。 */
export type BotStatus = 'needs_you' | 'running' | 'paused' | 'idle'

/** Bot 管理的单个跨电脑项目目标；hostId 为 null 表示当前本机（Home Host）。 */
export interface BotTargetRef {
  hostId: string | null
  projectPath: string
  projectName?: string
}

/** 单个 Bot 的可调运行上限。 */
export interface BotLimits {
  /** 同一个 Bot 同时进行中的工作会话上限。 */
  maxConcurrent: number
  /** 单个 Bot 每日派活次数上限。 */
  maxDaily: number
  /** 单次工作会话超时时间（分钟）。 */
  timeLimitMinutes: TimeLimitMinutes
  /** 无人值守连续唤醒主对话的最大回合数。 */
  maxUnattendedRounds: number
}

/** 全局 Bot 运行设置（存在 SettingsFile.bots）。 */
export interface BotGlobalSettings {
  /** 整机所有 Bot 叠加的同时活跃工作会话上限。 */
  maxConcurrent: number
  /** 允许普通会话里的 Agent 主动委派任务给 Bot。 */
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

/** 持久化在 <userData>/bots/<botId>/bot.json 中的 Bot 配置。 */
export interface Bot {
  id: string
  name: string
  /** 供全局 @handle 提及与路由的唯一代号（全小写字母、数字、-、_）。 */
  handle: string
  description: string
  avatar: BotAvatar
  /** Bot 主对话使用的 Harness / Agent，用户可自由指定任意已启用且支持 MCP 的 Harness。 */
  agentId: AgentId
  model: string | null
  effort: string | null
  /** 该 Bot 可跨电脑调度的目标项目列表；为空表示可按需派往任意已配置项目。 */
  targets: BotTargetRef[]
  /** 派发工作会话的默认权限上限。 */
  scope: PermissionScope
  limits: BotLimits
  paused: boolean
  /** 当前绑定的主对话 Session ID；为空时在首次发送时懒创建。 */
  mainSessionId: string | null
  createdAt: number
  updatedAt: number
}

/** 传给渲染层的 Bot 完整视图（含 ROLE.md 与实时聚合状态）。 */
export interface BotView extends Bot {
  roleMarkdown: string
  status: BotStatus
  /** 当前未归档且处于活跃/等待态的工作数。 */
  activeCount: number
  /** 需要用户审批或失败的工作数。 */
  needsYouCount: number
  /** 等待目标电脑重新上线的本地待办数。 */
  pendingHostCount: number
  /** 今日已派发次数。 */
  todayCount: number
  /** 第 3 层（Bot 记忆）条目数。 */
  memoryCount: number
  lastActivityAt: number | null
}

/** 创建 Bot 的请求负载。 */
export interface BotDraft {
  name: string
  handle: string
  description?: string
  avatar?: BotAvatar
  agentId: AgentId
  model?: string | null
  effort?: string | null
  targets?: BotTargetRef[]
  scope?: PermissionScope
  limits?: Partial<BotLimits>
  roleMarkdown?: string
}

/** 编辑 Bot 的增量字段。 */
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
  paused?: boolean
  roleMarkdown?: string
}

/** 6 步管线状态机：收下 -> 排队/等目标机 -> 进行中/等你拍板 -> 已交付/失败/取消/过期。 */
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

/** 请求触发来源。 */
export interface BotRequestSource {
  kind: 'main' | 'mention' | 'handoff'
  /** 若来自某普通会话的 @Bot 或委派，则记录来源会话与主机。 */
  sessionId?: string
  hostId?: string | null
}

/** 存在 Home Host 本地台账中的单条跨机派发工作 / 离线待办记录。 */
export interface BotRequest {
  id: string
  botId: string
  title: string
  prompt: string
  source: BotRequestSource
  /** 目标电脑 ID；null 表示本机 Home Host。 */
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
  /** 派发成功后落地的目标电脑真实 Session ID。 */
  sessionId: string | null
  status: BotRequestStatus
  /** 执行结果摘要或中断原因。 */
  summary: string | null
  error: string | null
  /** 幂等去重键（例如同项目同 PR / 同议题）。 */
  dedupKey: string | null
  createdAt: number
  updatedAt: number
  startedAt: number | null
  endedAt: number | null
  archivedAt: number | null
}

/** 跨电脑目标主机实时快照（供 Bot 表单、工作台与主对话路由参考）。 */
export interface BotHostTarget {
  /** null 表示当前本机（Home Host）。 */
  hostId: string | null
  name: string
  platform: Platform
  online: boolean
  self: boolean
  projects: { path: string; name: string }[]
  agents: { id: AgentId; name: string; ready: boolean; mcp: boolean }[]
  load: { cpuPct: number | null; memPct: number | null; workingSessions: number } | null
}

/** 挂在普通会话（SessionSummary / SessionView）上的 Bot 归属标记。 */
export interface BotSessionRef {
  botId: string
  /** main 为 Bot 主对话，work 为 Bot 派发的工作会话。 */
  role: 'main' | 'work'
  requestId?: string
  homeHostId?: string | null
  botName?: string
  botHandle?: string
}

/** 受控 MCP 自管理接口支持的动作类型（任何模式下都需用户点卡片确认）。 */
export type BotChangeAction = 'create' | 'update' | 'delete' | 'role_edit'

/** 确认卡片中展示的 Bot 字段快照。 */
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
  /** 仅删除动作使用：是否将 Bot 派发过的历史工作会话转为普通会话保留（默认 true）。 */
  keepSessions?: boolean
}

/** Bot 确认卡片的结果。 */
export type BotChangeOutcome =
  | { kind: 'done'; botId: string }
  | { kind: 'declined' | 'expired' | 'ended' }
  | { kind: 'failed'; message: string }

/** bots.list 的返回体。 */
export interface BotList {
  bots: BotView[]
  requests: BotRequest[]
}

/** 桌面端与主机之间对远端目标机的桥接调用。 */
export type BotRemoteCall =
  | { kind: 'list_targets' }
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

/** 远端桥接调用的返回结果。 */
export type BotRemoteAnswer =
  | { ok: true; data: unknown }
  | { ok: false; code: 'offline' | 'not_found' | 'failed'; message: string }

/** 主进程监听到远端主机状态变化后推给本地 AgentHost 的事件。 */
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

/** 3 个开箱示例 Bot ID。 */
export const BOT_EXAMPLE_IDS = ['dev-manager', 'pr-reviewer', 'ci-oncall'] as const
export type BotExampleId = (typeof BOT_EXAMPLE_IDS)[number]

export interface BotExampleSpec {
  id: BotExampleId
  defaultHandle: string
  avatar: BotAvatar
  scope: PermissionScope
  limits: BotLimits
}

/** 开箱示例 Bot 配置（文案由本地化文件 bots.json 提供）。 */
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

/** 将用户输入的名称转为合法的默认代号。 */
export function slugifyBotHandle(input: string): string {
  const clean = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return clean && BOT_HANDLE_RE.test(clean) ? clean : 'bot'
}

/** 根据当前状态与工作台账推算 Bot 右下角状态角标（严格按优先级）。 */
export function computeBotStatus(
  bot: Pick<Bot, 'paused'>,
  counts: { needsYouCount: number; activeCount: number; mainRunning?: boolean },
): BotStatus {
  if (counts.needsYouCount > 0) return 'needs_you'
  if (counts.activeCount > 0 || counts.mainRunning) return 'running'
  if (bot.paused) return 'paused'
  return 'idle'
}

/** 补齐并校验局部 limits 配置。 */
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

/** 校验并补齐单条 BotCardFields（供线程校验和工具调用复用）。 */
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

/** 校验消息是否以 @handle 开头，若是则提取目标代号和剩余正文。 */
export function parseLeadingBotMention(text: string): { handle: string; body: string } | null {
  const match = text.match(/^@([a-z0-9][a-z0-9_-]{0,31})(?:\s+([\s\S]*))?$/i)
  if (!match) return null
  return {
    handle: match[1]!.toLowerCase(),
    body: (match[2] ?? '').trim(),
  }
}
