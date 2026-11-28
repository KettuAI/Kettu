// Renderer Zustand store for Kettu Bots: manages local Home Host Bots, cross-computer work
// ledger, target host snapshots, installed plugin Bot channels, custom avatar cache,
// and bots.* RPC wrappers.

import { create } from 'zustand'
import type {
  BotAvatarMimeType,
  BotChannelBinding,
  BotChannelConfig,
  BotChannelView,
  BotChanges,
  BotDraft,
  BotHostTarget,
  BotPairingCode,
  BotRequest,
  BotView,
} from '@shared/bots'
import { errorMessage, host } from '@renderer/lib/host'

interface BotsStore {
  byId: Record<string, BotView>
  requestsById: Record<string, BotRequest>
  channels: BotChannelView[]
  targets: BotHostTarget[]
  /** Cached custom image avatar data URLs keyed by `${botId}:${file}`. */
  avatars: Record<string, string>
  loaded: boolean
  error: string | null

  load(): Promise<void>
  refreshTargets(): Promise<BotHostTarget[]>
  refreshChannels(): Promise<BotChannelView[]>
  create(draft: BotDraft): Promise<BotView>
  update(botId: string, changes: BotChanges): Promise<BotView>
  remove(botId: string, keepSessions?: boolean): Promise<void>
  setPaused(botId: string, paused: boolean): Promise<BotView>
  resetMain(botId: string): Promise<BotView>
  sendMain(
    botId: string,
    text: string,
    options?: { sourceSessionId?: string; sourceHostId?: string | null },
  ): Promise<{ sessionId: string; bot: BotView }>
  dispatch(params: {
    botId: string
    targetHostId: string | null
    projectPath: string
    title: string
    prompt: string
    agentId?: BotView['agentId']
    model?: string | null
    worktree?: boolean
  }): Promise<BotRequest>
  retryPending(requestId: string): Promise<BotRequest>
  cancelRequest(requestId: string): Promise<BotRequest>
  archiveDone(botId: string): Promise<number>
  detachSession(sessionId: string): Promise<boolean>
  configureChannel(channelKey: string, config: Partial<BotChannelConfig>): Promise<BotChannelView>
  bindChannel(
    botId: string,
    channelKey: string,
    binding: Partial<BotChannelBinding>,
  ): Promise<BotView>
  testChannel(channelKey: string): Promise<{ ok: boolean; label?: string; error?: string }>
  startPairing(channelKey: string): Promise<BotPairingCode>
  uploadAvatar(
    botId: string,
    mimeType: BotAvatarMimeType,
    dataBase64: string,
    crop?: { x: number; y: number; scale: number },
  ): Promise<BotView>
  ensureAvatarLoaded(botId: string, fileKey: string): Promise<void>
  handoff(params: {
    botId: string
    sessionId: string
    text: string
    contextSummary?: string
  }): Promise<{ botSessionId: string; entryId: string }>

  receiveBot(bot: BotView): void
  receiveRemoved(botId: string): void
  receiveRequest(request: BotRequest): void
  receiveChannels(channels: BotChannelView[]): void
}

const loadingAvatars = new Set<string>()

export const useBotsStore = create<BotsStore>()((set, get) => ({
  byId: {},
  requestsById: {},
  channels: [],
  targets: [],
  avatars: {},
  loaded: false,
  error: null,

  async load() {
    try {
      const list = await host('bots.list', undefined)
      const byId: Record<string, BotView> = {}
      for (const bot of list.bots) byId[bot.id] = bot
      const requestsById: Record<string, BotRequest> = {}
      for (const req of list.requests) requestsById[req.id] = req
      set({
        byId,
        requestsById,
        channels: list.channels ?? [],
        loaded: true,
        error: null,
      })
    } catch (error) {
      set({ error: errorMessage(error), loaded: true })
    }
  },

  async refreshTargets() {
    try {
      const res = await host('bots.listTargets', undefined)
      set({ targets: res.targets })
      return res.targets
    } catch {
      return get().targets
    }
  },

  async refreshChannels() {
    try {
      const channels = await host('bots.channelsList', undefined)
      set({ channels })
      return channels
    } catch {
      return get().channels
    }
  },

  async create(draft) {
    const bot = await host('bots.create', draft)
    get().receiveBot(bot)
    return bot
  },

  async update(botId, changes) {
    const bot = await host('bots.update', { botId, changes })
    get().receiveBot(bot)
    return bot
  },

  async remove(botId, keepSessions = true) {
    await host('bots.delete', { botId, keepSessions })
    get().receiveRemoved(botId)
  },

  async setPaused(botId, paused) {
    const bot = await host('bots.setPaused', { botId, paused })
    get().receiveBot(bot)
    return bot
  },

  async resetMain(botId) {
    const bot = await host('bots.resetMain', { botId })
    get().receiveBot(bot)
    return bot
  },

  async sendMain(botId, text, options) {
    const res = await host('bots.sendMain', {
      botId,
      text,
      ...(options?.sourceSessionId ? { sourceSessionId: options.sourceSessionId } : {}),
      ...(options?.sourceHostId !== undefined ? { sourceHostId: options.sourceHostId } : {}),
    })
    get().receiveBot(res.bot)
    return res
  },

  async dispatch(params) {
    const req = await host('bots.dispatch', params)
    get().receiveRequest(req)
    return req
  },

  async retryPending(requestId) {
    const req = await host('bots.retryPending', { requestId })
    get().receiveRequest(req)
    return req
  },

  async cancelRequest(requestId) {
    const req = await host('bots.cancelRequest', { requestId })
    get().receiveRequest(req)
    return req
  },

  async archiveDone(botId) {
    const res = await host('bots.archiveDone', { botId })
    await get().load()
    return res.archived
  },

  async detachSession(sessionId) {
    const res = await host('bots.detachSession', { sessionId })
    await get().load()
    return res.ok
  },

  async configureChannel(channelKey, config) {
    const updated = await host('bots.channelConfigure', { channelKey, config })
    set((state) => {
      const exists = state.channels.some((c) => c.channelKey === updated.channelKey)
      return {
        channels: exists
          ? state.channels.map((c) => (c.channelKey === updated.channelKey ? updated : c))
          : [...state.channels, updated],
      }
    })
    return updated
  },

  async bindChannel(botId, channelKey, binding) {
    const bot = await host('bots.channelBind', { botId, channelKey, binding })
    get().receiveBot(bot)
    return bot
  },

  async testChannel(channelKey) {
    return host('bots.channelTest', { channelKey })
  },

  async startPairing(channelKey) {
    return host('bots.channelPairStart', { channelKey })
  },

  async uploadAvatar(botId, mimeType, dataBase64, crop) {
    const bot = await host('bots.uploadAvatar', { botId, mimeType, dataBase64, crop })
    get().receiveBot(bot)
    if (bot.avatar.kind === 'image') {
      const cacheKey = `${bot.id}:${bot.avatar.file}`
      const dataUrl = dataBase64.startsWith('data:')
        ? dataBase64
        : `data:${mimeType};base64,${dataBase64}`
      set((state) => ({ avatars: { ...state.avatars, [cacheKey]: dataUrl } }))
    }
    return bot
  },

  async ensureAvatarLoaded(botId, fileKey) {
    const cacheKey = `${botId}:${fileKey}`
    if (get().avatars[cacheKey] || loadingAvatars.has(cacheKey)) return
    loadingAvatars.add(cacheKey)
    try {
      const res = await host('bots.readAvatar', { botId })
      if (res?.dataUrl) {
        set((state) => ({ avatars: { ...state.avatars, [cacheKey]: res.dataUrl } }))
      }
    } catch {
      // Ignore missing avatar file; BotAvatar falls back to monogram/initial.
    } finally {
      loadingAvatars.delete(cacheKey)
    }
  },

  async handoff(params) {
    return host('bots.handoff', params)
  },

  receiveBot(bot) {
    set((state) => ({ byId: { ...state.byId, [bot.id]: bot } }))
  },

  receiveRemoved(botId) {
    set((state) => {
      const byId = { ...state.byId }
      delete byId[botId]
      const requestsById = Object.fromEntries(
        Object.entries(state.requestsById).filter(([, req]) => req.botId !== botId),
      )
      return { byId, requestsById }
    })
  },

  receiveRequest(request) {
    set((state) => ({
      requestsById: { ...state.requestsById, [request.id]: request },
    }))
  },

  receiveChannels(channels) {
    set({ channels })
  },
}))

/** Returns Bots sorted by priority: needs_you > running > idle > paused, then name. */
export function sortedBots(byId: Record<string, BotView>): BotView[] {
  const rank = { needs_you: 0, running: 1, idle: 2, paused: 3 } as const
  return Object.values(byId).sort((a, b) => {
    const r = rank[a.status] - rank[b.status]
    if (r !== 0) return r
    return (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt)
  })
}

/** Finds a Bot by its lowercase handle. */
export function botByHandle(byId: Record<string, BotView>, handle: string): BotView | null {
  const lower = handle.toLowerCase()
  return Object.values(byId).find((bot) => bot.handle === lower) ?? null
}

/** Lists requests belonging to one Bot, newest first. */
export function requestsOfBot(
  requestsById: Record<string, BotRequest>,
  botId: string,
): BotRequest[] {
  return Object.values(requestsById)
    .filter((req) => req.botId === botId)
    .sort((a, b) => b.createdAt - a.createdAt)
}

/** Whether a given Bot accepts traffic from an installed plugin Bot channel. */
export function isBotBoundToChannel(bot: BotView, channel: BotChannelView): boolean {
  const binding = bot.channels?.[channel.channelKey]
  if (binding) return binding.enabled
  return channel.config.defaultBotId === bot.id
}
