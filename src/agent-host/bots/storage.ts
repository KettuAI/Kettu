// Local persistence for Bots: each Bot gets its own folder (bot.json, ROLE.md, avatar and
// empty isolated workspace); the dispatch ledger lives in <userDataPath>/state/bots-requests.json.

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  BOT_AVATAR_MAX_BYTES,
  BOT_AVATAR_MIME_TYPES,
  BOT_DESCRIPTION_CHARS,
  BOT_NAME_CHARS,
  BOT_ROLE_CHARS,
  DEFAULT_BOT_LIMITS,
  isBotAvatar,
  isBotHandle,
  isBotLimits,
  isBotTargetRef,
  normalizeBotChannels,
  normalizeBotLimits,
  type Bot,
  type BotAvatarMimeType,
  type BotRequest,
} from '@shared/bots'
import { isAgentId } from '@shared/agents'
import { isPermissionScope } from '@shared/routines'
import { writeFileAtomic, type LogFn } from '../storage'

/** Bot ID validation pattern preventing path traversal. */
export const BOT_ID_RE = /^bot-[a-z0-9]{6,24}$/

const AVATAR_EXT: Record<BotAvatarMimeType, string> = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
}

const MIME_BY_EXT: Record<string, BotAvatarMimeType> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
}

/** Single Bot record persisted on disk. */
export interface StoredBot {
  bot: Bot
  roleMarkdown: string
}

/** On-disk dispatch ledger envelope. */
interface RequestsEnvelope {
  version: 1
  requests: BotRequest[]
}

const MAX_STORED_REQUESTS = 500

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function parseBotJson(raw: unknown): Bot | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (
    typeof o.id !== 'string' ||
    !BOT_ID_RE.test(o.id) ||
    typeof o.name !== 'string' ||
    o.name.length === 0 ||
    o.name.length > BOT_NAME_CHARS ||
    !isBotHandle(o.handle) ||
    !isAgentId(o.agentId)
  ) {
    return null
  }
  const description =
    typeof o.description === 'string' ? o.description.slice(0, BOT_DESCRIPTION_CHARS) : ''
  const avatar = isBotAvatar(o.avatar)
    ? o.avatar
    : { kind: 'preset' as const, preset: 'architect' as const, palette: 'fox' as const }
  const targets = Array.isArray(o.targets) ? o.targets.filter(isBotTargetRef) : []
  const scope = isPermissionScope(o.scope) ? o.scope : { level: 'edit' as const, web: true }
  const limits = isBotLimits(o.limits) ? o.limits : normalizeBotLimits(DEFAULT_BOT_LIMITS)
  const channels = normalizeBotChannels(o.channels)
  const createdAt =
    typeof o.createdAt === 'number' && Number.isFinite(o.createdAt) ? o.createdAt : 0
  const updatedAt =
    typeof o.updatedAt === 'number' && Number.isFinite(o.updatedAt) ? o.updatedAt : createdAt
  return {
    id: o.id,
    name: o.name,
    handle: o.handle,
    description,
    avatar,
    agentId: o.agentId,
    model: typeof o.model === 'string' && o.model.length > 0 ? o.model : null,
    effort: typeof o.effort === 'string' && o.effort.length > 0 ? o.effort : null,
    targets,
    scope,
    limits,
    ...(Object.keys(channels).length > 0 ? { channels } : {}),
    paused: o.paused === true,
    mainSessionId: typeof o.mainSessionId === 'string' ? o.mainSessionId : null,
    createdAt,
    updatedAt,
  }
}

function parseRequest(raw: unknown): BotRequest | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (
    typeof o.id !== 'string' ||
    typeof o.botId !== 'string' ||
    !BOT_ID_RE.test(o.botId) ||
    typeof o.title !== 'string' ||
    typeof o.prompt !== 'string' ||
    typeof o.projectPath !== 'string' ||
    typeof o.projectName !== 'string' ||
    !isAgentId(o.agentId) ||
    typeof o.status !== 'string'
  ) {
    return null
  }
  const source =
    typeof o.source === 'object' && o.source !== null
      ? (o.source as BotRequest['source'])
      : { kind: 'main' as const }
  const platform =
    o.targetPlatform === 'darwin' || o.targetPlatform === 'win32' || o.targetPlatform === 'linux'
      ? o.targetPlatform
      : 'darwin'
  const scope = isPermissionScope(o.scope) ? o.scope : { level: 'edit' as const, web: true }
  return {
    id: o.id,
    botId: o.botId,
    title: o.title,
    prompt: o.prompt,
    source,
    targetHostId: typeof o.targetHostId === 'string' ? o.targetHostId : null,
    targetHostName: typeof o.targetHostName === 'string' ? o.targetHostName : 'This computer',
    targetPlatform: platform,
    projectPath: o.projectPath,
    projectName: o.projectName,
    agentId: o.agentId,
    model: typeof o.model === 'string' ? o.model : null,
    scope,
    worktree: o.worktree === true,
    branch: typeof o.branch === 'string' ? o.branch : null,
    sessionId: typeof o.sessionId === 'string' ? o.sessionId : null,
    status: o.status as BotRequest['status'],
    summary: typeof o.summary === 'string' ? o.summary : null,
    error: typeof o.error === 'string' ? o.error : null,
    dedupKey: typeof o.dedupKey === 'string' ? o.dedupKey : null,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
    startedAt: typeof o.startedAt === 'number' ? o.startedAt : null,
    endedAt: typeof o.endedAt === 'number' ? o.endedAt : null,
    archivedAt: typeof o.archivedAt === 'number' ? o.archivedAt : null,
  }
}

/** File-backed storage for Bot configs, ROLE.md files, avatars, and dispatch ledger. */
export class BotStorage {
  readonly botsRoot: string
  readonly requestsFile: string

  constructor(
    userDataPath: string,
    private readonly log: LogFn,
  ) {
    this.botsRoot = path.join(userDataPath, 'bots')
    this.requestsFile = path.join(userDataPath, 'state', 'bots-requests.json')
  }

  /** Directory holding a single Bot's files. */
  botDir(botId: string): string {
    if (!BOT_ID_RE.test(botId)) throw new Error(`Invalid botId: ${botId}`)
    return path.join(this.botsRoot, botId)
  }

  /** Physically isolated empty workspace directory for the Bot's main conversation. */
  workspaceDir(botId: string): string {
    return path.join(this.botDir(botId), 'workspace')
  }

  /** Ensures the Bot's isolated empty workspace exists. */
  async ensureWorkspace(botId: string): Promise<string> {
    const dir = this.workspaceDir(botId)
    await mkdir(dir, { recursive: true })
    return dir
  }

  /** Loads all persisted Bots and their ROLE.md files from disk. */
  async loadAllBots(): Promise<StoredBot[]> {
    let entries: string[]
    try {
      entries = await readdir(this.botsRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const result: StoredBot[] = []
    for (const entry of entries) {
      if (!BOT_ID_RE.test(entry)) continue
      const dir = path.join(this.botsRoot, entry)
      const jsonText = await readText(path.join(dir, 'bot.json'))
      if (!jsonText) continue
      try {
        const parsed = parseBotJson(JSON.parse(jsonText))
        if (!parsed) {
          this.log('warn', `Skipping malformed bot config in ${entry}`)
          continue
        }
        const roleText = (await readText(path.join(dir, 'ROLE.md'))) ?? ''
        result.push({ bot: parsed, roleMarkdown: roleText.slice(0, BOT_ROLE_CHARS) })
      } catch (error) {
        this.log('warn', `Could not read bot ${entry}: ${(error as Error).message}`)
      }
    }
    return result.sort((a, b) => a.bot.createdAt - b.bot.createdAt)
  }

  /** Atomically writes bot.json and ROLE.md and ensures the isolated workspace exists. */
  async saveBot(bot: Bot, roleMarkdown: string): Promise<void> {
    const dir = this.botDir(bot.id)
    await mkdir(this.workspaceDir(bot.id), { recursive: true })
    await writeFileAtomic(path.join(dir, 'bot.json'), `${JSON.stringify(bot, null, 2)}\n`)
    await writeFileAtomic(path.join(dir, 'ROLE.md'), roleMarkdown)
  }

  /** Removes a Bot's directory on disk (session retention is handled by BotManager). */
  async deleteBotDir(botId: string): Promise<void> {
    await rm(this.botDir(botId), { recursive: true, force: true })
  }

  /** Saves an uploaded custom avatar after validating MIME type and <= 64 KB limit. */
  async saveAvatar(
    botId: string,
    mimeType: BotAvatarMimeType,
    dataBase64: string,
  ): Promise<string> {
    if (!(BOT_AVATAR_MIME_TYPES as readonly string[]).includes(mimeType)) {
      throw new Error('Unsupported avatar image format')
    }
    const clean = dataBase64.replace(/^data:[^;]+;base64,/, '')
    const bytes = Buffer.from(clean, 'base64')
    if (bytes.byteLength === 0 || bytes.byteLength > BOT_AVATAR_MAX_BYTES) {
      throw new Error(`Avatar image must be between 1 byte and ${BOT_AVATAR_MAX_BYTES} bytes`)
    }
    const dir = this.botDir(botId)
    await mkdir(dir, { recursive: true })
    const fileName = `avatar.${AVATAR_EXT[mimeType]}`
    const target = path.join(dir, fileName)
    await writeFile(target, bytes)
    // Remove stale avatar files left behind under other extensions.
    for (const ext of Object.values(AVATAR_EXT)) {
      const other = `avatar.${ext}`
      if (other !== fileName) {
        await rm(path.join(dir, other), { force: true }).catch(() => {})
      }
    }
    return fileName
  }

  /** Reads a local custom avatar image as a data URL for renderer display. */
  async readAvatarDataUrl(botId: string, fileName: string): Promise<string | null> {
    if (!/^[a-z0-9._-]+$/i.test(fileName)) return null
    const ext = path.extname(fileName).toLowerCase()
    const mime = MIME_BY_EXT[ext]
    if (!mime) return null
    try {
      const bytes = await readFile(path.join(this.botDir(botId), fileName))
      if (bytes.byteLength === 0 || bytes.byteLength > BOT_AVATAR_MAX_BYTES * 2) return null
      return `data:${mime};base64,${bytes.toString('base64')}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  /** Loads the Home Host local dispatch ledger and offline pending queue. */
  async loadRequests(): Promise<BotRequest[]> {
    const text = await readText(this.requestsFile)
    if (!text) return []
    try {
      const parsed = JSON.parse(text) as Partial<RequestsEnvelope>
      if (!Array.isArray(parsed.requests)) return []
      return parsed.requests.map(parseRequest).filter((item): item is BotRequest => item !== null)
    } catch (error) {
      this.log('warn', `Could not read bot requests ledger: ${(error as Error).message}`)
      return []
    }
  }

  /** Atomically persists the dispatch ledger (keeps all active/waiting items plus up to 500 recent). */
  async saveRequests(requests: readonly BotRequest[]): Promise<void> {
    const active = requests.filter(
      (r) =>
        r.status === 'received' ||
        r.status === 'queued' ||
        r.status === 'waiting_host' ||
        r.status === 'running' ||
        r.status === 'waiting_user',
    )
    const rest = requests
      .filter((r) => !active.includes(r))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(0, MAX_STORED_REQUESTS - active.length))
    const kept = [...active, ...rest].sort((a, b) => b.createdAt - a.createdAt)
    const payload: RequestsEnvelope = { version: 1, requests: kept }
    await writeFileAtomic(this.requestsFile, `${JSON.stringify(payload, null, 2)}\n`)
  }
}
