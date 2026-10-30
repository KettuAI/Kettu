// The ACP v1 mapper: turns ACP messages into patches against Kettu's session model.
// Together with connection.ts, the only code that knows ACP types. Another protocol's mapper
// produces the same patches and effects, from session-updates.ts.

import type * as acp from '@agentclientprotocol/sdk/unstable'
import type { AgentAccount, PlanLimit } from '@shared/agent-host'
import type {
  Attachment,
  ConfigOption,
  ContentRef,
  EntryChanges,
  Patch,
  PendingPermission,
  PermissionKind,
  PlanItem,
  SlashCommand,
  ThreadEntry,
  ThreadState,
  TokenTotals,
  ToolContent,
  ToolEntry,
  ToolKind,
  UserContent,
} from '@shared/thread'
import type { ModelTokens } from '../connection'
import { currentLocale, t } from '../i18n'
import {
  firstUserMessage,
  mergeConfig,
  repeatsFirstMessage,
  SYNTHETIC_MODE_ID,
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

export function toLf(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

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

/** Appends parsed parts to user content, merging adjacent text. */
function appendContent(content: UserContent[], parts: readonly UserContent[]): UserContent[] {
  const out = [...content]
  for (const part of parts) {
    const last = out[out.length - 1]
    if (part.type === 'text' && last?.type === 'text') {
      out[out.length - 1] = { type: 'text', text: last.text + part.text }
    } else {
      out.push(part)
    }
  }
  return out
}

// Replayed attachments. Agents replay a user message's files and images in forms of their own, so
// the mapper turns those forms back into the attachment refs a sent message holds.

const FILE_LINK = /\[@([^\]]*)\]\(([^)]+)\)/g
const CONTEXT_AFTER = /^\s*<context ref="([^"]*)">[\s\S]*?<\/context>/
const CONTEXT_ONLY = /^\s*<context ref="([^"]*)">[\s\S]*?<\/context>\s*$/
const DATA_IMAGE = /^data:([^;,]+);base64,([\s\S]+)$/

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** A `file:` URI's last path segment, decoded, for a resource that carries no name. */
function fileBaseName(uri: string): string {
  const path = safeDecode(uri.replace(/^file:\/\//, ''))
  const name = path.slice(path.lastIndexOf('/') + 1)
  return name || path
}

/** Bytes a base64 payload holds, without decoding it. */
function base64Size(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor((data.length * 3) / 4) - padding
}

function replayedAttachment(
  entryId: string,
  index: number,
  fields: Omit<Attachment, 'id' | 'thumb' | 'blob'>,
): Attachment {
  return { id: `${entryId}:a${index}`, thumb: null, blob: null, ...fields }
}

function attachmentCount(content: readonly UserContent[]): number {
  let count = 0
  for (const item of content) {
    if (item.type === 'ref' && item.ref.kind === 'attachment') count++
  }
  return count
}

function imageCount(content: readonly UserContent[]): number {
  let count = 0
  for (const item of content) {
    if (
      item.type === 'ref' &&
      item.ref.kind === 'attachment' &&
      item.ref.attachment.type === 'image'
    )
      count++
  }
  return count
}

/** Widens the cut to the whole line when a removed form sits alone on it. */
function lineCut(text: string, start: number, end: number): { start: number; end: number } {
  let from = start
  let to = end
  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  if (/^[ \t]*$/.test(text.slice(lineStart, start))) {
    // The form takes its own line, and the line break that ended the one before goes with it.
    from = lineStart > 0 ? lineStart - 1 : 0
  }
  const lineEnd = text.indexOf('\n', end)
  if (lineEnd !== -1 && /^[ \t]*$/.test(text.slice(end, lineEnd))) to = lineEnd + 1
  return { start: from, end: to }
}

/**
 * Splits one replayed text block into the text that stays and the attachments it holds: a file
 * link, with the `<context>` block that follows it when the refs match, and a `data:` image link.
 * Anything else stays text, so a text that only looks like one of the forms is not lost.
 */
function parseReplayedText(
  text: string,
  entryId: string,
  existing: readonly UserContent[],
  out: Output,
): UserContent[] | null {
  const parts: UserContent[] = []
  let attachments = attachmentCount(existing)
  let images = imageCount(existing)
  let cursor = 0
  let found = false
  const push = (value: string): void => {
    if (value !== '') parts.push({ type: 'text', text: value })
  }
  FILE_LINK.lastIndex = 0
  for (let match = FILE_LINK.exec(text); match; match = FILE_LINK.exec(text)) {
    const [whole, label, uri] = match
    const start = match.index
    if (uri.startsWith('file:')) {
      const after = text.slice(start + whole.length)
      const context = CONTEXT_AFTER.exec(after)
      const embedded = context?.[1] === uri
      const end = embedded ? start + whole.length + context![0].length : start + whole.length
      const cut = lineCut(text, start, end)
      push(text.slice(cursor, cut.start))
      attachments++
      parts.push({
        type: 'ref',
        ref: {
          kind: 'attachment',
          attachment: replayedAttachment(entryId, attachments, {
            type: 'file',
            name: safeDecode(label) || fileBaseName(uri),
            uri,
            mimeType: null,
            size: null,
            sent: embedded ? 'embedded' : 'linked',
          }),
        },
      })
      cursor = cut.end
      found = true
      if (embedded) FILE_LINK.lastIndex = cut.end
      continue
    }
    const image = DATA_IMAGE.exec(uri)
    if (!image || !image[1]!.startsWith('image/')) continue
    const cut = lineCut(text, start, start + whole.length)
    push(text.slice(cursor, cut.start))
    attachments++
    const name =
      label.trim().toLowerCase() === 'image'
        ? t('content.image', { number: ++images })
        : safeDecode(label)
    const attachment = replayedAttachment(entryId, attachments, {
      type: 'image',
      name,
      uri: null,
      mimeType: image[1]!,
      size: base64Size(image[2]!),
      sent: 'image',
    })
    parts.push({ type: 'ref', ref: { kind: 'attachment', attachment } })
    out.effects.push({
      kind: 'replayImage',
      entryId,
      attachmentId: attachment.id,
      mimeType: image[1]!,
      data: image[2]!,
    })
    cursor = cut.end
    found = true
    FILE_LINK.lastIndex = cut.end
  }
  if (!found) return null
  push(text.slice(cursor))
  return parts
}

/** A replayed content block as attachment refs, or null when it is not one of those forms. */
function replayedBlock(
  block: acp.ContentBlock,
  entryId: string,
  existing: readonly UserContent[],
  out: Output,
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

/**
 * A chunk that is only a `<context>` block follows the link it belongs to in its own chunk, as
 * Claude Code replays one, and makes that linked file embedded.
 */
function upgradeContext(content: readonly UserContent[], text: string): UserContent[] | null {
  const context = CONTEXT_ONLY.exec(text)
  if (!context) return null
  const uri = context[1]!
  const index = content.length - 1
  const item = content[index]
  if (item?.type !== 'ref' || item.ref.kind !== 'attachment') return null
  const attachment = item.ref.attachment
  if (attachment.type !== 'file' || attachment.sent !== 'linked' || attachment.uri !== uri) {
    return null
  }
  const next = [...content]
  next[index] = {
    type: 'ref',
    ref: { kind: 'attachment', attachment: { ...attachment, sent: 'embedded' } },
  }
  return next
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

const RAW_INPUT_LIMIT = 64 * 1024

/** The command or input of a tool call as text: a command when there is one, else JSON. */
export function rawInputText(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'string') return toLf(raw)
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const command = (raw as Record<string, unknown>).command
    if (typeof command === 'string') return toLf(command)
    if (Array.isArray(command) && command.every((part) => typeof part === 'string')) {
      return command.join(' ')
    }
  }
  let json: string | undefined
  try {
    json = JSON.stringify(raw, null, 2)
  } catch {
    return undefined
  }
  if (json === undefined) return undefined
  return json.length > RAW_INPUT_LIMIT ? `${json.slice(0, RAW_INPUT_LIMIT)}\n…` : json
}

const DESCRIPTION_LIMIT = 200

/** What a command says it does, as one line: the `description` beside its input's `command`. */
function commandDescription(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const input = raw as Record<string, unknown>
  if (input.command === undefined) return undefined
  // Claude Code also accepts `command_description` since CLI 2.1.295, and forwards the key used.
  const description = input.description ?? input.command_description
  if (typeof description !== 'string') return undefined
  const line = [...description.replace(/\s+/g, ' ').trim()]
  if (line.length === 0) return undefined
  return line.length > DESCRIPTION_LIMIT
    ? `${line.slice(0, DESCRIPTION_LIMIT).join('').trimEnd()}…`
    : line.join('')
}

function toolOutput(content: readonly ToolContent[]): string {
  return content
    .map((item) => (item.type === 'markdown' ? item.markdown : ''))
    .filter((text) => text !== '')
    .join('\n')
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

function lastEntry(thread: ThreadState): ThreadEntry | undefined {
  const id = thread.order[thread.order.length - 1]
  return id === undefined ? undefined : thread.byId[id]
}

/** Closes thoughts that are still streaming once something else follows them. */
function closeThoughts(ctx: MapperContext, out: Output, except?: string): void {
  for (const [id, startedAt] of ctx.scope.thoughts) {
    if (id === except) continue
    ctx.scope.thoughts.delete(id)
    if (ctx.thread.byId[id]) {
      out.patches.push({
        op: 'entry.update',
        id,
        changes: { streaming: false, durationMs: Math.max(0, ctx.now - startedAt) },
      })
    }
  }
}

function addEntry(ctx: MapperContext, out: Output, entry: ThreadEntry): void {
  closeThoughts(ctx, out, entry.id)
  out.patches.push({ op: 'entry.add', entry })
}

function messageEntryId(
  ctx: MapperContext,
  kind: 'agent' | 'thought' | 'user',
  messageId: string | null | undefined,
): string | null {
  if (!messageId) return null
  const id = `m:${messageId}`
  const existing = ctx.thread.byId[id]
  // An agent may reuse one message id for a message's thought and its text.
  if (existing && existing.kind !== kind) return `m:${messageId}#${kind}`
  return id
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
      const appended =
        existing.kind === 'thought' && ctx.thoughtParts ? nextPart(existing.markdown, text) : text
      if (appended !== '') {
        out.patches.push({ op: 'entry.appendText', id: existing.id, text: appended })
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

/** A replayed part of a thought, with the blank line its live turns send between parts. */
function nextPart(thought: string, part: string): string {
  if (part === '' || thought === '' || thought.endsWith('\n') || /^\r?\n/.test(part)) return part
  return `\n\n${part}`
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

function toolEffects(
  out: Output,
  toolCallId: string,
  entryId: string,
  before: ToolEntry['status'] | null,
  after: ToolEntry,
): void {
  const active = (status: ToolEntry['status'] | null): boolean =>
    status !== null && status !== 'pending'
  const done = (status: ToolEntry['status'] | null): boolean =>
    status === 'completed' || status === 'failed' || status === 'cancelled'
  if (!active(before) && active(after.status)) {
    out.effects.push({
      kind: 'tool',
      phase: 'started',
      toolCallId,
      entryId,
      toolKind: after.toolKind,
      output: '',
    })
  }
  if (!done(before) && done(after.status)) {
    out.effects.push({
      kind: 'tool',
      phase: 'ended',
      toolCallId,
      entryId,
      toolKind: after.toolKind,
      output: toolOutput(after.content),
    })
  }
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

/** Labels of the plan-limit windows Claude Code names. */
export const WINDOW_LABELS: Readonly<Record<string, string>> = {
  five_hour: '5-hour',
  seven_day: 'Weekly',
  seven_day_opus: 'Weekly · Opus',
  seven_day_sonnet: 'Weekly · Sonnet',
  overage: 'Extra usage',
}

function windowLabel(window: string): string {
  if (WINDOW_LABELS[window]) return WINDOW_LABELS[window]
  const words = window
    .replace(/^seven_day_?/, 'weekly ')
    .replace(/_/g, ' ')
    .trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * One `_claude/rateLimit` value from `usage_update._meta`. Claude Code reports
 * `utilization` as a fraction (0.42 is 42%) and `resetsAt` in Unix seconds.
 */
export function mapRateLimit(value: unknown, now: number): PlanLimit | null {
  if (typeof value !== 'object' || value === null) return null
  const info = value as Record<string, unknown>
  const window = info.rateLimitType
  if (typeof window !== 'string' || window === '') return null
  const utilization =
    typeof info.utilization === 'number' && Number.isFinite(info.utilization)
      ? info.utilization
      : null
  const resets =
    typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt) ? info.resetsAt : null
  const status = info.status
  return {
    window,
    label: windowLabel(window),
    usedPercent:
      utilization === null ? null : Math.min(100, Math.max(0, Math.round(utilization * 1000) / 10)),
    // Seconds, as Claude Code sends; a value already in milliseconds is kept.
    resetsAt: resets === null ? null : resets < 1e12 ? resets * 1000 : resets,
    state: status === 'allowed_warning' ? 'warning' : status === 'rejected' ? 'reached' : 'ok',
    observedAt: now,
  }
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
