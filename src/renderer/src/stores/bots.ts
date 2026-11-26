// Bot 状态管理 Store：维护本机 Home Host 的 Bot 列表、跨电脑工作台账、目标电脑快照、
// 自定义头像 data URL 缓存以及对 bots.* RPC 的统一封装。

import { create } from 'zustand'
import type {
  BotAvatarMimeType,
  BotChanges,
  BotDraft,
  BotHostTarget,
  BotRequest,
  BotView,
} from '@shared/bots'
import { errorMessage, host } from '@renderer/lib/host'

interface BotsStore {
  byId: Record<string, BotView>
  requestsById: Record<string, BotRequest>
  targets: BotHostTarget[]
  /** 缓存自定义图片头像的 data URL（按 botId + file 缓存，避免重复跨进程读取）。 */
  avatars: Record<string, string>
  loaded: boolean
  error: string | null

  load(): Promise<void>
  refreshTargets(): Promise<BotHostTarget[]>
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
}

const loadingAvatars = new Set<string>()

export const useBotsStore = create<BotsStore>()((set, get) => ({
  byId: {},
  requestsById: {},
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
      set({ byId, requestsById, loaded: true, error: null })
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
      // 读取失败自动降级到字标显示
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
    set((state) => ({ requestsById: { ...state.requestsById, [request.id]: request } }))
  },
}))

/** 按名称与最近活跃度返回排序后的 Bot 列表。 */
export function sortedBots(byId: Record<string, BotView>): BotView[] {
  return Object.values(byId).sort(
    (a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt),
  )
}

/** 按 handle 查找指定 Bot（忽略大小写）。 */
export function botByHandle(byId: Record<string, BotView>, handle: string): BotView | null {
  const clean = handle.trim().toLowerCase()
  for (const bot of Object.values(byId)) {
    if (bot.handle === clean) return bot
  }
  return null
}

/** 返回某个 Bot 关联的全部工作台账，按更新时间倒序排列。 */
export function requestsOfBot(
  requestsById: Record<string, BotRequest>,
  botId: string,
): BotRequest[] {
  return Object.values(requestsById)
    .filter((req) => req.botId === botId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}
