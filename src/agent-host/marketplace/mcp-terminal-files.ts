// The text of an agent's own MCP file, as Kettu changes it for a takeover: only the keys of the
// entries Kettu writes and of the tools it turns off, every other key, comment and line kept.
// JSON and JSONC go through jsonc-parser; TOML tables Kettu adds are appended as plain tables, and
// the rest goes through toml-patch. Every result is parsed again and must hold what was meant.

import { createHash } from 'node:crypto'
import { applyEdits, modify, parse as parseJsonc, type ParseError } from 'jsonc-parser'
import { parse as parseToml, patch as patchToml } from '@decimalturn/toml-patch'
import type { HarnessId } from '@shared/agents'
import { MCP_BRIDGE_NAME } from '@shared/mcp-bridge'
import type { McpTerminalApp } from '@shared/mcp-terminal'
import { McpConfigError, object, type ConfigLayout } from './mcp-config'

export type TerminalFormat = 'json' | 'toml'
type Dictionary = Record<string, unknown>

/** The layouts whose servers Kettu can write: the rest are read only. */
export function terminalFormat(layout: ConfigLayout): TerminalFormat | null {
  switch (layout) {
    case 'claude':
    case 'standard':
    case 'opencode':
    case 'vscode':
    case 'zed':
      return 'json'
    case 'codex':
      return 'toml'
    default:
      return null
  }
}

/** The file as an object; an empty file is an empty one. */
export function parseTerminalText(text: string, format: TerminalFormat): Dictionary {
  if (text.trim() === '') return {}
  let parsed: unknown
  if (format === 'json') {
    const errors: ParseError[] = []
    parsed = parseJsonc(text, errors, { allowTrailingComma: true })
    const error = errors[0]
    if (error) {
      throw new McpConfigError('invalid-json', text.slice(0, error.offset).split('\n').length)
    }
  } else {
    try {
      parsed = parseToml(text)
    } catch {
      throw new McpConfigError('invalid-toml')
    }
  }
  const config = object(parsed)
  if (!config) throw new McpConfigError('invalid-server')
  return config
}

/** Where the servers sit in a file of `layout`, or null when Kettu cannot write them there. */
export function serversKey(config: Dictionary, layout: ConfigLayout): string[] | null {
  switch (layout) {
    case 'claude':
      return ['mcpServers']
    case 'standard':
      return config.mcpServers === undefined && object(config.servers)
        ? ['servers']
        : ['mcpServers']
    case 'vscode':
      return config.servers === undefined && object(config.mcpServers)
        ? ['mcpServers']
        : ['servers']
    case 'zed':
      return ['context_servers']
    case 'opencode':
      return object(object(config.mcp)?.servers) ? ['mcp', 'servers'] : ['mcp']
    case 'codex':
      return Array.isArray(config.mcp_servers) ? null : ['mcp_servers']
    default:
      return null
  }
}

export function valueAt(config: unknown, key: readonly string[]): unknown {
  let current = config
  for (const segment of key) {
    const map = object(current)
    if (!map) return undefined
    current = map[segment]
  }
  return current
}

/** The entries under `key`, by name; none when it is absent, and an error when it is no table. */
export function serversAt(config: Dictionary, key: readonly string[]): Dictionary {
  const value = valueAt(config, key)
  if (value === undefined) return {}
  const map = object(value)
  if (!map) throw new McpConfigError('invalid-server')
  return map
}

/** Sorted keys, so the same entry always has the same digest however a file orders it. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  const map = object(value)
  if (!map) return typeof value === 'bigint' ? value.toString() : value
  return Object.fromEntries(
    Object.keys(map)
      .sort()
      .map((key) => [key, canonical(map[key])]),
  )
}

export function entryDigest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)) ?? 'undefined')
    .digest('hex')
}

/** The command a bridge entry runs, and the arguments up to the server's name. */
export interface BridgeLaunch {
  command: string
  args: readonly string[]
}

/** The arguments of one server's bridge entry. */
export function bridgeArgs(
  launch: BridgeLaunch,
  server: string,
  agentId: string,
  data: string | null,
): string[] {
  return [...launch.args, server, '--agent', agentId, ...(data ? ['--data', data] : [])]
}

/**
 * One server's entry as the agent's or app's own file holds it, running the bridge: never a key, a
 * port or a token. Tools turned off in Kettu go into the entry where it has a setting for them.
 */
export function bridgeEntry(
  layout: ConfigLayout,
  owner: { harness: HarnessId } | { app: McpTerminalApp },
  command: string,
  args: readonly string[],
  toolsOff: readonly string[],
): unknown {
  const harness = 'harness' in owner ? owner.harness : null
  const app = 'app' in owner ? owner.app : null
  switch (layout) {
    case 'claude':
      return { type: 'stdio', command, args: [...args], env: {} }
    case 'opencode':
      return { type: 'local', command: [command, ...args] }
    case 'codex':
      // Codex hands its MCP servers only the variables it is told of, and the bridge needs this
      // one to know a Kettu session from a terminal.
      return {
        command,
        args: [...args],
        env_vars: ['KETTU_MCP_SESSION'],
        ...(toolsOff.length ? { disabled_tools: [...toolsOff] } : {}),
      }
    case 'vscode':
      return { type: 'stdio', command, args: [...args] }
    case 'zed':
      return { command, args: [...args], env: {} }
    default:
      return {
        command,
        args: [...args],
        ...(harness === 'gemini' && toolsOff.length ? { excludeTools: [...toolsOff] } : {}),
        ...((app === 'windsurf' || app === 'devin') && toolsOff.length
          ? { disabledTools: [...toolsOff] }
          : {}),
      }
  }
}

/** Whether an entry runs Kettu's bridge, whichever copy of it, so discovery never offers it. */
export function isBridgeEntry(raw: unknown): boolean {
  const entry = object(raw)
  if (!entry) return false
  const words = Array.isArray(entry.command)
    ? entry.command
    : [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])]
  const [command, first, second] = words
  if (typeof command !== 'string' || first !== 'mcp' || second !== 'connect') return false
  const base = command
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.exe$/i, '')
  return base === MCP_BRIDGE_NAME || base === 'kettu'
}

/** Whether a parsed server runs Kettu's bridge. */
export function isBridgeSpec(spec: {
  type: string
  command?: string
  args?: readonly string[]
}): boolean {
  return spec.type === 'stdio' && isBridgeEntry({ command: spec.command, args: spec.args })
}

/** A change of one entry: its new value, or undefined to remove it. */
export interface EntryEdit {
  name: string
  value: unknown
}

function indent(text: string): { insertSpaces: boolean; tabSize: number } {
  const line = /\n([ \t]+)\S/.exec(text)?.[1]
  if (!line) return { insertSpaces: true, tabSize: 2 }
  if (line.startsWith('\t')) return { insertSpaces: false, tabSize: 1 }
  return { insertSpaces: true, tabSize: line.length }
}

function editJson(text: string, edits: readonly { key: string[]; value: unknown }[]): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const formattingOptions = { ...indent(text), eol }
  let next = text.trim() === '' ? '{}' : text
  for (const { key, value } of edits) {
    next = applyEdits(next, modify(next, key, value, { formattingOptions }))
  }
  return next.endsWith(eol) ? next : next + eol
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/

function tomlKey(key: string): string {
  return BARE_KEY.test(key) ? key : JSON.stringify(key)
}

function tomlValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  // Only reached when showing a user's entry; what Kettu writes is parsed again before it is kept.
  return JSON.stringify(String(value))
}

/** A table of plain values as TOML lines under its header. */
function tomlTable(key: readonly string[], value: Dictionary): string {
  const lines = Object.entries(value).map(([name, item]) => `${tomlKey(name)} = ${tomlValue(item)}`)
  return `[${key.map(tomlKey).join('.')}]\n${lines.join('\n')}\n`
}

/**
 * Removals and changes in place through toml-patch, which keeps the lines around them; tables
 * that are new go at the end as plain tables, since toml-patch would write them as dotted keys.
 */
function editToml(text: string, container: readonly string[], edits: readonly EntryEdit[]): string {
  const before = parseTerminalText(text, 'toml')
  const existing = serversAt(before, container)
  const inPlace = edits.filter(({ name }) => name in existing)
  const added = edits.filter(({ name, value }) => !(name in existing) && value !== undefined)
  let next = text
  if (inPlace.length > 0) {
    const updated = parseTerminalText(next, 'toml')
    const servers = serversAt(updated, container)
    for (const { name, value } of inPlace) {
      if (value === undefined) delete servers[name]
      else servers[name] = value
    }
    next = patchToml(next, updated)
  }
  for (const { name, value } of added) {
    const table = object(value)
    if (!table) throw new Error('A TOML entry must be a table')
    const gap = next === '' || next.endsWith('\n\n') ? '' : next.endsWith('\n') ? '\n' : '\n\n'
    next += gap + tomlTable([...container, name], table)
  }
  return next
}

/** The text with every edit applied under `container`; it must parse to what was meant. */
export function editServers(
  text: string,
  format: TerminalFormat,
  container: readonly string[],
  edits: readonly EntryEdit[],
): string {
  if (edits.length === 0) return text
  const next =
    format === 'json'
      ? editJson(
          text,
          edits.map(({ name, value }) => ({ key: [...container, name], value })),
        )
      : editToml(text, container, edits)
  const want = { ...serversAt(parseTerminalText(text, format), container) }
  for (const { name, value } of edits) {
    if (value === undefined) delete want[name]
    else want[name] = value
  }
  const got = serversAt(parseTerminalText(next, format), container)
  if (entryDigest(got) !== entryDigest(want)) {
    throw new Error('The file would not hold the entries Kettu meant to write')
  }
  return next
}

/** The text with one key set to `value`, or removed for undefined. */
export function editKey(text: string, key: readonly string[], value: unknown): string {
  const next = editJson(text, [{ key: [...key], value }])
  if (entryDigest(valueAt(parseTerminalText(next, 'json'), key)) !== entryDigest(value)) {
    throw new Error('The file would not hold the setting Kettu meant to write')
  }
  return next
}

/**
 * A list setting with Kettu's own items replaced by `ours`, the user's left where they were.
 * Null when the list would be what it is now.
 */
export function mergeList(
  current: unknown,
  previous: readonly string[],
  ours: readonly string[],
): string[] | null {
  const list = Array.isArray(current) ? current.filter((item) => typeof item === 'string') : []
  if (current !== undefined && (!Array.isArray(current) || list.length !== current.length)) {
    throw new McpConfigError('invalid-server')
  }
  const gone = new Set(previous.filter((item) => !ours.includes(item)))
  const kept = list.filter((item) => !gone.has(item))
  const next = [...kept, ...ours.filter((item) => !kept.includes(item))]
  return JSON.stringify(next) === JSON.stringify(list) ? null : next
}

/** A map of tool switches with Kettu's own keys replaced by `ours`, which are all off. */
export function mergeToolMap(
  current: unknown,
  previous: readonly string[],
  ours: readonly string[],
): Dictionary | null {
  if (current !== undefined && !object(current)) throw new McpConfigError('invalid-server')
  const map: Dictionary = { ...(object(current) ?? {}) }
  for (const key of previous) if (!ours.includes(key) && map[key] === false) delete map[key]
  for (const key of ours) map[key] = false
  return entryDigest(map) === entryDigest(object(current) ?? {}) ? null : map
}

/** The servers' part of a file as text, with every written value masked, for the confirmation. */
export function maskedServers(
  servers: Dictionary,
  format: TerminalFormat,
  secrets: readonly string[],
): string {
  const values = [...secrets]
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length)
  const mask = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return values.reduce((text, secret) => text.split(secret).join('••••'), value)
    }
    if (Array.isArray(value)) return value.map(mask)
    const map = object(value)
    if (!map) return typeof value === 'bigint' ? value.toString() : value
    return Object.fromEntries(Object.entries(map).map(([key, item]) => [key, mask(item)]))
  }
  const masked = mask(servers) as Dictionary
  if (format === 'json') return JSON.stringify(masked, null, 2)
  return Object.entries(masked)
    .map(([name, value]) => {
      const table = object(value) ?? {}
      const flat = Object.fromEntries(Object.entries(table).filter(([, item]) => !object(item)))
      return tomlTable(['mcp_servers', name], flat)
    })
    .join('\n')
}
