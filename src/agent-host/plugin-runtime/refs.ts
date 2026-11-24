// Asking a plugin's script about what a mention source offers, what a mentioned item adds to a
// message, and what card a link shows: the host wakes the plugin for the source or the link, asks
// its listeners within a deadline Kettu never waits past, checks the answer against the format and
// gives either the data or why there is none. Nothing here throws for what a plugin does.

import {
  linkTrigger,
  matchLink,
  mentionTrigger,
  PLUGIN_MENTION_CONTENT_DEADLINE_MS,
  PLUGIN_REF_DEADLINE_MS,
  PLUGIN_REF_LIMITS,
  type PluginLinkCardRequest,
  type PluginLinkResult,
  type PluginMentionContent,
  type PluginMentionContentRequest,
  type PluginMentionResult,
  type PluginMentionSearchRequest,
  type PluginRefSource,
} from '@shared/plugin-refs'
import type { PluginViewError } from '@shared/plugin-views'
import type { PluginDeadline, PluginHookReply } from '@shared/plugin-host'
import { parseLinkCard, parseMentionContent, parseMentionItems } from './ref-data'
import { cut, failure, silence } from './views'
import { ViewDataError } from './view-data'

/** The plugin host, as the references use it. */
export interface RefsClient {
  activate(pluginId: string, trigger: string): Promise<void>
  hookReply(
    pluginId: string,
    name: string,
    payload: unknown,
    deadline?: PluginDeadline,
  ): Promise<PluginHookReply>
}

export interface PluginRefsDeps {
  client: RefsClient
  /** What a plugin that is on and has a script declares; null for any other. */
  source(pluginId: string): PluginRefSource | null
  locale(): string
  log(level: 'info' | 'warn', message: string): void
  /** How long any answer is waited for, in place of the format's own deadlines; for tests. */
  deadlineMs?: number
}

type Asked = { ok: true; answer: unknown } | { ok: false; error: PluginViewError }

const NO_ANSWER = 'No listener gave an answer'

export type PluginMentionContentResult =
  { ok: true; content: PluginMentionContent } | { ok: false; error: PluginViewError }

export class PluginRefs {
  constructor(private readonly deps: PluginRefsDeps) {}

  /** The items a source of a plugin offers for what the user typed after the `@`. */
  async search(pluginId: string, sourceId: string, query: string): Promise<PluginMentionResult> {
    if (!this.deps.source(pluginId)?.mentions.some((source) => source.id === sourceId)) {
      return { ok: false, error: { code: 'not_found' } }
    }
    const request: PluginMentionSearchRequest = {
      source: sourceId,
      query: query.slice(0, PLUGIN_REF_LIMITS.query),
      locale: this.deps.locale(),
    }
    const asked = await this.ask(
      pluginId,
      mentionTrigger(sourceId),
      'mention.search',
      request,
      this.deps.deadlineMs ?? PLUGIN_REF_DEADLINE_MS,
    )
    if (!asked.ok) return asked
    try {
      const { items, truncated } = parseMentionItems(asked.answer)
      return { ok: true, items, ...(truncated ? { truncated: true as const } : {}) }
    } catch (error) {
      return this.invalid(pluginId, 'mention.search', error)
    }
  }

  /** What the item the user chose adds to the message that is being sent. */
  async content(
    pluginId: string,
    sourceId: string,
    item: string,
  ): Promise<PluginMentionContentResult> {
    if (!this.deps.source(pluginId)?.mentions.some((source) => source.id === sourceId)) {
      return { ok: false, error: { code: 'not_found' } }
    }
    const request: PluginMentionContentRequest = {
      source: sourceId,
      item,
      locale: this.deps.locale(),
    }
    const asked = await this.ask(
      pluginId,
      mentionTrigger(sourceId),
      'mention.content',
      request,
      this.deps.deadlineMs ?? PLUGIN_MENTION_CONTENT_DEADLINE_MS,
    )
    if (!asked.ok) return asked
    try {
      return { ok: true, content: parseMentionContent(asked.answer) }
    } catch (error) {
      return this.invalid(pluginId, 'mention.content', error)
    }
  }

  /**
   * The card of a link. The host works out for itself which kind of link of the plugin names the
   * address, whatever a window thinks, and tells the script what the pattern matched.
   */
  async card(pluginId: string, linkId: string, url: string): Promise<PluginLinkResult> {
    const source = this.deps.source(pluginId)
    const link = source?.links.find((item) => item.id === linkId)
    const found = link ? matchLink([link], url) : null
    if (!found) return { ok: false, error: { code: 'not_found' } }
    const request: PluginLinkCardRequest = {
      link: linkId,
      url,
      match: found.match,
      locale: this.deps.locale(),
    }
    const asked = await this.ask(
      pluginId,
      linkTrigger(linkId),
      'link.card',
      request,
      this.deps.deadlineMs ?? PLUGIN_REF_DEADLINE_MS,
    )
    if (!asked.ok) return asked
    try {
      return { ok: true, card: parseLinkCard(asked.answer) }
    } catch (error) {
      return this.invalid(pluginId, 'link.card', error)
    }
  }

  private invalid(
    pluginId: string,
    event: string,
    error: unknown,
  ): { ok: false; error: PluginViewError } {
    if (!(error instanceof ViewDataError)) throw error
    this.deps.log('warn', `${pluginId} answered ${event} badly: ${error.message}`)
    return { ok: false, error: { code: 'invalid', detail: cut(error.message) } }
  }

  /** The first answer a listener gave, or why there is none, within `deadlineMs` of now. */
  private async ask(
    pluginId: string,
    trigger: string,
    event: string,
    payload: unknown,
    deadlineMs: number,
  ): Promise<Asked> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<Asked>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, error: { code: 'timeout' } }), deadlineMs)
    })
    const run = (async (): Promise<Asked> => {
      try {
        await this.deps.client.activate(pluginId, trigger)
        const reply = await this.deps.client.hookReply(pluginId, event, payload, 'call')
        const answer = reply.answers.find((item) => item !== null && item !== undefined)
        return answer === undefined
          ? { ok: false, error: silence(reply, NO_ANSWER) }
          : { ok: true, answer }
      } catch (error) {
        return { ok: false, error: failure(error) }
      }
    })()
    const result = await Promise.race([run, late])
    clearTimeout(timer)
    if (!result.ok) {
      const { code, detail } = result.error
      this.deps.log(
        'warn',
        `${pluginId} did not answer ${event}: ${code}${detail ? `: ${detail}` : ''}`,
      )
    }
    return result
  }
}
