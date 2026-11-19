// Kettu's extension for Pi, which each session's process loads with `-e`: Pi takes MCP servers
// only from its own configuration or from an extension, and names its model scope only to one.
// The extension is written into Kettu's harnesses folder; the user's own folders are left alone.

import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { McpServer } from '../connection'
import { GUIDE_TOOL } from '../guide/guide'
import { MEMORY_TOOL_NAMES } from '../memory/tools'
import { PLAN_TOOL } from '../plan-tool'
import { SERVICE_NAME } from '../service-name'

/** The oldest pi with `registerMcpServer` and MCP support of its own. */
export const EXTENSION_SINCE = '1.0.0'
/** A session's MCP servers as JSON, in its process's environment; the extension's only. */
export const SERVERS_VARIABLE = 'KETTU_MCP_SERVERS'
/** Set for a session whose model scope the extension reports. */
export const SCOPE_VARIABLE = 'KETTU_MODEL_SCOPE'
/** The status the extension sets to the session's model scope, as `{"models": [...]}`. */
export const SCOPE_STATUS = 'kettu.model-scope'

/**
 * Kettu's tools that pi declares to the model from the start, as it does its built-in ones: the
 * plan, memory, the guide and making and reading artifacts. The rest of Kettu's service is found
 * through pi's tool search, so a session's requests do not carry every tool's schema.
 */
export const DIRECT_TOOLS: readonly string[] = [
  PLAN_TOOL,
  ...MEMORY_TOOL_NAMES,
  GUIDE_TOOL,
  'create_artifact',
  'update_artifact',
  'read_artifact',
  'list_artifacts',
]

/** An MCP server as the extension registers it: pi's name for it and its `mcpServers` entry. */
export interface PiServer {
  name: string
  config: Record<string, unknown>
}

/** A name pi takes for an MCP server: letters, digits, `_` and `-`, none twice. */
function serverName(name: string, taken: Set<string>): string {
  const base = name.replace(/[^A-Za-z0-9_-]/g, '_') || 'mcp'
  // Pi counts names that differ only in `-` and `_` as one server.
  const key = (value: string): string => value.replace(/-/g, '_').toLowerCase()
  let candidate = base
  for (let n = 2; taken.has(key(candidate)); n++) candidate = `${base}_${n}`
  taken.add(key(candidate))
  return candidate
}

/**
 * The servers a session hands pi. Kettu's own service declares `DIRECT_TOOLS` and defers the rest;
 * another server keeps pi's own exposure. SSE servers are left out, which pi does not speak.
 */
export function piServers(servers: readonly McpServer[]): PiServer[] {
  const taken = new Set<string>()
  const list: PiServer[] = []
  for (const server of servers) {
    if (server.type === 'sse') continue
    const name = serverName(server.name, taken)
    if (server.type === 'stdio') {
      const env = Object.fromEntries(server.env.map((variable) => [variable.name, variable.value]))
      list.push({
        name,
        config: {
          command: server.command,
          args: server.args,
          ...(server.env.length > 0 ? { env } : {}),
        },
      })
      continue
    }
    const headers = Object.fromEntries(server.headers.map((header) => [header.name, header.value]))
    list.push({
      name,
      config: {
        url: server.url,
        ...(server.headers.length > 0 ? { headers } : {}),
        ...(server.name === SERVICE_NAME
          ? {
              exposure: 'deferred',
              toolExposure: Object.fromEntries(DIRECT_TOOLS.map((tool) => [tool, 'direct'])),
            }
          : {}),
      },
    })
  }
  return list
}

/**
 * The extension: registers the session's MCP servers with pi's own MCP support and drops the
 * variable that carried them, so the commands pi runs never inherit a token. Once the session
 * starts it reports the models pi scoped it to (`ctx.scopedModels`, as `provider/id`, none when pi
 * has no scope) as a status, once per process: pi's RPC lists every signed-in model. Kept on
 * `globalThis` for a `/reload`, which loads the extension again in the same process. Without
 * `registerMcpServer` (pi before 1.0.0) it registers nothing.
 */
export const PI_EXTENSION_SOURCE = `// Written by Kettu: gives Pi's Kettu sessions Kettu's MCP servers and reports their model scope.
const HELD = Symbol.for('kettu.session')

function parse(text) {
  try {
    const list = JSON.parse(text || '[]')
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

export default function kettu(pi) {
  const env = process.env
  const held = globalThis[HELD] ?? {
    servers: parse(env.${SERVERS_VARIABLE}),
    scope: env.${SCOPE_VARIABLE} === '1',
    scopeSent: false,
  }
  globalThis[HELD] = held
  delete env.${SERVERS_VARIABLE}
  delete env.${SCOPE_VARIABLE}
  if (held.scope && typeof pi.on === 'function') {
    pi.on('session_start', (_event, ctx) => {
      if (held.scopeSent || typeof ctx?.ui?.setStatus !== 'function') return
      held.scopeSent = true
      const scoped = Array.isArray(ctx.scopedModels) ? ctx.scopedModels : []
      const models = scoped.map((entry) => entry.model.provider + '/' + entry.model.id)
      try {
        ctx.ui.setStatus(${JSON.stringify(SCOPE_STATUS)}, JSON.stringify({ models }))
      } catch (error) {
        console.error('Kettu could not pass on the model scope: ' + error)
      }
    })
  }
  if (typeof pi.registerMcpServer !== 'function') return
  for (const server of held.servers) {
    try {
      pi.registerMcpServer(server.name, server.config)
    } catch (error) {
      // Pi does not start with an extension that throws; the session goes on without the server.
      console.error('Kettu could not add the MCP server ' + server.name + ': ' + error)
    }
  }
}
`

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

/**
 * Writes `contents` to `file` unless it holds them already. Named by their digest, so instances of
 * different versions never replace a file another may be starting Pi with.
 */
async function ensureFile(file: string, contents: string, mode: number): Promise<void> {
  const current = await readFile(file, 'utf8').catch(() => null)
  if (current === contents) return
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(tmp, contents, { mode })
    await chmod(tmp, mode)
    await rename(tmp, file)
  } finally {
    await rm(tmp, { force: true })
  }
}

/** The extension's file, written into `dir` when missing. */
export async function piExtension(dir: string): Promise<string> {
  const file = path.join(dir, `kettu-${digest(PI_EXTENSION_SOURCE)}.mjs`)
  await ensureFile(file, PI_EXTENSION_SOURCE, 0o644)
  return file
}
