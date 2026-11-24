// A package's `mcp.json`: the format's portable MCP servers, each with an explicit `type`, and
// the server Kettu keeps for each once the package has a folder on the host. A file that does not
// fit turns MCP off for the package, and an entry that does not fit is left out alone.

import path from 'node:path'
import type { McpSpec } from '@shared/marketplace'
import { PLUGIN_ITEM_NAME } from '@shared/plugins'
import { t } from '../i18n'
import { packagePath } from './manifest'

const SCHEMA = /^https:\/\/agent-plugins\.org\/schemas\/(\d+\.\d+\.\d+)\/mcp\.schema\.json$/
const MAX_SERVERS = 50
const MAX_ARGS = 100
const MAX_VALUES = 60
const MAX_TEXT = 2_000
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
// A token as RFC 9110 defines a field name.
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/
const RESERVED = ['PLUGIN_ROOT', 'PLUGIN_DATA']
const CWD = /^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/

/** A server as the package writes it, checked. */
export type PortableServer = { name: string; runs: string } & (
  | {
      type: 'stdio'
      /** A bare program name, or a path inside the package without its `./`. */
      command: string
      bundled: boolean
      args: string[]
      env: [string, string][]
      cwd: string | null
    }
  | { type: 'streamable-http' | 'sse'; url: string; headers: [string, string][] }
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function only(raw: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(raw).every((key) => keys.includes(key))
}

function strings(value: unknown, name: RegExp): [string, string][] | null {
  if (value === undefined) return []
  if (!isRecord(value)) return null
  const entries = Object.entries(value)
  if (entries.length > MAX_VALUES) return null
  const seen = new Set<string>()
  for (const [key, text] of entries) {
    if (!name.test(key) || typeof text !== 'string' || text.length > MAX_TEXT) return null
    if (/[\0\r\n]/.test(text) || seen.has(key.toLowerCase())) return null
    seen.add(key.toLowerCase())
  }
  return entries as [string, string][]
}

function loopback(host: string): boolean {
  return host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host)
}

function server(
  name: string,
  raw: unknown,
  files: readonly { path: string }[],
): PortableServer | string {
  if (!PLUGIN_ITEM_NAME.test(name)) return t('plugins.reason.name')
  if (!isRecord(raw)) return t('plugins.reason.entry')
  if (raw.type === 'stdio') {
    if (!only(raw, ['type', 'command', 'args', 'env', 'cwd'])) return t('plugins.reason.entry')
    const { command, args = [], cwd } = raw
    if (typeof command !== 'string' || command === '' || command.length > MAX_TEXT) {
      return t('plugins.reason.entry')
    }
    // One program: a bare name found on the PATH, or a file of the package.
    const bundled = command.startsWith('./')
    const inner = bundled ? packagePath(command) : null
    if (bundled ? inner === null : /[/\\\s\0]/.test(command)) return t('plugins.reason.command')
    if (inner !== null && !files.some((file) => file.path === inner)) {
      return t('plugins.reason.noFile', { file: command })
    }
    if (
      !Array.isArray(args) ||
      args.length > MAX_ARGS ||
      !args.every((arg) => typeof arg === 'string' && arg.length <= MAX_TEXT && !arg.includes('\0'))
    ) {
      return t('plugins.reason.entry')
    }
    const env = strings(raw.env, ENV_NAME)
    if (env === null || env.some(([key]) => RESERVED.includes(key))) {
      return t('plugins.reason.entry')
    }
    if (cwd !== undefined) {
      if (typeof cwd !== 'string' || cwd.length > MAX_TEXT || !CWD.test(cwd)) {
        return t('plugins.reason.entry')
      }
      if (cwd.split('/').includes('..')) return t('plugins.reason.entry')
    }
    return {
      name,
      type: 'stdio',
      runs: [command, ...(args as string[])].join(' '),
      command: inner ?? command,
      bundled,
      args: [...(args as string[])],
      env,
      cwd: (cwd as string | undefined) ?? null,
    }
  }
  if (raw.type === 'streamable-http' || raw.type === 'sse') {
    if (!only(raw, ['type', 'url', 'headers'])) return t('plugins.reason.entry')
    const url = typeof raw.url === 'string' && raw.url.length <= MAX_TEXT ? raw.url : ''
    const parsed = URL.parse(url)
    if (
      !parsed ||
      /\s/.test(url) ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.hash !== '' ||
      !(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback(parsed.hostname)))
    ) {
      return t('plugins.reason.url')
    }
    const headers = strings(raw.headers, HEADER_NAME)
    if (headers === null) return t('plugins.reason.entry')
    return { name, type: raw.type, runs: url, url, headers }
  }
  return t('plugins.reason.type', { types: 'stdio, streamable-http, sse' })
}

/**
 * The servers of an `mcp.json`, each checked on its own. `spec` is the format version the
 * manifest targets, which this file must target too.
 */
export function parseServers(
  text: string,
  spec: string,
  files: readonly { path: string }[],
  warnings: string[],
): PortableServer[] {
  const off = (reason: string): PortableServer[] => {
    warnings.push(t('plugins.warn.item', { path: 'mcp.json', reason }))
    return []
  }
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return off(t('plugins.reason.entry'))
  }
  if (!isRecord(raw) || !only(raw, ['$schema', 'mcpServers']) || !isRecord(raw.mcpServers)) {
    return off(t('plugins.reason.entry'))
  }
  const version = typeof raw.$schema === 'string' ? SCHEMA.exec(raw.$schema)?.[1] : undefined
  if (version !== spec) return off(t('plugins.reason.schema'))
  const entries = Object.entries(raw.mcpServers)
  if (entries.length > MAX_SERVERS) return off(t('plugins.reason.entry'))
  const servers: PortableServer[] = []
  for (const [name, value] of entries) {
    const read = server(name, value, files)
    if (typeof read === 'string') {
      warnings.push(t('plugins.warn.server', { name: name.slice(0, 100), reason: read }))
      continue
    }
    // Agents start a server in the session's folder, so one that names another cannot have it.
    if (read.type === 'stdio' && read.cwd !== null) {
      warnings.push(t('plugins.warn.cwd', { name, cwd: read.cwd }))
    }
    servers.push(read)
  }
  return servers.sort((a, b) => a.name.localeCompare(b.name))
}

/** `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` replaced once; what a replacement adds is not read again. */
export function expand(text: string, root: string, data: string): string {
  return text.replace(/\$\{PLUGIN_(ROOT|DATA)\}/g, (_, which: string) =>
    which === 'ROOT' ? root : data,
  )
}

/**
 * The server Kettu keeps for a package's server, once the package is in `root` with `data` as
 * its own folder: a bundled program by its path there, and both folders in its environment.
 */
export function serverSpec(portable: PortableServer, root: string, data: string): McpSpec {
  if (portable.type !== 'stdio') {
    return {
      type: 'http',
      transport: portable.type,
      url: portable.url,
      headers: portable.headers.map(([name, value]) => ({ name, value })),
    }
  }
  return {
    type: 'stdio',
    command: portable.bundled ? path.join(root, ...portable.command.split('/')) : portable.command,
    args: portable.args.map((arg) => expand(arg, root, data)),
    env: [
      ...portable.env.map(([name, value]) => ({ name, value: expand(value, root, data) })),
      { name: 'PLUGIN_ROOT', value: root },
      { name: 'PLUGIN_DATA', value: data },
    ],
  }
}
