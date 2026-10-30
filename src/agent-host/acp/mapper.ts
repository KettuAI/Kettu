// The ACP v1 mapper: turns ACP messages into patches against Kettu's session model.
// Together with connection.ts, the only code that knows ACP types. Another protocol's mapper
// produces the same patches and effects, from session-updates.ts.

import type * as acp from '@agentclientprotocol/sdk/unstable'
import type { AgentAccount } from '@shared/agent-host'
import type {
  ConfigOption,
  ContentRef,
  EntryChanges,
  Patch,
  PendingPermission,
  PermissionKind,
  PlanItem,
  SlashCommand,
  ThreadEntry,
  TokenTotals,
  ToolContent,
  ToolEntry,
  ToolKind,
  UserContent,
} from '@shared/thread'
import type { ModelTokens } from '../connection'
import { currentLocale, t } from '../i18n'
import {
  appendContent,
  attachmentCount,
  base64Size,
  fileBaseName,
  imageCount,
  parseReplayedText,
  replayedAttachment,
  upgradeContext,
} from '../replayed-content'
import {
  addEntry,
  commandDescription,
  firstUserMessage,
  lastEntry,
  mapRateLimit,
  mergeConfig,
  messageEntryId,
  rawInputText,
  repeatsFirstMessage,
  SYNTHETIC_MODE_ID,
  toLf,
  toolEffects,
  type MapperContext,
  type MapperEffect,
  type MapperOutput,
  type SubagentState,
} from '../session-updates'

/** Every `sessionUpdate` the SDK's unstable v1 schema accepts; others never reach the SDK. */
export const KNOWN_UPDATES: ReadonlySet<string> = new Set([
  'user_message_chunk',
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'plan_update',
  'plan_removed',
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'session_info_update',
  'usage_update',
  'notice',
  'compaction_update',
  'compaction_summary_chunk',
  'subagent_update',
  'session_message',
  'session_message_chunk',
])

// Content blocks.

/** The most base64 a sound or a clip keeps, so one block cannot swell the thread and its snapshots. */
export const CARRIED_DATA_LIMIT = 20 * 1024 * 1024

/** The file name a resource's URI ends in, if any. */
function uriName(uri: string): string | null {
  const last = URL.parse(uri)?.pathname.split('/').pop()
  if (!last) return null
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

/** A sound or a clip from its bytes, or named by its kind and size when it is larger than that. */
function carriedRef(
  kind: 'audio' | 'video',
  mimeType: string,
  data: string,
  name: string | null,
): ContentRef {
  const size = Buffer.byteLength(data, 'base64')
  if (data.length <= CARRIED_DATA_LIMIT) return { kind, mimeType, data, size, name }
  const megabytes = new Intl.NumberFormat(currentLocale(), {
    style: 'unit',
    unit: 'megabyte',
    unitDisplay: 'short',
    maximumFractionDigits: 0,
  }).format(size / 1_000_000)
  return {
    kind: 'unsupported',
    label: t(kind === 'audio' ? 'content.audioTooLarge' : 'content.videoTooLarge', {
      size: megabytes,
    }),
  }
}

export function contentRef(block: acp.ContentBlock): ContentRef {
  switch (block.type) {
    case 'image':
      return { kind: 'image', mimeType: block.mimeType, data: block.data }
    case 'resource_link':
      return { kind: 'link', uri: block.uri, name: block.title || block.name }
    case 'audio':
      return carriedRef('audio', block.mimeType, block.data, null)
    case 'resource': {
      const { resource } = block
      const kind = /^(audio|video)\//i.exec(resource.mimeType ?? '')?.[1]?.toLowerCase()
      if ('blob' in resource && resource.mimeType && (kind === 'audio' || kind === 'video')) {
        return carriedRef(kind, resource.mimeType, resource.blob, uriName(resource.uri))
      }
      return { kind: 'unsupported', label: t('content.resource', { uri: resource.uri }) }
    }
    case 'text':
      return { kind: 'unsupported', label: t('content.text') }
    default:
      return { kind: 'unsupported', label: t('content.unknown') }
  }
}

export function userContent(block: acp.ContentBlock): UserContent {
  return block.type === 'text'
    ? { type: 'text', text: block.text }
    : { type: 'ref', ref: contentRef(block) }
}

/** Appends a block to user content, merging adjacent text. */
function appendUserContent(content: UserContent[], block: acp.ContentBlock): UserContent[] {
  const next = userContent(block)
  const last = content[content.length - 1]
  if (next.type === 'text' && last?.type === 'text') {
    return [...content.slice(0, -1), { type: 'text', text: last.text + next.text }]
  }
  return [...content, next]
}

/** A replayed content block as attachment refs, or null when it is not one of those forms. */
export function replayedBlock(
  block: acp.ContentBlock,
  entryId: string,
  existing: readonly UserContent[],
  out: MapperOutput,
): UserContent[] | null {
  const index = attachmentCount(existing)
  if (block.type === 'image') {
    const attachment = replayedAttachment(entryId, index + 1, {
      type: 'image',
      name: t('content.image', { number: imageCount(existing) + 1 }),
      uri: block.uri ?? null,
      mimeType: block.mimeType,
      size: base64Size(block.data),
      sent: 'image',
    })
    out.effects.push({
      kind: 'replayImage',
      entryId,
      attachmentId: attachment.id,
      mimeType: block.mimeType,
      data: block.data,
    })
    return [{ type: 'ref', ref: { kind: 'attachment', attachment } }]
  }
  if (block.type === 'resource_link') {
    if (!block.uri.startsWith('file:')) return null
    return [
      {
        type: 'ref',
        ref: {
          kind: 'attachment',
          attachment: replayedAttachment(entryId, index + 1, {
            type: 'file',
            name: block.title || block.name,
            uri: block.uri,
            mimeType: block.mimeType ?? null,
            size: block.size ?? null,
            sent: 'linked',
          }),
        },
      },
    ]
  }
  if (block.type === 'resource') {
    const { uri, mimeType } = block.resource
    if (!uri.startsWith('file:')) return null
    const size =
      'text' in block.resource
        ? Buffer.byteLength(block.resource.text, 'utf8')
        : base64Size(block.resource.blob)
    return [
      {
        type: 'ref',
        ref: {
          kind: 'attachment',
          attachment: replayedAttachment(entryId, index + 1, {
            type: 'file',
            name: fileBaseName(uri),
            uri,
            mimeType: mimeType ?? null,
            size,
            sent: 'embedded',
          }),
        },
      },
    ]
  }
  return null
}

function blocksText(blocks: readonly acp.ContentBlock[]): string {
  return blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
}

export function toolContent(item: acp.ToolCallContent): ToolContent {
  switch (item.type) {
    case 'content':
      return item.content.type === 'text'
        ? { type: 'markdown', markdown: toLf(item.content.text) }
        : { type: 'ref', ref: contentRef(item.content) }
    case 'diff':
      return {
        type: 'diff',
        path: item.path,
        oldText: item.oldText == null ? null : toLf(item.oldText),
        newText: toLf(item.newText),
      }
    case 'terminal':
      // Cannot occur while the terminal capability is off; shown rather than dropped.
      return {
        type: 'ref',
        ref: { kind: 'unsupported', label: t('content.terminal', { id: item.terminalId }) },
      }
    default:
      return { type: 'ref', ref: { kind: 'unsupported', label: t('content.unknownTool') } }
  }
}

function toolLocations(locations: readonly acp.ToolCallLocation[]): ToolEntry['locations'] {
  return locations.map((location) =>
    location.line == null ? { path: location.path } : { path: location.path, line: location.line },
  )
}

const TOOL_KINDS: ReadonlySet<string> = new Set([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
])

function toolKind(kind: string | null | undefined): ToolKind {
  return kind && TOOL_KINDS.has(kind) ? (kind as ToolKind) : 'other'
}

// The mapper.

class Output implements MapperOutput {
  patches: Patch[] = []
  effects: MapperEffect[] = []
}

function mapMessageChunk(
  ctx: MapperContext,
  out: Output,
  kind: 'agent' | 'thought',
  chunk: acp.ContentChunk,
): void {
  const byId = messageEntryId(ctx, kind, chunk.messageId)
  const last = lastEntry(ctx.thread)
  const targetId = byId ?? (last?.kind === kind ? last.id : null)
  const existing = targetId ? ctx.thread.byId[targetId] : undefined
  const isText = chunk.content.type === 'text'
  const text = chunk.content.type === 'text' ? chunk.content.text : ''

  if (existing && existing.kind === kind) {
    if (isText) {
      if (text !== '') {
        out.patches.push({ op: 'entry.appendText', id: existing.id, text })
      }
    } else if (existing.kind === 'agent') {
      out.patches.push({
        op: 'entry.update',
        id: existing.id,
        changes: { attachments: [...existing.attachments, contentRef(chunk.content)] },
      })
    } else {
      out.effects.push({
        kind: 'ignored',
        variant: 'agent_thought_chunk',
        detail: `${chunk.content.type} content in a thought`,
      })
    }
    return
  }

  const id = targetId ?? ctx.nextId()
  const streaming = !ctx.replaying
  if (kind === 'agent') {
    addEntry(ctx, out, {
      kind: 'agent',
      id,
      markdown: text,
      attachments: isText ? [] : [contentRef(chunk.content)],
      streaming,
      ...(streaming ? { at: ctx.now } : {}),
    })
  } else {
    if (!isText) {
      out.effects.push({
        kind: 'ignored',
        variant: 'agent_thought_chunk',
        detail: `${chunk.content.type} content in a thought`,
      })
      return
    }
    addEntry(ctx, out, { kind: 'thought', id, markdown: text, streaming })
    if (streaming) ctx.scope.thoughts.set(id, ctx.now)
  }
}

function mapUserChunk(ctx: MapperContext, out: Output, chunk: acp.ContentChunk): void {
  // In a live turn the host already added the user entry when it sent the prompt.
  if (!ctx.replaying) return
  const byId = messageEntryId(ctx, 'user', chunk.messageId)
  const last = lastEntry(ctx.thread)
  const target = byId
    ? ctx.thread.byId[byId]
    : last?.kind === 'user' && !chunk.messageId
      ? last
      : undefined
  if (target?.kind === 'user') {
    const upgraded =
      chunk.content.type === 'text' ? upgradeContext(target.content, chunk.content.text) : null
    if (upgraded) {
      out.patches.push({ op: 'entry.update', id: target.id, changes: { content: upgraded } })
      return
    }
    const parts =
      chunk.content.type === 'text'
        ? parseReplayedText(chunk.content.text, target.id, target.content, out)
        : replayedBlock(chunk.content, target.id, target.content, out)
    out.patches.push({
      op: 'entry.update',
      id: target.id,
      changes: {
        content: parts
          ? appendContent(target.content, parts)
          : appendUserContent(target.content, chunk.content),
      },
    })
    return
  }
  // Each replayed user message starts a turn, which scopes "current" plans.
  ctx.scope.planId = null
  const id = byId ?? ctx.nextId()
  const parts =
    chunk.content.type === 'text'
      ? parseReplayedText(chunk.content.text, id, [], out)
      : replayedBlock(chunk.content, id, [], out)
  addEntry(ctx, out, {
    kind: 'user',
    id,
    content: parts ?? [userContent(chunk.content)],
  })
}

/**
 * Whether a tool call leaves work running once it ends: Claude Code's command with
 * `run_in_background`, or its Monitor tool, which watches in the background. Claude Code reports
 * when such work ends only to clients it renders terminals or AIR's async tasks for.
 */
function startsBackgroundWork(update: acp.ToolCallUpdate): boolean {
  const input = update.rawInput
  if (
    typeof input === 'object' &&
    input !== null &&
    (input as Record<string, unknown>).run_in_background === true &&
    typeof (input as Record<string, unknown>).command === 'string'
  ) {
    return true
  }
  const meta = update._meta as { claudeCode?: { toolName?: unknown } } | null | undefined
  return meta?.claudeCode?.toolName === 'Monitor'
}

/**
 * Applies a `tool_call` or `tool_call_update`: only the fields present change, and both
 * add the entry when it is new, since agents may announce a call twice or update it first.
 */
function mapToolCall(ctx: MapperContext, out: Output, update: acp.ToolCallUpdate): string {
  const id = `t:${update.toolCallId}`
  const existing = ctx.thread.byId[id]
  const changes: Partial<Omit<ToolEntry, 'kind' | 'id'>> = {}
  if (update.title != null) changes.title = update.title
  if (update.kind != null) changes.toolKind = toolKind(update.kind)
  if (update.status != null) changes.status = update.status
  if (update.content != null) changes.content = update.content.map(toolContent)
  if (update.locations != null) changes.locations = toolLocations(update.locations)
  const raw = rawInputText(update.rawInput)
  if (raw !== undefined) changes.rawInput = raw
  const description = commandDescription(update.rawInput)
  if (description !== undefined) changes.description = description
  if (!ctx.replaying && startsBackgroundWork(update)) out.effects.push({ kind: 'background' })

  if (existing?.kind === 'tool') {
    if (Object.keys(changes).length > 0) {
      out.patches.push({ op: 'entry.update', id, changes: changes as EntryChanges })
    }
    toolEffects(out, update.toolCallId, id, existing.status, { ...existing, ...changes })
    return id
  }
  const entry: ToolEntry = {
    kind: 'tool',
    id,
    title: changes.title ?? t('content.toolCall'),
    toolKind: changes.toolKind ?? 'other',
    status: changes.status ?? 'pending',
    content: changes.content ?? [],
    locations: changes.locations ?? [],
    permission: null,
    permissionResult: null,
    ...(raw !== undefined ? { rawInput: raw } : {}),
    ...(description !== undefined ? { description } : {}),
  }
  addEntry(ctx, out, entry)
  toolEffects(out, update.toolCallId, id, null, entry)
  return id
}

function mapPlan(ctx: MapperContext, out: Output, plan: acp.Plan): void {
  const items: PlanItem[] = plan.entries.map((entry) => ({
    content: entry.content,
    priority: entry.priority,
    status: entry.status,
  }))
  const current = ctx.scope.planId ? ctx.thread.byId[ctx.scope.planId] : undefined
  if (current?.kind === 'plan') {
    out.patches.push({ op: 'entry.update', id: current.id, changes: { items } })
    return
  }
  const id = ctx.nextId()
  ctx.scope.planId = id
  addEntry(ctx, out, { kind: 'plan', id, items })
}

const CONFIG_CATEGORIES: ReadonlySet<string> = new Set([
  'mode',
  'model',
  'model_config',
  'thought_level',
])

function mapConfigOption(option: acp.SessionConfigOption): ConfigOption | null {
  const category =
    option.category && CONFIG_CATEGORIES.has(option.category)
      ? (option.category as ConfigOption['category'])
      : 'other'
  const base = {
    id: option.id,
    name: option.name,
    ...(option.description ? { description: option.description } : {}),
    category,
  }
  if (option.type === 'boolean') return { ...base, type: 'boolean', value: option.currentValue }
  if (option.type === 'select') {
    const choices: NonNullable<ConfigOption['choices']> = []
    for (const item of option.options) {
      if ('group' in item) {
        for (const choice of item.options) {
          choices.push({
            value: choice.value,
            name: choice.name,
            ...(choice.description ? { description: choice.description } : {}),
            group: item.name,
          })
        }
      } else {
        choices.push({
          value: item.value,
          name: item.name,
          ...(item.description ? { description: item.description } : {}),
        })
      }
    }
    return { ...base, type: 'select', value: option.currentValue, choices }
  }
  return null
}

/**
 * Config options as Kettu shows them. Legacy `modes` become a synthetic `__mode`
 * select, unless a real option already covers the mode category.
 */
export function mapConfig(
  options: readonly acp.SessionConfigOption[] | null | undefined,
  modes: acp.SessionModeState | null | undefined,
): ConfigOption[] {
  const mapped = (options ?? []).map(mapConfigOption).filter((o): o is ConfigOption => o !== null)
  if (modes && modes.availableModes.length > 0 && !mapped.some((o) => o.category === 'mode')) {
    mapped.unshift({
      id: SYNTHETIC_MODE_ID,
      name: 'Mode',
      category: 'mode',
      type: 'select',
      value: modes.currentModeId,
      choices: modes.availableModes.map((mode) => ({
        value: mode.id,
        name: mode.name,
        ...(mode.description ? { description: mode.description } : {}),
      })),
    })
  }
  return mapped
}

function mapCommands(commands: readonly acp.AvailableCommand[]): SlashCommand[] {
  return commands.map((command) => ({
    name: command.name,
    description: command.description,
    ...(command.input?.hint ? { inputHint: command.input.hint } : {}),
  }))
}

function parseTime(value: string | null | undefined, fallback: number): number {
  if (!value) return fallback
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : fallback
}

/**
 * Whether a `usage_update` reports a request of the session's own thread: each request reports
 * the context it read, so one that repeats the last count asked the model nothing. claude-agent-acp
 * repeats it with each turn's result, which comes after the stopped work on a cancel and after the
 * wait of a turn held open for background subagents, and with each plan limit report; an agent
 * may also repeat the context's size between turns, as on a resume. Once the user has stopped the
 * turn, an update can come long after the request it counts, as OpenCode's single one at a turn's
 * end does, so none counts.
 */
function isRequest(ctx: MapperContext, used: number, rateLimit: boolean): boolean {
  if (ctx.replaying || ctx.cancelling || rateLimit) return false
  return used !== ctx.thread.session.usage?.used
}

const ACCOUNT_KINDS: ReadonlySet<string> = new Set([
  'account',
  'api_key',
  'external',
  'gateway',
  'none',
])

/** The `_auth/status_update` extension: `{ authStatus: { kind, label, account?: { email } } }`. */
export function mapAuthStatus(params: unknown): AgentAccount | null {
  if (typeof params !== 'object' || params === null) return null
  const status = (params as { authStatus?: unknown }).authStatus
  if (typeof status !== 'object' || status === null) return null
  const { kind, label, account } = status as Record<string, unknown>
  if (typeof kind !== 'string' || !ACCOUNT_KINDS.has(kind) || typeof label !== 'string') return null
  const email =
    typeof account === 'object' &&
    account !== null &&
    typeof (account as { email?: unknown }).email === 'string'
      ? (account as { email: string }).email
      : null
  return { kind: kind as AgentAccount['kind'], label, email }
}

export function mapTokenTotals(usage: acp.Usage | null | undefined): TokenTotals | null {
  if (!usage) return null
  return {
    total: usage.totalTokens,
    input: usage.inputTokens,
    output: usage.outputTokens,
    thought: usage.thoughtTokens ?? null,
    cacheRead: usage.cachedReadTokens ?? null,
    cacheWrite: usage.cachedWriteTokens ?? null,
  }
}

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

/**
 * `_meta.quota.model_usage` of a prompt response: the turn's tokens per model, the only counts
 * of Claude Code's that include its subagents. Claude Code names the cache write
 * `cachedWriteTokens`, Codex `cacheWriteInputTokens`.
 */
export function mapModelUsage(meta: unknown): ModelTokens[] {
  if (typeof meta !== 'object' || meta === null) return []
  const quota = (meta as { quota?: unknown }).quota
  if (typeof quota !== 'object' || quota === null) return []
  const list = (quota as { model_usage?: unknown }).model_usage
  if (!Array.isArray(list)) return []
  const models: ModelTokens[] = []
  for (const item of list as unknown[]) {
    if (typeof item !== 'object' || item === null) continue
    const { model, token_count: tokenCount } = item as Record<string, unknown>
    if (typeof model !== 'string' || typeof tokenCount !== 'object' || tokenCount === null) continue
    const fields = tokenCount as Record<string, unknown>
    const input = count(fields.inputTokens)
    const output = count(fields.outputTokens)
    if (input === null || output === null) continue
    const cacheRead = count(fields.cachedInputTokens)
    const cacheWrite = count(fields.cachedWriteTokens) ?? count(fields.cacheWriteInputTokens)
    models.push({
      model,
      tokens: {
        total: count(fields.totalTokens) ?? input + output + (cacheRead ?? 0) + (cacheWrite ?? 0),
        input,
        output,
        thought: count(fields.reasoningOutputTokens),
        cacheRead,
        cacheWrite,
      },
    })
  }
  return models
}

type CompactionStatus = Extract<ThreadEntry, { kind: 'compaction' }>['status']

const NOTICE_SEVERITIES: ReadonlySet<string> = new Set(['info', 'warning', 'error'])
const COMPACTION_STATUSES: ReadonlySet<string> = new Set([
  'in_progress',
  'completed',
  'failed',
  'cancelled',
])
function mapCompaction(ctx: MapperContext, out: Output, update: acp.CompactionUpdate): void {
  const id = `c:${update.compactionId}`
  const existing = ctx.thread.byId[id]
  const known = COMPACTION_STATUSES.has(update.status)
  const summary = update.summary != null ? blocksText(update.summary) : null
  const errorText = update.status === 'failed' && update.error ? update.error : null
  const status = known ? (update.status as CompactionStatus) : null
  if (existing?.kind === 'compaction') {
    const changes: { status?: CompactionStatus; summary?: string } = {}
    if (status) changes.status = status
    if (summary !== null) changes.summary = summary
    else if (errorText && existing.summary === '') changes.summary = errorText
    if (Object.keys(changes).length > 0) out.patches.push({ op: 'entry.update', id, changes })
    return
  }
  // An unknown status on a new compaction is shown as in progress until a known one arrives.
  addEntry(ctx, out, {
    kind: 'compaction',
    id,
    status: status ?? 'in_progress',
    summary: summary ?? errorText ?? '',
  })
}

function mapSubagentState(state: acp.StateUpdate | null | undefined): SubagentState | undefined {
  if (state === undefined) return undefined
  if (state === null) return { kind: 'cleared' }
  switch (state.state) {
    case 'running':
      return { kind: 'running' }
    case 'requires_action':
      return { kind: 'requires_action' }
    case 'idle': {
      const idle = state as acp.IdleStateUpdate & { error?: acp.Error | null }
      const stopReason = typeof idle.stopReason === 'string' ? idle.stopReason : null
      const error =
        stopReason === 'error'
          ? {
              message: idle.error?.message ?? t('session.subagent.failed'),
              ...(idle.error?.data !== undefined
                ? { detail: JSON.stringify(idle.error.data) }
                : {}),
            }
          : null
      return { kind: 'idle', stopReason, error, tokens: mapTokenTotals(idle.usage) }
    }
    default:
      return { kind: 'unknown' }
  }
}

function mapSessionMessage(
  ctx: MapperContext,
  out: Output,
  update: {
    messageId: string
    senderSessionId?: string | null
    content?: acp.ContentBlock[] | null
  },
  chunk: acp.ContentBlock | null,
): void {
  const id = `sm:${update.messageId}`
  const existing = ctx.thread.byId[id]
  const sender = update.senderSessionId ? ctx.sessionIdFor(update.senderSessionId) : undefined
  if (existing?.kind === 'session_message') {
    const changes: { content?: UserContent[]; senderId?: string | null } = {}
    if (chunk) changes.content = appendUserContent(existing.content, chunk)
    else if (update.content !== undefined) changes.content = (update.content ?? []).map(userContent)
    if (sender !== undefined) changes.senderId = sender
    if (Object.keys(changes).length > 0) out.patches.push({ op: 'entry.update', id, changes })
    return
  }
  addEntry(ctx, out, {
    kind: 'session_message',
    id,
    senderId: sender ?? null,
    content: chunk ? [userContent(chunk)] : (update.content ?? []).map(userContent),
  })
}

/** Maps one `session/update`. Unknown variants are ignored and reported as an effect. */
export function mapSessionUpdate(update: acp.SessionUpdate, ctx: MapperContext): MapperOutput {
  const out = new Output()
  switch (update.sessionUpdate) {
    case 'user_message_chunk':
      mapUserChunk(ctx, out, update)
      break
    case 'agent_message_chunk':
      mapMessageChunk(ctx, out, 'agent', update)
      break
    case 'agent_thought_chunk':
      mapMessageChunk(ctx, out, 'thought', update)
      break
    case 'tool_call':
      mapToolCall(ctx, out, update)
      break
    case 'tool_call_update':
      mapToolCall(ctx, out, update)
      break
    case 'plan':
      mapPlan(ctx, out, update)
      break
    case 'available_commands_update':
      out.patches.push({
        op: 'session.update',
        changes: { commands: mapCommands(update.availableCommands) },
      })
      break
    case 'config_option_update':
      out.patches.push({
        op: 'session.update',
        changes: {
          config: mergeConfig(ctx.thread.session.config, mapConfig(update.configOptions, null)),
        },
      })
      break
    case 'current_mode_update': {
      const config = ctx.thread.session.config
      const target =
        config.find((option) => option.id === SYNTHETIC_MODE_ID) ??
        config.find((option) => option.category === 'mode' && option.type === 'select')
      if (!target) {
        out.effects.push({
          kind: 'ignored',
          variant: update.sessionUpdate,
          detail: 'no mode option',
        })
        break
      }
      out.patches.push({
        op: 'session.update',
        changes: {
          config: config.map((option) =>
            option === target ? { ...option, value: update.currentModeId } : option,
          ),
        },
      })
      break
    }
    case 'session_info_update': {
      const changes: { title?: string | null; updatedAt: number } = {
        updatedAt: parseTime(update.updatedAt, ctx.now),
      }
      // A repeat of the first message is no title: the cut first line stays until the agent's own.
      if (
        update.title !== undefined &&
        (update.title === null || !repeatsFirstMessage(update.title, firstUserMessage(ctx.thread)))
      ) {
        changes.title = update.title
        out.effects.push({ kind: 'title', title: update.title })
      }
      out.patches.push({ op: 'session.update', changes })
      break
    }
    case 'usage_update': {
      const previous = ctx.thread.session.usage
      const rateLimit = update._meta?.['_claude/rateLimit']
      const request = isRequest(ctx, update.used, rateLimit !== undefined)
      const cache = request
        ? { lastRequestAt: ctx.now, ttl: previous?.cache?.ttl ?? null }
        : previous?.cache
      out.patches.push({
        op: 'session.update',
        changes: {
          usage: {
            used: update.used,
            size: update.size,
            cost: update.cost
              ? { amount: update.cost.amount, currency: update.cost.currency }
              : null,
            tokens: previous?.tokens ?? null,
            ...(cache ? { cache } : {}),
          },
        },
      })
      if (request) out.effects.push({ kind: 'request' })
      const limit = mapRateLimit(rateLimit, ctx.now)
      if (limit) out.effects.push({ kind: 'limit', limit })
      break
    }
    case 'notice':
      addEntry(ctx, out, {
        kind: 'notice',
        id: ctx.nextId(),
        severity: NOTICE_SEVERITIES.has(update.severity) ? (update.severity as 'info') : 'info',
        title: update.title,
        ...(update.description ? { description: update.description } : {}),
      })
      break
    case 'compaction_update':
      mapCompaction(ctx, out, update)
      break
    case 'compaction_summary_chunk': {
      const id = `c:${update.compactionId}`
      const text = update.content.type === 'text' ? update.content.text : ''
      if (ctx.thread.byId[id]?.kind === 'compaction') {
        if (text !== '') out.patches.push({ op: 'entry.appendText', id, text })
      } else {
        addEntry(ctx, out, { kind: 'compaction', id, status: 'in_progress', summary: text })
      }
      break
    }
    case 'subagent_update': {
      const effect: Extract<MapperEffect, { kind: 'subagent' }> = {
        kind: 'subagent',
        sessionId: update.sessionId,
      }
      if (update.title !== undefined) effect.title = update.title
      if (update.description !== undefined) effect.description = update.description
      if (update.capabilities !== undefined) effect.canCancel = update.capabilities?.cancel != null
      const state = mapSubagentState(update.state)
      if (state) effect.state = state
      out.effects.push(effect)
      break
    }
    case 'session_message':
      mapSessionMessage(ctx, out, update, null)
      break
    case 'session_message_chunk':
      mapSessionMessage(
        ctx,
        out,
        { messageId: update.messageId, senderSessionId: update.senderSessionId },
        update.content,
      )
      break
    default:
      out.effects.push({
        kind: 'ignored',
        variant: (update as { sessionUpdate: string }).sessionUpdate,
        detail: 'not shown by Kettu',
      })
  }
  return out
}

/**
 * The tool entry a permission request belongs to, added first if the thread has not
 * seen that tool call.
 */
export function mapPermissionToolCall(
  toolCall: acp.ToolCallUpdate,
  ctx: MapperContext,
): { entryId: string; output: MapperOutput } {
  const out = new Output()
  const entryId = mapToolCall(ctx, out, toolCall)
  return { entryId, output: out }
}

export function mapPermissionOptions(
  options: readonly acp.PermissionOption[],
): PendingPermission['options'] {
  return options.map((option) => ({
    id: option.optionId,
    name: option.name,
    kind: option.kind as PermissionKind,
  }))
}
