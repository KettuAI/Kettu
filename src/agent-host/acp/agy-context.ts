// 估算 Antigravity (agy) 会话可加载的 Skills 与 MCP 工具定义占用的上下文 token。
// agy 1.5.16 尚未在 ACP 或非交互模式下暴露 `/context` 的完整分类拆解，
// 因此参考 Codex 的 ContextEstimates 方案：
// 1. Skills：优先调用只读的 `agy -p "/skills" --output-format json`（带目录级短缓存与登录态防护），
//    失败时回退扫描 agy 约定的磁盘技能目录 frontmatter；
// 2. MCP servers：合并会话传入的 MCP servers 与 `~/.gemini/config/mcp_config.json`，
//    对 HTTP MCP server 发起轻量只读 `tools/list` 估算工具 schema 大小，
//    对 stdio server 仅列出名称并将估算值置为 null（避免产生启动子进程的副作用）。

import { open, readdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ContextDefinitionEstimate, ContextEstimates } from '@shared/context'
import type { Platform } from '@shared/platform'
import { runProgram, type ProgramOptions, type ProgramRun } from '../adapter-install'
import type { McpServer } from '../connection'
import type { Env } from '../find-command'
import { frontmatter } from '../marketplace/frontmatter'

const UTF8_BYTES_PER_TOKEN = 4
const SKILLS_TIMEOUT_MS = 15_000
const SKILLS_CACHE_MS = 60_000
const MCP_TIMEOUT_MS = 5_000
const SKILL_FILE = 'SKILL.md'
const SKILL_FRONTMATTER_BYTES = 16 * 1024
const SIGN_IN_PROMPT = /Authentication required/i

const estimatedTokens = (bytes: number): number => Math.ceil(bytes / UTF8_BYTES_PER_TOKEN)

function bySize(a: ContextDefinitionEstimate, b: ContextDefinitionEstimate): number {
  return (b.tokens ?? -1) - (a.tokens ?? -1) || a.name.localeCompare(b.name)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface AgySkillEntry {
  name: string
  description: string
  path: string
  modelInvocable: boolean
}

/** 按 agy 系统提示 `<skills>` 段的实际呈现格式估算每项可调用 skill 的 token 数。 */
export function estimateAgySkills(skills: readonly AgySkillEntry[]): ContextDefinitionEstimate[] {
  return skills
    .filter((skill) => skill.modelInvocable)
    .map(({ name, description, path: file }) => ({
      name,
      tokens: estimatedTokens(Buffer.byteLength(`- ${name} (${file}): ${description}\n`)),
    }))
    .sort(bySize)
}

/** 解析 `agy -p "/skills" --output-format json` 的输出；结构不匹配时返回 null。 */
export function parseAgySkillsReply(reply: unknown): AgySkillEntry[] | null {
  if (!isRecord(reply) || reply.status !== 'SUCCESS') return null
  const command = isRecord(reply.command) ? reply.command : null
  if (command?.name !== 'skills' || !isRecord(command.data)) return null
  if (!Array.isArray(command.data.skills)) return null
  const entries: AgySkillEntry[] = []
  for (const item of command.data.skills) {
    if (!isRecord(item) || typeof item.name !== 'string' || item.name.trim() === '') continue
    entries.push({
      name: item.name.trim(),
      description: typeof item.description === 'string' ? item.description : '',
      path: typeof item.path === 'string' ? item.path : '',
      modelInvocable: item.model_invocable !== false,
    })
  }
  return entries
}

/** 从 MCP `tools/list` 返回的 tools 列表估算定义占用的 token 数。 */
export function estimateMcpToolList(tools: readonly unknown[]): number | null {
  let bytes = 0
  for (const item of tools) {
    if (!isRecord(item) || typeof item.name !== 'string') return null
    const schema = item.inputSchema ?? item.parameters
    if (schema !== undefined && !isRecord(schema)) return null
    bytes += Buffer.byteLength(
      JSON.stringify({
        name: item.name,
        description: typeof item.description === 'string' ? item.description : '',
        parameters: schema ?? {},
      }),
    )
  }
  return estimatedTokens(bytes)
}

/** 从 agy 的 `~/.gemini/config/mcp_config.json` 读取已启用的 MCP 服务器列表。 */
export async function readAgyMcpConfig(home: string): Promise<McpServer[]> {
  const file = path.join(home, '.gemini', 'config', 'mcp_config.json')
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return []
  }
  const servers = isRecord(parsed) && isRecord(parsed.mcpServers) ? parsed.mcpServers : null
  if (!servers) return []
  const out: McpServer[] = []
  for (const [name, value] of Object.entries(servers)) {
    if (!isRecord(value) || value.disabled === true) continue
    const url =
      typeof value.serverUrl === 'string'
        ? value.serverUrl
        : typeof value.url === 'string'
          ? value.url
          : null
    if (url) {
      const headers = isRecord(value.headers)
        ? Object.entries(value.headers)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
            .map(([key, val]) => ({ name: key, value: val }))
        : []
      const type = value.type === 'sse' ? 'sse' : 'http'
      out.push({ type, name, url, headers })
      continue
    }
    if (typeof value.command === 'string' && value.command !== '') {
      const args = Array.isArray(value.args)
        ? value.args.filter((arg): arg is string => typeof arg === 'string')
        : []
      const env = isRecord(value.env)
        ? Object.entries(value.env)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
            .map(([key, val]) => ({ name: key, value: val }))
        : []
      out.push({ type: 'stdio', name, command: value.command, args, env })
    }
  }
  return out
}

async function readHead(file: string): Promise<string | null> {
  let handle
  try {
    handle = await open(file, 'r')
    if (!(await handle.stat()).isFile()) return null
    const buf = Buffer.alloc(SKILL_FRONTMATTER_BYTES)
    const { bytesRead } = await handle.read(buf, 0, SKILL_FRONTMATTER_BYTES, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } catch {
    return null
  } finally {
    await handle?.close()
  }
}

/** 回退方案：扫描磁盘上 agy 约定的内置、用户和工作区技能目录。 */
export async function scanAgySkillsOnDisk(cwd: string, home: string): Promise<AgySkillEntry[]> {
  const roots = [
    path.join(cwd, '.agents', 'skills'),
    path.join(cwd, '.gemini', 'skills'),
    path.join(home, '.agents', 'skills'),
    path.join(home, '.gemini', 'skills'),
    path.join(home, '.gemini', 'antigravity-cli', 'builtin', 'skills'),
  ]
  const seen = new Set<string>()
  const out: AgySkillEntry[] = []
  for (const root of roots) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      if (entry.name.startsWith('.')) continue
      const file = path.join(root, entry.name, SKILL_FILE)
      const text = await readHead(file)
      if (text === null) continue
      const fields = frontmatter(text)
      const name = (fields.name ?? entry.name).trim() || entry.name
      if (seen.has(name)) continue
      seen.add(name)
      out.push({
        name,
        description: (fields.description ?? '').replace(/\s+/g, ' ').trim(),
        path: file,
        modelInvocable: true,
      })
    }
  }
  return out
}

/** 解析 Streamable HTTP 返回的 JSON 或 SSE data 行中的 JSON-RPC 响应体。 */
function parseMcpResponse(body: string, contentType: string | null): unknown {
  if (contentType?.includes('text/event-stream')) {
    const lines = body.split(/\r?\n/)
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim()
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        return JSON.parse(payload) as unknown
      } catch {
        // 继续尝试更早的一条 data
      }
    }
    return null
  }
  try {
    return JSON.parse(body) as unknown
  } catch {
    return null
  }
}

export type FetchFn = typeof globalThis.fetch

/** 通过只读 Streamable HTTP JSON-RPC 读取单个 HTTP MCP server 的工具定义并估算 token。 */
async function probeHttpMcpTools(
  server: Extract<McpServer, { url: string }>,
  fetchFn: FetchFn,
): Promise<number | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MCP_TIMEOUT_MS)
  timer.unref?.()
  const baseHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  for (const header of server.headers) baseHeaders[header.name] = header.value

  let sessionId: string | null = null
  try {
    const post = async (payload: object) => {
      const headers = sessionId ? { ...baseHeaders, 'mcp-session-id': sessionId } : baseHeaders
      const response = await fetchFn(server.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      const sid = response.headers.get('mcp-session-id')
      if (sid) sessionId = sid
      if (!response.ok) return null
      return parseMcpResponse(await response.text(), response.headers.get('content-type'))
    }

    await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'Kettu', version: '1.0.0' },
      },
    })
    const listed = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    const result = isRecord(listed) && isRecord(listed.result) ? listed.result : null
    if (!result || !Array.isArray(result.tools)) return null
    return estimateMcpToolList(result.tools)
  } catch {
    return null
  } finally {
    if (sessionId) {
      // 尽量释放临时建立的 MCP HTTP 会话，避免在服务端残留。
      void fetchFn(server.url, {
        method: 'DELETE',
        headers: { ...baseHeaders, 'mcp-session-id': sessionId },
      }).catch(() => {})
    }
    clearTimeout(timer)
  }
}

export interface AgyContextDeps {
  program?: string
  args?: readonly string[]
  env?: Env
  platform?: Platform
  home?: string
  run?: (options: ProgramOptions) => Promise<ProgramRun>
  fetch?: FetchFn
  now?: () => number
}

/** 缓存每个工作目录的 skills 查询结果，避免用户重复开关弹窗时反复拉起 agy 进程。 */
export class AgyContextEstimator {
  private readonly skillsCache = new Map<
    string,
    { at: number; items: ContextDefinitionEstimate[] }
  >()
  private readonly now: () => number

  constructor(private readonly deps: AgyContextDeps = {}) {
    this.now = deps.now ?? Date.now
  }

  async read(cwd: string, sessionServers: readonly McpServer[] = []): Promise<ContextEstimates> {
    const [skills, mcpServers] = await Promise.all([
      this.readSkills(cwd),
      this.readMcpServers(sessionServers),
    ])
    return { skills, mcpServers }
  }

  private async readSkills(cwd: string): Promise<ContextDefinitionEstimate[] | null> {
    const cached = this.skillsCache.get(cwd)
    if (cached && this.now() - cached.at < SKILLS_CACHE_MS) return cached.items

    const viaCli = await this.readSkillsFromCli(cwd)
    if (viaCli !== null) {
      const items = estimateAgySkills(viaCli)
      this.skillsCache.set(cwd, { at: this.now(), items })
      return items
    }

    const home = this.deps.home ?? os.homedir()
    const scanned = await scanAgySkillsOnDisk(cwd, home).catch(() => null)
    if (!scanned) return null
    const items = estimateAgySkills(scanned)
    this.skillsCache.set(cwd, { at: this.now(), items })
    return items
  }

  private async readSkillsFromCli(cwd: string): Promise<AgySkillEntry[] | null> {
    if (!this.deps.program) return null
    const abort = new AbortController()
    let signIn = false
    const run = await (this.deps.run ?? runProgram)({
      program: this.deps.program,
      args: [...(this.deps.args ?? []), '-p', '/skills', '--output-format', 'json'],
      cwd,
      env: this.deps.env ?? {},
      platform: this.deps.platform ?? (process.platform as Platform),
      timeoutMs: SKILLS_TIMEOUT_MS,
      signal: abort.signal,
      onOutput: (text) => {
        if (signIn || !SIGN_IN_PROMPT.test(text)) return
        signIn = true
        abort.abort()
      },
    })
    if (signIn || run.timedOut || run.error || run.code !== 0) return null
    try {
      return parseAgySkillsReply(JSON.parse(run.stdout) as unknown)
    } catch {
      return null
    }
  }

  private async readMcpServers(
    sessionServers: readonly McpServer[],
  ): Promise<ContextDefinitionEstimate[]> {
    const home = this.deps.home ?? os.homedir()
    const configServers = await readAgyMcpConfig(home)
    // 会话显式传入的 MCP 服务器优先级更高，按名称去重。
    const merged = new Map<string, McpServer>()
    for (const server of sessionServers) merged.set(server.name, server)
    for (const server of configServers) {
      if (!merged.has(server.name)) merged.set(server.name, server)
    }
    const fetchFn = this.deps.fetch ?? globalThis.fetch
    const estimates = await Promise.all(
      [...merged.values()].map(async (server): Promise<ContextDefinitionEstimate> => {
        if (server.type !== 'http') return { name: server.name, tokens: null }
        return {
          name: server.name,
          tokens: await probeHttpMcpTools(server, fetchFn),
        }
      }),
    )
    return estimates.sort(bySize)
  }
}
