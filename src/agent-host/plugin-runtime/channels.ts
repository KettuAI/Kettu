// Kettu's notices as the channels of plugins hear of them. A notice goes where the user sent its
// kind, after Kettu's own has gone: a plugin hears of it as an event that waits in the plugin's
// queue and is held to the call's time limit, so a slow or stuck script never delays anything. A
// notice's own words name the session and what it says, so a plugin without `sessions.content`
// hears only a plain title for the kind. A channel whose plugin may relay answers is told what a
// permission request asks for, with the session's title, and only a request told this way can be
// answered from it: nobody should allow what they were not shown.

import type { HostToMain } from '@shared/host-control'
import {
  noticeKindOf,
  PLUGIN_CHANNEL_LIMITS,
  PLUGIN_RELAY_DECISIONS,
  type PermissionRelay,
  type PluginChannelNotice,
  type PluginNoticeKind,
  type PluginRelayDecision,
} from '@shared/plugin-channels'
import type { ChannelRoute } from '../plugins/service'
import type { PluginApiCall } from './call'
import type { RequestFacts } from './hooks'

type Notice = Extract<HostToMain, { type: 'host:attention' }>

/** How many requests one plugin may be told of at once; the oldest are forgotten past it. */
const TOLD_LIMIT = 200
const CONTENT = 'sessions.content'
const ANSWER = 'requests.answer'

/** A request a notice told a plugin of, and the two answers a relay may give it. */
interface Told {
  sessionId: string
  allow: string
  deny: string
}

export interface PluginChannelsDeps {
  /** The channels of the plugins that are on, with the kinds the user sends to each. */
  routes(): ChannelRoute[]
  /** Tells a plugin its channel's notice, in order with what else it is told. */
  deliver(pluginId: string, channel: string, notice: PluginChannelNotice): void
  /**
   * Answers a request that waits for the user, with one of its options, by the way the user's
   * own click does; throws when the request no longer waits or is not a plain permission request.
   */
  relay(sessionId: string, requestId: string, optionId: string, relay: PermissionRelay): void
  /** A plugin's title for the thread's lines; null when it is not installed. */
  title(pluginId: string): string | null
  /** What a kind is called when the notice's own words are not for the plugin to read. */
  plain(kind: PluginNoticeKind): string
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** A notice says nothing of a conversation when no session is behind it. */
function tellsNothingOfConversation(notice: Notice): boolean {
  return notice.kind === 'routine-paused' || (notice.kind === 'plan-limit' && !notice.sessionId)
}

export class PluginChannels {
  private readonly told = new Map<string, Map<string, Told>>()

  constructor(private readonly deps: PluginChannelsDeps) {}

  /**
   * Tells the channels the notice's kind was sent to. Never waits for one. `facts` is what a
   * permission request asks for: a plugin that may relay answers is told it, and only it can then
   * answer that request.
   */
  notice(message: Notice, facts?: RequestFacts): void {
    const kind = noticeKindOf(message.kind)
    const asked =
      facts && message.kind === 'permission' && message.request?.allow && message.request.deny
        ? {
            sessionId: message.sessionId,
            id: message.request.id,
            allow: message.request.allow.optionId,
            deny: message.request.deny.optionId,
            facts,
          }
        : null
    for (const route of this.deps.routes()) {
      if (!route.kinds.includes(kind)) continue
      const relays = asked !== null && route.permissions.includes(ANSWER)
      const words = route.permissions.includes(CONTENT) || tellsNothingOfConversation(message)
      const notice: PluginChannelNotice = {
        channel: route.channel,
        kind,
        title:
          words || relays
            ? clip(message.title, PLUGIN_CHANNEL_LIMITS.noticeTitle)
            : this.deps.plain(kind),
      }
      if (words) notice.text = clip(message.body, PLUGIN_CHANNEL_LIMITS.noticeText)
      if (asked && relays) {
        notice.request = {
          id: asked.id,
          tool: asked.facts.tool,
          kind: asked.facts.kind,
          command: asked.facts.command,
          paths: asked.facts.paths,
        }
        this.remember(route.pluginId, asked.id, asked)
      }
      this.deps.deliver(route.pluginId, route.channel, notice)
    }
  }

  /**
   * Relays the user's answer to a request one of the plugin's channels told it of: allow once or
   * deny, never anything wider. A request that was never told to this plugin, or whose kind the
   * user no longer sends to a channel of it, is refused, and so is one that no longer waits.
   */
  answer(
    pluginId: string,
    request: string,
    decision: PluginRelayDecision,
    from: string | null,
  ): void {
    const told = this.told.get(pluginId)?.get(request)
    const sent = this.deps
      .routes()
      .some((route) => route.pluginId === pluginId && route.kinds.includes('permission'))
    if (!told || !sent) {
      throw new Error(
        'This plugin was not told of that request. It can answer only a request that a notice ' +
          'of a channel the user sends permission requests to told it of.',
      )
    }
    const plugin = this.deps.title(pluginId) ?? pluginId
    this.deps.relay(told.sessionId, request, decision === 'allow_once' ? told.allow : told.deny, {
      pluginId,
      plugin,
      // Naming the plugin as the place of the answer says nothing the line does not already.
      from: from?.toLowerCase() === plugin.toLowerCase() ? null : from,
    })
    this.told.get(pluginId)?.delete(request)
  }

  /** A plugin was removed or turned off: what it was told of is forgotten. */
  forget(pluginId: string): void {
    this.told.delete(pluginId)
  }

  private remember(pluginId: string, requestId: string, told: Told): void {
    const list = this.told.get(pluginId) ?? new Map<string, Told>()
    this.told.set(pluginId, list)
    list.set(requestId, told)
    while (list.size > TOLD_LIMIT) list.delete(list.keys().next().value!)
  }
}

/** The plugin API's call that relays an answer, with `PLUGIN_RELAY_DECISIONS` for its decision. */
export function relayCall(channels: Pick<PluginChannels, 'answer'>): PluginApiCall {
  return {
    permission: ANSWER,
    run: ({ pluginId }, [input]) => {
      const o = input ?? {}
      if (typeof o !== 'object' || Array.isArray(o))
        throw new Error('The options must be an object')
      for (const key of Object.keys(o)) {
        if (!['request', 'decision', 'from'].includes(key)) {
          throw new Error(`The options have no ${key.slice(0, 100)}`)
        }
      }
      const { request, decision, from } = o as Record<string, unknown>
      if (typeof request !== 'string' || request === '' || request.length > 200) {
        throw new Error('request must be the id a notice gave, as text')
      }
      if (!(PLUGIN_RELAY_DECISIONS as readonly unknown[]).includes(decision)) {
        throw new Error('decision must be allow_once or deny; an answer is never relayed as always')
      }
      if (
        from !== undefined &&
        (typeof from !== 'string' || from.trim() === '' || from.length > PLUGIN_CHANNEL_LIMITS.from)
      ) {
        throw new Error(`from must be text of 1 to ${PLUGIN_CHANNEL_LIMITS.from} characters`)
      }
      channels.answer(
        pluginId,
        request,
        decision as PluginRelayDecision,
        typeof from === 'string' ? from.trim() : null,
      )
      return { request, decision }
    },
  }
}
