import type { PlanLimit } from '@shared/agent-host'
import { windowParts, type WindowKind, type WindowParts } from '@shared/plan-limits'

/** 单个窗口条目在组卡片中的标签展示模式 */
export type PlanLimitLabelMode = 'window' | 'scope' | 'full'

export interface PlanLimitItem {
  limit: PlanLimit
  parts: WindowParts
  /** window: 仅显示时间窗名（如 5-hour）；scope: 仅显示模型名（如 Opus）；full: 显示完整标签 */
  labelMode: PlanLimitLabelMode
}

export interface PlanLimitGroup {
  id: string
  /** solo: 唯一无标题主池；all: 与其他组并存时的通用主池；group: 按模型组/服务商聚合的独立组；scoped: 同周期的单模型限额集合 */
  kind: 'solo' | 'all' | 'group' | 'scoped'
  /** 仅 kind === 'group' 时直接展示的组名；其余类型由界面按多语言文案生成标题 */
  title: string | null
  /** 仅 kind === 'scoped' 时记录共享的窗口类型（如 seven_day），便于展示对应标题 */
  windowKind: WindowKind | null
  /** 该组是否为当前会话所选模型对应的受限组 */
  current: boolean
  /** 组内窗口声明覆盖的模型列表（已去重） */
  models: string[]
  items: PlanLimitItem[]
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 窗口时长排序权重：短窗口排左（前）、长窗口排右（后），未知或额外用量排最后 */
function windowSortOrder(parts: WindowParts): number {
  switch (parts.kind) {
    case 'minutes':
      return (parts.count ?? 1) * MINUTE
    case 'five_hour':
      return 5 * HOUR
    case 'hours':
      return (parts.count ?? 1) * HOUR
    case 'daily':
      return DAY
    case 'days':
      return (parts.count ?? 1) * DAY
    case 'seven_day':
      return 7 * DAY
    case 'monthly':
      return 30 * DAY
    case 'annual':
      return 365 * DAY
    default:
      return Number.POSITIVE_INFINITY
  }
}

/** 合并同组内所有窗口声明的模型名并去重，保持首次出现顺序 */
function collectModels(limits: readonly PlanLimit[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const limit of limits) {
    for (const model of limit.models ?? []) {
      const trimmed = model.trim()
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      out.push(trimmed)
    }
  }
  return out
}

interface ParsedEntry {
  limit: PlanLimit
  parts: WindowParts
  index: number
}

function sortEntries(entries: readonly ParsedEntry[]): ParsedEntry[] {
  return [...entries].sort(
    (a, b) => windowSortOrder(a.parts) - windowSortOrder(b.parts) || a.index - b.index,
  )
}

/**
 * 将套餐限额按模型组或服务商聚合为双轨卡片分组：
 * - 同模型组拥有多个窗口（如 Antigravity 的 Gemini Models / Claude and GPT models、Codex 附加池）各自独立成组；
 * - 同服务商窗口（如 OpenCode 的多 Provider）按服务商聚合；
 * - 只有单条窗口且共享同一周期的模型专属限额（如 Claude Code 的 Weekly · Opus / Sonnet）在存在主池时合并为单模型组；
 * - 仅有一个通用主池（如 Codex 经典的 5-hour + Weekly）时不显示冗余组标题；
 * - 若传入当前会话的 `holding` 限额，则仅将完整命中的专属/当前组标记为 `current` 并自动置顶。
 */
export function groupPlanLimits(
  limits: readonly PlanLimit[],
  holding?: readonly PlanLimit[],
): PlanLimitGroup[] {
  if (limits.length === 0) return []

  const parsed: ParsedEntry[] = limits.map((limit, index) => ({
    limit,
    parts: windowParts(limit),
    index,
  }))

  // 统计不带 provider 的各 scope 出现次数，区分多窗口模型组（如 Antigravity）与单窗口模型周限（如 Claude Opus/Sonnet）
  const scopeCounts = new Map<string, number>()
  for (const entry of parsed) {
    if (!entry.parts.provider && entry.parts.scope) {
      scopeCounts.set(entry.parts.scope, (scopeCounts.get(entry.parts.scope) ?? 0) + 1)
    }
  }

  const hasBase = parsed.some((entry) => !entry.parts.provider && !entry.parts.scope)
  const bucketOrder: string[] = []
  const buckets = new Map<
    string,
    {
      kind: 'all' | 'group' | 'scoped'
      title: string | null
      windowKind: WindowKind | null
      entries: ParsedEntry[]
    }
  >()

  const pushBucket = (
    key: string,
    meta: { kind: 'all' | 'group' | 'scoped'; title: string | null; windowKind: WindowKind | null },
    entry: ParsedEntry,
  ): void => {
    const existing = buckets.get(key)
    if (existing) {
      existing.entries.push(entry)
      return
    }
    bucketOrder.push(key)
    buckets.set(key, { ...meta, entries: [entry] })
  }

  for (const entry of parsed) {
    const { provider, scope, kind } = entry.parts
    if (provider) {
      // OpenCode 等多服务商场景：按 provider（若同时含模型范围则拼接范围）归组
      const title = scope ? `${provider} · ${scope}` : provider
      pushBucket(`provider:${title}`, { kind: 'group', title, windowKind: null }, entry)
      continue
    }
    if (!scope) {
      pushBucket('base', { kind: 'all', title: null, windowKind: null }, entry)
      continue
    }
    const multiWindowGroup = (scopeCounts.get(scope) ?? 0) > 1
    if (multiWindowGroup || (!hasBase && !kind)) {
      pushBucket(`scope:${scope}`, { kind: 'group', title: scope, windowKind: null }, entry)
      continue
    }
    if (hasBase && kind) {
      // 主池之外的单周期单模型限额（如 Claude Code 的 Weekly · Opus / Sonnet）按周期合并
      pushBucket(`scoped:${kind}`, { kind: 'scoped', title: null, windowKind: kind }, entry)
      continue
    }
    pushBucket(`scope:${scope}`, { kind: 'group', title: scope, windowKind: null }, entry)
  }

  const rawGroups = bucketOrder.map((key) => {
    const bucket = buckets.get(key)!
    const sorted = sortEntries(bucket.entries)
    const items: PlanLimitItem[] = sorted.map((entry) => {
      const labelMode: PlanLimitLabelMode =
        bucket.kind === 'group'
          ? entry.parts.kind
            ? 'window'
            : 'full'
          : bucket.kind === 'scoped'
            ? entry.parts.scope
              ? 'scope'
              : 'full'
            : entry.parts.kind && !entry.parts.scope
              ? 'window'
              : 'full'
      return { limit: entry.limit, parts: entry.parts, labelMode }
    })
    return {
      id: key,
      kind: bucket.kind,
      title: bucket.title,
      windowKind: bucket.windowKind,
      models: collectModels(sorted.map((entry) => entry.limit)),
      items,
    }
  })

  // 仅有一个通用主池时升级为 solo 模式，隐藏冗余的“All models”标题行
  const groups: PlanLimitGroup[] = rawGroups.map((group) => ({
    ...group,
    kind: rawGroups.length === 1 && group.kind === 'all' ? 'solo' : group.kind,
    current: false,
  }))

  // 结合当前会话模型的 holding 限额，定位当前活跃组并置顶
  if (holding && holding.length > 0 && groups.length > 1) {
    const holdingWindows = new Set(holding.map((limit) => limit.window))
    const fullMatches = groups.map(
      (group) =>
        group.items.length > 0 &&
        group.items.every((item) => holdingWindows.has(item.limit.window)),
    )
    const matchedCount = fullMatches.filter(Boolean).length
    if (matchedCount > 0 && matchedCount < groups.length) {
      groups.forEach((group, idx) => {
        group.current = fullMatches[idx]!
      })
      groups.sort((a, b) => Number(b.current) - Number(a.current))
    }
  }

  return groups
}
