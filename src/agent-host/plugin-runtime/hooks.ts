// Kettu's own events as plugins hear of them. A plugin is woken by an event its manifest names and
// is sent it only if it holds the permission that event needs. Most events are only told. Two
// hooks may act, and both are held to a short deadline that Kettu never waits past: what a
// plugin attaches to a message before it goes, and the denial of a permission request.

import type { SessionSummary } from '@shared/agent-host'
import { PLUGIN_BEFORE_SEND_DEADLINE_MS } from '@shared/plugin-host'
import { PLUGIN_REF_LIMITS, type PluginMentionRef } from '@shared/plugin-refs'
import { PLUGIN_HOOK_EVENTS, type PluginHookEvent } from '@shared/plugins'
import { PLUGIN_VIEW_LIMITS } from '@shared/plugin-views'
import type { PermissionOption, ToolEntry, ToolKind } from '@shared/thread'
import type { PluginRefs } from './refs'
import { sessionInfo } from './sessions-api'

/** The most of a message a plugin is sent, cut at its end. */
export const HOOK_TEXT_CHARS = 100_000
/** What one plugin may attach to one message. */
export const ATTACH_ITEMS = 5
export const ATTACH_ITEM_CHARS = 16_000
export const ATTACH_TOTAL_CHARS = 32_000
export const DENIAL_REASON_CHARS = 500
const FACT_CHARS = 4_000
/** Events waiting for one plugin; past it the newest are dropped. */
const QUEUE_LIMIT = 100

export interface PluginAttachment {
  pluginId: string
  /** The plugin's title, as the thread names it. */
  plugin: string
  title?: string
  text: string
  /** Why a mentioned item could not be added, when it could not; `text` is then empty. */
  failed?: string
  /** What the plugin itself said of that failure, when it said something. */
  detail?: string
}

export interface PluginDenial {
  pluginId: string
  plugin: string
  reason: string
}

/** What a permission request asks for, as every agent's request shows it in its tool entry. */
export interface RequestFacts {
  /** The tool's title. */
  tool: string
  kind: ToolKind
  /** The command, for a request to run one. */
  command: string | null
  paths: string[]
}

const FAILURES: Readonly<Record<string, string>> = {
  timeout: 'it did not answer in time',
  unavailable: 'it was not available',
  disabled: 'it is turned off after crashing too often',
  crashed: 'it was stopped for passing a limit',
  not_found: 'it is no longer installed or no longer offers this item',
  too_large: 'the message already holds as much as plugins may add',
}

/** What the agent reads where a plugin attached to the user's message. */
export function attachmentText(item: PluginAttachment): string {
  if (item.failed !== undefined) {
    const why = FAILURES[item.failed] ?? 'it could not give it'
    return `[The plugin "${item.plugin}" could not add ${item.title ?? 'an item'} the user mentioned: ${why}.]`
  }
  return `[Added by the plugin "${item.plugin}"${item.title ? `: ${item.title}` : ''}]\n${item.text}`
}

/** The answer that refuses a request with the option that does, telling the agent who and why. */
export function denialAnswer(
  option: PermissionOption,
  denial: PluginDenial,
): { optionId: string; note?: string } {
  return option.note
    ? { optionId: option.id, note: `Denied by the plugin "${denial.plugin}": ${denial.reason}` }
    : { optionId: option.id }
}

/** The facts of a request from the tool entry it belongs to; undefined when it has none. */
export function requestFacts(tool: ToolEntry | undefined): RequestFacts {
  return {
    tool: tool?.title.slice(0, FACT_CHARS) ?? '',
    kind: tool?.toolKind ?? 'other',
    command:
      tool?.toolKind === 'execute' ? (tool.rawInput ?? tool.title).slice(0, FACT_CHARS) : null,
    paths: tool?.locations.map((location) => location.path.slice(0, FACT_CHARS)).slice(0, 20) ?? [],
  }
}

/** The plugin host, as the hooks use it. */
export interface HookClient {
  subscribers(event: string, permission: string): { id: string; permissions: readonly string[] }[]
  activate(pluginId: string, trigger: string): Promise<void>
  deliverEvent(pluginId: string, name: string, payload: unknown): Promise<void>
  hook(pluginId: string, name: string, payload: unknown): Promise<unknown[]>
}

export interface PluginHooksDeps {
  client: HookClient
  /** What the items the user mentioned add to a message. */
  refs: Pick<PluginRefs, 'content'>
  /** A plugin's title for the thread's lines; null when it is not installed. */
  title(pluginId: string): string | null
  log(level: 'info' | 'warn', message: string): void
}

const CONTENT = 'sessions.content'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class PluginHooks {
  private readonly queues = new Map<string, { tail: Promise<void>; pending: number }>()

  constructor(private readonly deps: PluginHooksDeps) {}

  /** Whether any plugin would be sent the event, so nothing is worked out when none would. */
  wants(event: PluginHookEvent): boolean {
    return this.deps.client.subscribers(event, PLUGIN_HOOK_EVENTS[event]).length > 0
  }

  /**
   * Tells the plugins that hold the event's permission, none of them waited for. `payload` is
   * what the permission shows, and `content` is added only for a plugin that may read the
   * conversation.
   */
  emit(
    event: PluginHookEvent,
    session: SessionSummary | null,
    payload: Record<string, unknown> = {},
    content: Record<string, unknown> = {},
  ): void {
    if (session && session.origin !== 'user') return
    const info = session ? { session: sessionInfo(session) } : {}
    for (const { id, permissions } of this.deps.client.subscribers(
      event,
      PLUGIN_HOOK_EVENTS[event],
    )) {
      this.enqueue(id, event, {
        ...info,
        ...payload,
        ...(permissions.includes(CONTENT) ? content : {}),
      })
    }
  }

  /**
   * What the plugins that hold `prompt.attach` attach to a message, ready in time or left out. A
   * plugin sees the message's text only with `sessions.content` and the session only with
   * `sessions.summary`.
   */
  async attachments(session: SessionSummary, text: string): Promise<PluginAttachment[]> {
    if (session.origin !== 'user') return []
    const asked = await this.ask('session.beforeSend', (permissions) => ({
      sessionId: session.id,
      ...(permissions.includes('sessions.summary') ? { session: sessionInfo(session) } : {}),
      ...(permissions.includes(CONTENT) ? { text: text.slice(0, HOOK_TEXT_CHARS) } : {}),
    }))
    const out: PluginAttachment[] = []
    for (const { id, answers } of asked) {
      const plugin = this.deps.title(id) ?? id
      let items = 0
      let chars = 0
      for (const answer of answers) {
        const list = isRecord(answer) && Array.isArray(answer.attach) ? answer.attach : []
        for (const item of list as unknown[]) {
          if (!isRecord(item) || typeof item.text !== 'string' || item.text.trim() === '') continue
          if (items >= ATTACH_ITEMS) break
          const given = item.text.slice(0, ATTACH_ITEM_CHARS)
          if (chars + given.length > ATTACH_TOTAL_CHARS) break
          items++
          chars += given.length
          const title =
            typeof item.title === 'string' && item.title.trim() !== ''
              ? item.title.trim().slice(0, 200)
              : undefined
          out.push({ pluginId: id, plugin, ...(title === undefined ? {} : { title }), text: given })
        }
      }
    }
    return out
  }

  /**
   * What the items the user mentioned add to the message, each read from its plugin within its
   * deadline. An item that could not be read, or that would take the message past what plugins may
   * add, is still listed, with why, so the message and the agent say it was left out.
   */
  async mentions(
    session: SessionSummary,
    mentioned: readonly PluginMentionRef[],
  ): Promise<PluginAttachment[]> {
    if (session.origin !== 'user') return []
    const read = await Promise.all(
      mentioned.slice(0, PLUGIN_REF_LIMITS.perMessage).map(async (ref) => ({
        ref,
        answer: await this.deps.refs.content(ref.pluginId, ref.source, ref.item),
      })),
    )
    let room: number = PLUGIN_REF_LIMITS.total
    return read.map(({ ref, answer }): PluginAttachment => {
      const base = {
        pluginId: ref.pluginId,
        plugin: this.deps.title(ref.pluginId) ?? ref.pluginId,
      }
      if (!answer.ok) {
        const { code } = answer.error
        const detail = answer.error.detail?.trim().slice(0, PLUGIN_VIEW_LIMITS.error)
        return { ...base, title: ref.name, text: '', failed: code, ...(detail ? { detail } : {}) }
      }
      const text = answer.content.text.slice(0, room)
      if (text === '') return { ...base, title: ref.name, text: '', failed: 'too_large' }
      room -= text.length
      return { ...base, title: answer.content.title ?? ref.name, text }
    })
  }

  /**
   * The first plugin that holds `requests.check` and denies the request in time. A plugin can
   * deny and nothing else: any other answer, an error or a late one passes the request on to the
   * user.
   */
  async check(session: SessionSummary, facts: RequestFacts): Promise<PluginDenial | null> {
    if (session.origin !== 'user') return null
    const asked = await this.ask('session.permissionRequested', (permissions) => ({
      sessionId: session.id,
      ...(permissions.includes('sessions.summary') ? { session: sessionInfo(session) } : {}),
      request: facts,
    }))
    for (const { id, answers } of asked) {
      for (const answer of answers) {
        const reason = isRecord(answer) && typeof answer.deny === 'string' ? answer.deny.trim() : ''
        if (reason === '') continue
        return {
          pluginId: id,
          plugin: this.deps.title(id) ?? id,
          reason: reason.slice(0, DENIAL_REASON_CHARS),
        }
      }
    }
    return null
  }

  /**
   * Asks every plugin that holds the event's permission, all at once, and returns what the ones
   * that answered within the deadline said. The deadline counts from here and includes loading a
   * plugin that was not loaded: that plugin is left out this time and answers the next.
   */
  private async ask(
    event: PluginHookEvent,
    payloadFor: (permissions: readonly string[]) => unknown,
  ): Promise<{ id: string; answers: unknown[] }[]> {
    const subscribers = this.deps.client.subscribers(event, PLUGIN_HOOK_EVENTS[event])
    if (subscribers.length === 0) return []
    let expired = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        expired = true
        resolve(null)
      }, PLUGIN_BEFORE_SEND_DEADLINE_MS)
    })
    const one = async ({
      id,
      permissions,
    }: {
      id: string
      permissions: readonly string[]
    }): Promise<{ id: string; answers: unknown[] } | null> => {
      try {
        await this.deps.client.activate(id, event)
        if (expired) return null
        return { id, answers: await this.deps.client.hook(id, event, payloadFor(permissions)) }
      } catch (error) {
        this.deps.log('warn', `${id} was skipped for ${event}: ${(error as Error).message}`)
        return null
      }
    }
    const answered = await Promise.all(
      subscribers.map(async (subscriber) => {
        const result = await Promise.race([one(subscriber), late])
        if (result === null && expired) {
          this.deps.log('warn', `${subscriber.id} did not answer ${event} in time and was skipped`)
        }
        return result
      }),
    )
    clearTimeout(timer)
    return answered.filter((result) => result !== null)
  }

  /**
   * Tells one plugin an event that `trigger` wakes it for, in the order it hears the others and
   * without waiting for it; used for what is not one of Kettu's own events, such as a channel's.
   */
  tell(pluginId: string, trigger: string, event: string, payload: unknown): void {
    this.enqueue(pluginId, event, payload, trigger)
  }

  /** One plugin hears its events in the order they happened. */
  private enqueue(pluginId: string, event: string, payload: unknown, trigger = event): void {
    const queue = this.queues.get(pluginId) ?? { tail: Promise.resolve(), pending: 0 }
    this.queues.set(pluginId, queue)
    if (queue.pending >= QUEUE_LIMIT) {
      this.deps.log('warn', `${pluginId} is too far behind and missed ${event}`)
      return
    }
    queue.pending++
    queue.tail = queue.tail.then(async () => {
      try {
        await this.deps.client.activate(pluginId, trigger)
        await this.deps.client.deliverEvent(pluginId, event, payload)
      } catch (error) {
        this.deps.log(
          'warn',
          `${pluginId} could not be told of ${event}: ${(error as Error).message}`,
        )
      } finally {
        queue.pending--
      }
    })
  }
}
