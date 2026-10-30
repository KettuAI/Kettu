// Turns `codex app-server` items and their deltas into the patches and effects the ACP mapper
// produces for the same work, so a Codex thread reads as it did through codex-acp.

import path from 'node:path'
import type {
  ContentRef,
  EntryChanges,
  PlanItem,
  TokenTotals,
  ToolContent,
  ToolEntry,
  UserContent,
} from '@shared/thread'
import {
  addEntry,
  messageEntryId,
  parseReplayedText,
  rawInputText,
  replayedBlock,
  toLf,
  toolEffects,
} from '../acp/mapper'
import { hasMessage, t } from '../i18n'
import {
  firstUserMessage,
  repeatsFirstMessage,
  type MapperContext,
  type MapperEffect,
  type MapperOutput,
} from '../session-updates'
import type {
  CommandAction,
  FileUpdateChange,
  ThreadItem,
  ThreadTokenUsage,
  TurnPlanStep,
  UserInput,
} from './protocol'

type Item<K extends ThreadItem['type']> = Extract<ThreadItem, { type: K }>
type ToolChanges = Partial<Omit<ToolEntry, 'kind' | 'id'>>

function output(): MapperOutput {
  return { patches: [], effects: [] }
}

/** Output a command printed, as one fenced block, its start cut once it grows past this. */
const OUTPUT_LIMIT = 64 * 1024

/** `/bin/zsh -lc 'ls -la'` as `ls -la`, the command Codex runs inside its shell. */
export function stripShellPrefix(command: string): string {
  const inner = command.replace(/^(?:\/bin\/)?(?:bash|zsh|sh)\s+(?:-[lc]+\s+)?/, '')
  return inner.length > 1 && inner.startsWith("'") && inner.endsWith("'")
    ? inner.slice(1, -1)
    : inner
}

/** `text` as one fenced block, with a fence longer than any it holds. */
export function fenced(text: string): string {
  let longest = 2
  for (const match of text.matchAll(/^\s*(`{3,})/gm)) longest = Math.max(longest, match[1]!.length)
  const fence = '`'.repeat(longest + 1)
  return `${fence}\n${text.replace(/\n$/, '')}\n${fence}`
}

function cut(text: string): string {
  return text.length > OUTPUT_LIMIT ? `…\n${text.slice(text.length - OUTPUT_LIMIT)}` : text
}

function toolStatus(status: string | null | undefined): ToolEntry['status'] {
  switch (status) {
    case 'completed':
      return 'completed'
    case 'failed':
    case 'declined':
      return 'failed'
    case 'interrupted':
      return 'cancelled'
    default:
      return 'in_progress'
  }
}

function absolute(cwd: string, file: string): string {
  return path.isAbsolute(file) ? file : path.resolve(cwd, file)
}

function searchTitle(query: string | null, where: string | null): string {
  if (query && where) return t('codex.tool.searchIn', { query, path: where })
  if (query) return t('codex.tool.search', { query })
  if (where) return t('codex.tool.searchPath', { path: where })
  return t('codex.tool.searchAll')
}

/** A command as codex-acp showed it: a file it reads, a search, a listing or a shell command. */
export function commandFacts(
  command: string,
  cwd: string,
  actions: readonly CommandAction[] | null | undefined,
): Pick<ToolEntry, 'title' | 'toolKind' | 'locations'> & { rawInput?: string } {
  const action = actions?.length === 1 ? actions[0]! : null
  switch (action?.type) {
    case 'read':
      return {
        title: t('codex.tool.readFile', { path: action.path }),
        toolKind: 'read',
        locations: [{ path: absolute(cwd, action.path) }],
      }
    case 'search':
      return { title: searchTitle(action.query, action.path), toolKind: 'search', locations: [] }
    case 'listFiles':
      return {
        title: action.path
          ? t('codex.tool.listFilesIn', { path: action.path })
          : t('codex.tool.listFiles'),
        toolKind: 'read',
        locations: [],
      }
    default: {
      const shown = toLf(action?.command ?? stripShellPrefix(command))
      return { title: shown, toolKind: 'execute', locations: [], rawInput: shown }
    }
  }
}

/** A unified diff's hunks as old and new text, or null when it has none. */
export function diffHunks(diff: string): { oldText: string; newText: string }[] | null {
  const hunks: { old: string[]; new: string[] }[] = []
  let hunk: { old: string[]; new: string[] } | null = null
  for (const line of toLf(diff).replace(/\n$/, '').split('\n')) {
    if (line.startsWith('@@')) {
      hunk = { old: [], new: [] }
      hunks.push(hunk)
      continue
    }
    if (!hunk || line.startsWith('\\')) continue
    const body = line.slice(1)
    if (line.startsWith('-')) hunk.old.push(body)
    else if (line.startsWith('+')) hunk.new.push(body)
    else if (line.startsWith(' ') || line === '') {
      hunk.old.push(body)
      hunk.new.push(body)
    }
  }
  if (hunks.length === 0) return null
  return hunks.map((h) => ({ oldText: h.old.join('\n'), newText: h.new.join('\n') }))
}

export function fileChangeContent(changes: readonly FileUpdateChange[]): ToolContent[] {
  return changes.flatMap((change): ToolContent[] => {
    const diff = toLf(change.diff)
    switch (change.kind.type) {
      case 'add':
        return [{ type: 'diff', path: change.path, oldText: null, newText: diff }]
      case 'delete':
        return [{ type: 'diff', path: change.path, oldText: diff, newText: '' }]
      default: {
        const target = change.kind.move_path ?? change.path
        const hunks = diffHunks(diff)
        if (!hunks) return [{ type: 'markdown', markdown: fenced(diff) }]
        return hunks.map((hunk) => ({ type: 'diff', path: target, ...hunk }))
      }
    }
  })
}

function changedPaths(changes: readonly FileUpdateChange[]): ToolEntry['locations'] {
  return changes.map((change) => ({
    path: change.kind.type === 'update' ? (change.kind.move_path ?? change.path) : change.path,
  }))
}

function webSearchFacts(item: Item<'webSearch'>): Pick<ToolEntry, 'title' | 'toolKind'> {
  const action = item.action
  if (action?.type === 'openPage' && action.url) {
    return { title: t('codex.tool.openPage', { url: action.url }), toolKind: 'fetch' }
  }
  if (action?.type === 'findInPage' && action.url) {
    return { title: t('codex.tool.findInPage', { url: action.url }), toolKind: 'fetch' }
  }
  const query = item.query || (action?.type === 'search' ? (action.query ?? '') : '')
  return {
    title: query ? t('codex.tool.webSearch', { query }) : t('codex.tool.webSearchAll'),
    toolKind: 'search',
  }
}

function agentToolTitle(tool: string): string {
  const key = `codex.tool.agent.${tool}`
  return hasMessage(key) ? t(key as 'codex.tool.agent.spawnAgent') : tool
}

function mcpContent(item: Item<'mcpToolCall'>): ToolContent[] {
  if (item.error) return [{ type: 'markdown', markdown: item.error.message }]
  const content: ToolContent[] = []
  for (const block of item.result?.content ?? []) {
    if (typeof block !== 'object' || block === null || Array.isArray(block)) continue
    const value = block as Record<string, unknown>
    if (value.type === 'text' && typeof value.text === 'string') {
      content.push({ type: 'markdown', markdown: value.text })
    } else if (
      value.type === 'image' &&
      typeof value.data === 'string' &&
      typeof value.mimeType === 'string'
    ) {
      content.push({
        type: 'ref',
        ref: { kind: 'image', mimeType: value.mimeType, data: value.data },
      })
    }
  }
  return content
}

function dynamicContent(item: Item<'dynamicToolCall'>): ToolContent[] {
  return (item.contentItems ?? []).flatMap((part): ToolContent[] =>
    part.type === 'inputText' ? [{ type: 'markdown', markdown: part.text }] : [],
  )
}

/** The thread ids of the subagents an item names. */
export function childThreads(item: ThreadItem): string[] {
  if (item.type === 'collabAgentToolCall') return item.receiverThreadIds
  if (item.type === 'subAgentActivity') return [item.agentThreadId]
  return []
}

/** One Codex thread's mapper: what Kettu shows of its items, live and replayed. */
export class ThreadMapper {
  /** What each running command printed so far. */
  private readonly outputs = new Map<string, string>()
  /** The part of a thought that streams now, by the thought's item id. */
  private readonly parts = new Map<string, string>()
  /** Thoughts with a summary, whose raw reasoning is not shown beside it. */
  private readonly summarized = new Set<string>()

  /** Maps one notification; null for one this mapper does not take. */
  notification(method: string, params: unknown, ctx: MapperContext): MapperOutput | null {
    const out = output()
    const p = params as Record<string, unknown>
    switch (method) {
      case 'item/started':
        this.item(ctx, out, p.item as ThreadItem, false)
        break
      case 'item/completed':
        this.item(ctx, out, p.item as ThreadItem, true)
        break
      case 'item/agentMessage/delta':
      case 'item/plan/delta':
        this.appendMessage(ctx, out, p.itemId as string, p.delta as string)
        break
      case 'item/reasoning/summaryPartAdded':
        this.startPart(p.itemId as string, `s${p.summaryIndex as number}`)
        this.summarized.add(p.itemId as string)
        break
      case 'item/reasoning/summaryTextDelta':
        this.summarized.add(p.itemId as string)
        this.appendThought(ctx, out, p.itemId as string, `s${p.summaryIndex as number}`, p.delta)
        break
      case 'item/reasoning/textDelta':
        if (!this.summarized.has(p.itemId as string)) {
          this.appendThought(ctx, out, p.itemId as string, `c${p.contentIndex as number}`, p.delta)
        }
        break
      case 'item/commandExecution/outputDelta':
        this.appendOutput(ctx, out, p.itemId as string, p.delta as string)
        break
      case 'item/fileChange/patchUpdated':
        this.updateTool(ctx, out, p.itemId as string, {
          content: fileChangeContent(p.changes as FileUpdateChange[]),
          locations: changedPaths(p.changes as FileUpdateChange[]),
        })
        break
      case 'turn/plan/updated':
        this.plan(ctx, out, p.plan as TurnPlanStep[])
        break
      case 'thread/tokenUsage/updated':
        this.usage(ctx, out, p.tokenUsage as ThreadTokenUsage)
        break
      case 'thread/name/updated':
        this.title(ctx, out, (p.threadName as string | null | undefined) ?? null)
        break
      case 'model/rerouted':
        addEntry(ctx, out, {
          kind: 'notice',
          id: ctx.nextId(),
          severity: 'info',
          title: t('codex.notice.rerouted', {
            from: p.fromModel as string,
            to: p.toModel as string,
          }),
        })
        break
      case 'warning':
        addEntry(ctx, out, {
          kind: 'notice',
          id: ctx.nextId(),
          severity: 'warning',
          title: String(p.message ?? ''),
        })
        break
      default:
        return null
    }
    return out
  }

  /** One item of the thread's history, as `session/load` replays one. */
  replay(item: ThreadItem, ctx: MapperContext): MapperOutput {
    const out = output()
    this.item(ctx, out, item, true)
    return out
  }

  /** A message Kettu writes as the agent's, such as the answer to a command. */
  say(ctx: MapperContext, markdown: string): MapperOutput {
    const out = output()
    addEntry(ctx, out, {
      kind: 'agent',
      id: ctx.nextId(),
      markdown,
      attachments: [],
      streaming: false,
      at: ctx.now,
    })
    return out
  }

  private item(ctx: MapperContext, out: MapperOutput, item: ThreadItem, done: boolean): void {
    switch (item.type) {
      case 'userMessage':
        // In a live turn the host already added the user entry, steered ones too.
        if (ctx.replaying && done) this.userMessage(ctx, out, item)
        break
      case 'agentMessage':
      case 'plan':
        this.message(ctx, out, item.id, item.text, done)
        break
      case 'reasoning':
        this.reasoning(ctx, out, item, done)
        break
      case 'commandExecution':
        this.command(ctx, out, item, done)
        break
      case 'fileChange':
        this.tool(ctx, out, item.id, {
          title: t('codex.tool.editFiles'),
          toolKind: 'edit',
          status: done ? toolStatus(item.status) : 'in_progress',
          content: fileChangeContent(item.changes),
          locations: changedPaths(item.changes),
        })
        break
      case 'mcpToolCall': {
        const raw = rawInputText(item.arguments)
        this.tool(ctx, out, item.id, {
          title: t('codex.tool.mcp', { server: item.server, tool: item.tool }),
          toolKind: 'other',
          status: done ? toolStatus(item.status) : 'in_progress',
          ...(done ? { content: mcpContent(item) } : {}),
          ...(raw !== undefined ? { rawInput: raw } : {}),
        })
        break
      }
      case 'dynamicToolCall': {
        const raw = rawInputText(item.arguments)
        this.tool(ctx, out, item.id, {
          title: item.tool,
          toolKind: 'other',
          status: done ? toolStatus(item.status) : 'in_progress',
          ...(done ? { content: dynamicContent(item) } : {}),
          ...(raw !== undefined ? { rawInput: raw } : {}),
        })
        break
      }
      case 'collabAgentToolCall':
        this.tool(ctx, out, item.id, {
          title: agentToolTitle(item.tool),
          toolKind: 'other',
          status: done ? toolStatus(item.status) : 'in_progress',
          ...(item.prompt ? { description: oneLine(item.prompt) } : {}),
        })
        for (const sessionId of item.receiverThreadIds) {
          out.effects.push({
            kind: 'subagent',
            sessionId,
            canCancel: true,
            ...(item.tool === 'spawnAgent' && item.prompt
              ? { description: oneLine(item.prompt) }
              : {}),
          })
        }
        break
      case 'subAgentActivity':
        out.effects.push({ kind: 'subagent', sessionId: item.agentThreadId, canCancel: true })
        break
      case 'webSearch':
        this.tool(ctx, out, item.id, {
          ...webSearchFacts(item),
          status: done ? 'completed' : 'in_progress',
        })
        break
      case 'imageView':
        this.tool(ctx, out, item.id, {
          title: t('codex.tool.viewImage', { path: item.path }),
          toolKind: 'read',
          status: done ? 'completed' : 'in_progress',
          locations: [{ path: item.path }],
        })
        break
      case 'imageGeneration':
        this.tool(ctx, out, item.id, {
          title: t('codex.tool.generateImage'),
          toolKind: 'other',
          status: done ? toolStatus(item.status) : 'in_progress',
          ...(item.revisedPrompt ? { description: oneLine(item.revisedPrompt) } : {}),
          ...(done && item.savedPath ? { locations: [{ path: item.savedPath }] } : {}),
        })
        break
      case 'contextCompaction':
        this.compaction(ctx, out, item.id, done)
        break
      case 'enteredReviewMode':
      case 'exitedReviewMode':
        // The review's findings follow as an agent message of their own.
        break
      default:
        out.effects.push({
          kind: 'ignored',
          variant: `item ${(item as { type: string }).type}`,
          detail: 'not shown by Kettu',
        })
    }
  }

  private userMessage(ctx: MapperContext, out: MapperOutput, item: Item<'userMessage'>): void {
    ctx.scope.planId = null
    const id = messageEntryId(ctx, 'user', item.id) ?? ctx.nextId()
    let content: UserContent[] = []
    for (const input of item.content)
      content = [...content, ...replayedInput(input, id, content, out)]
    addEntry(ctx, out, { kind: 'user', id, content })
  }

  private message(
    ctx: MapperContext,
    out: MapperOutput,
    itemId: string,
    text: string,
    done: boolean,
  ): void {
    const id = messageEntryId(ctx, 'agent', itemId)!
    const existing = ctx.thread.byId[id]
    if (existing?.kind === 'agent') {
      const changes: EntryChanges = {}
      if (done && text !== '' && existing.markdown !== text) {
        Object.assign(changes, { markdown: text })
      }
      if (done && existing.streaming) Object.assign(changes, { streaming: false })
      if (Object.keys(changes).length > 0) out.patches.push({ op: 'entry.update', id, changes })
      return
    }
    // A message starts empty, and a review's own messages never get past that.
    if (text === '') return
    const streaming = !ctx.replaying && !done
    addEntry(ctx, out, {
      kind: 'agent',
      id,
      markdown: text,
      attachments: [],
      streaming,
      ...(ctx.replaying ? {} : { at: ctx.now }),
    })
  }

  private appendMessage(
    ctx: MapperContext,
    out: MapperOutput,
    itemId: string,
    delta: string,
  ): void {
    if (!delta) return
    const id = messageEntryId(ctx, 'agent', itemId)!
    if (ctx.thread.byId[id]?.kind === 'agent') {
      out.patches.push({ op: 'entry.appendText', id, text: delta })
      return
    }
    this.message(ctx, out, itemId, delta, false)
  }

  private reasoning(
    ctx: MapperContext,
    out: MapperOutput,
    item: Item<'reasoning'>,
    done: boolean,
  ): void {
    const id = messageEntryId(ctx, 'thought', item.id)!
    const existing = ctx.thread.byId[id]
    const text = (item.summary.length > 0 ? item.summary : item.content).join('\n\n')
    if (existing?.kind === 'thought') {
      if (!done) return
      const startedAt = ctx.scope.thoughts.get(id)
      ctx.scope.thoughts.delete(id)
      const changes: EntryChanges = { streaming: false }
      if (text !== '' && existing.markdown !== text) Object.assign(changes, { markdown: text })
      if (startedAt !== undefined) {
        Object.assign(changes, { durationMs: Math.max(0, ctx.now - startedAt) })
      }
      out.patches.push({ op: 'entry.update', id, changes })
      this.parts.delete(item.id)
      this.summarized.delete(item.id)
      return
    }
    // A thought shows once it has text: Codex starts some that stay empty.
    if (text === '') return
    const streaming = !ctx.replaying && !done
    addEntry(ctx, out, { kind: 'thought', id, markdown: text, streaming })
    if (streaming) ctx.scope.thoughts.set(id, ctx.now)
  }

  private startPart(itemId: string, part: string): void {
    if (!this.parts.has(itemId)) this.parts.set(itemId, part)
  }

  private appendThought(
    ctx: MapperContext,
    out: MapperOutput,
    itemId: string,
    part: string,
    delta: unknown,
  ): void {
    if (typeof delta !== 'string' || delta === '') return
    const id = messageEntryId(ctx, 'thought', itemId)!
    const existing = ctx.thread.byId[id]
    const previous = this.parts.get(itemId)
    this.parts.set(itemId, part)
    if (existing?.kind !== 'thought') {
      addEntry(ctx, out, { kind: 'thought', id, markdown: delta, streaming: !ctx.replaying })
      if (!ctx.replaying) ctx.scope.thoughts.set(id, ctx.now)
      return
    }
    const gap = previous !== undefined && previous !== part && existing.markdown !== ''
    out.patches.push({ op: 'entry.appendText', id, text: gap ? `\n\n${delta}` : delta })
  }

  private command(
    ctx: MapperContext,
    out: MapperOutput,
    item: Item<'commandExecution'>,
    done: boolean,
  ): void {
    const facts = commandFacts(item.command, item.cwd, item.commandActions)
    const changes: ToolChanges = {
      ...facts,
      status: done ? toolStatus(item.status) : 'in_progress',
    }
    if (done) {
      const printed = item.aggregatedOutput ?? this.outputs.get(item.id) ?? ''
      this.outputs.delete(item.id)
      // codex-acp showed no output for a file Codex read, only the read.
      if (printed !== '' && facts.toolKind !== 'read') {
        changes.content = [{ type: 'markdown', markdown: fenced(cut(toLf(printed))) }]
      }
    }
    this.tool(ctx, out, item.id, changes)
  }

  private appendOutput(ctx: MapperContext, out: MapperOutput, itemId: string, delta: string): void {
    if (!delta) return
    const printed = cut((this.outputs.get(itemId) ?? '') + toLf(delta))
    this.outputs.set(itemId, printed)
    const entry = ctx.thread.byId[`t:${itemId}`]
    if (entry?.kind !== 'tool' || entry.toolKind === 'read') return
    out.patches.push({
      op: 'entry.update',
      id: entry.id,
      changes: { content: [{ type: 'markdown', markdown: fenced(printed) }] },
    })
  }

  /** Adds or updates the tool entry of item `itemId`; returns its entry id. */
  tool(ctx: MapperContext, out: MapperOutput, itemId: string, changes: ToolChanges): string {
    const id = `t:${itemId}`
    const existing = ctx.thread.byId[id]
    if (existing?.kind === 'tool') {
      const next: ToolChanges = {}
      for (const [key, value] of Object.entries(changes) as [keyof ToolChanges, unknown][]) {
        if (JSON.stringify(existing[key]) !== JSON.stringify(value)) {
          ;(next as Record<string, unknown>)[key] = value
        }
      }
      if (Object.keys(next).length > 0) {
        out.patches.push({ op: 'entry.update', id, changes: next as EntryChanges })
      }
      toolEffects(out, itemId, id, existing.status, { ...existing, ...next })
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
      ...(changes.rawInput !== undefined ? { rawInput: changes.rawInput } : {}),
      ...(changes.description !== undefined ? { description: changes.description } : {}),
    }
    addEntry(ctx, out, entry)
    toolEffects(out, itemId, id, null, entry)
    return id
  }

  private updateTool(
    ctx: MapperContext,
    out: MapperOutput,
    itemId: string,
    changes: ToolChanges,
  ): void {
    if (ctx.thread.byId[`t:${itemId}`]?.kind !== 'tool') return
    this.tool(ctx, out, itemId, changes)
  }

  private plan(ctx: MapperContext, out: MapperOutput, steps: readonly TurnPlanStep[]): void {
    const items: PlanItem[] = steps.map((step) => ({
      content: step.step,
      priority: 'medium',
      status:
        step.status === 'completed'
          ? 'completed'
          : step.status === 'inProgress'
            ? 'in_progress'
            : 'pending',
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

  private compaction(ctx: MapperContext, out: MapperOutput, itemId: string, done: boolean): void {
    const id = `c:${itemId}`
    const existing = ctx.thread.byId[id]
    const status = done ? 'completed' : 'in_progress'
    if (existing?.kind === 'compaction') {
      if (existing.status !== status) {
        out.patches.push({ op: 'entry.update', id, changes: { status } })
      }
      return
    }
    addEntry(ctx, out, { kind: 'compaction', id, status, summary: '' })
  }

  private usage(ctx: MapperContext, out: MapperOutput, usage: ThreadTokenUsage): void {
    const previous = ctx.thread.session.usage
    const used = usage.last.totalTokens
    const request = !ctx.replaying && !ctx.cancelling && used !== previous?.used
    const cache = request
      ? { lastRequestAt: ctx.now, ttl: previous?.cache?.ttl ?? null }
      : previous?.cache
    out.patches.push({
      op: 'session.update',
      changes: {
        usage: {
          used,
          size: usage.modelContextWindow ?? previous?.size ?? 0,
          cost: previous?.cost ?? null,
          tokens: previous?.tokens ?? null,
          ...(cache ? { cache } : {}),
        },
      },
    })
    if (request) out.effects.push({ kind: 'request' })
  }

  private title(ctx: MapperContext, out: MapperOutput, title: string | null): void {
    // A repeat of the first message is no title: the cut first line stays until a real one comes.
    if (title !== null && repeatsFirstMessage(title, firstUserMessage(ctx.thread))) return
    out.patches.push({ op: 'session.update', changes: { title, updatedAt: ctx.now } })
    out.effects.push({ kind: 'title', title })
  }
}

function oneLine(text: string): string {
  const line = [...text.replace(/\s+/g, ' ').trim()]
  return line.length > 200 ? `${line.slice(0, 200).join('').trimEnd()}…` : line.join('')
}

const DATA_URL = /^data:([^;,]+);base64,([\s\S]+)$/

/** One input of a replayed user message as the content a sent message holds. */
function replayedInput(
  input: UserInput,
  entryId: string,
  existing: readonly UserContent[],
  out: MapperOutput,
): UserContent[] {
  switch (input.type) {
    case 'text':
      return (
        parseReplayedText(input.text, entryId, existing, out) ?? [
          { type: 'text', text: input.text },
        ]
      )
    case 'image': {
      const data = 'url' in input ? DATA_URL.exec(input.url) : null
      if (data && data[1]!.startsWith('image/')) {
        return (
          replayedBlock(
            { type: 'image', mimeType: data[1]!, data: data[2]! },
            entryId,
            existing,
            out,
          ) ?? []
        )
      }
      const ref: ContentRef =
        'url' in input
          ? { kind: 'link', uri: input.url, name: input.url }
          : { kind: 'unsupported', label: t('content.unknown') }
      return [{ type: 'ref', ref }]
    }
    case 'localImage':
    case 'mention': {
      const uri = `file://${input.path}`
      const name = input.type === 'mention' ? input.name : path.basename(input.path)
      return (
        replayedBlock({ type: 'resource_link', uri, name }, entryId, existing, out) ?? [
          { type: 'ref', ref: { kind: 'link', uri, name } },
        ]
      )
    }
    default:
      return [{ type: 'ref', ref: { kind: 'unsupported', label: input.type } }]
  }
}

/** The subagent state a child thread's turn reports to its parent. */
export function childTurnEffect(
  childId: string,
  turn: { status: string; error: { message: string } | null } | null,
  tokens: TokenTotals | null,
): MapperEffect {
  if (!turn) return { kind: 'subagent', sessionId: childId, state: { kind: 'running' } }
  const stopReason =
    turn.status === 'interrupted' ? 'cancelled' : turn.status === 'failed' ? 'error' : 'end_turn'
  return {
    kind: 'subagent',
    sessionId: childId,
    state: {
      kind: 'idle',
      stopReason,
      error:
        turn.status === 'failed'
          ? { message: turn.error?.message ?? t('session.subagent.failed') }
          : null,
      tokens,
    },
  }
}
