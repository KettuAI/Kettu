// Pure validation and merging of settings.json and of the renderer's patches.

import {
  AGENT_NAME_CHARS,
  CONFIG_VARIABLES,
  DEFAULT_SETTINGS,
  type AddedAgent,
  type HostSettings,
  type ProxySettings,
  type SettingsFile,
  type SettingsPatch,
  type TerminalSettings,
  ZOOM_LEVELS,
} from '@shared/settings'
import { LANGUAGE_SETTINGS, resolveLocale, type Locale } from '@shared/locale'
import { addressKey, isPort, MAX_OWN_ADDRESSES, parseDirectAddress } from '@shared/remote/address'
import type { DirectAddress } from '@shared/remote/protocol'
import { THEME_ID } from '@shared/themes'
import {
  HARNESS_IDS,
  isAgentId,
  isDefaultAgent,
  isHarnessId,
  harnessOf,
  MULTI_AGENT_HARNESSES,
  type AgentId,
  type HarnessId,
} from '@shared/thread'

export const SETTINGS_VERSION = 1

export class SettingsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SettingsError'
  }
}

type Check = (value: unknown, path: string) => string | null

const oneOf =
  (...values: readonly unknown[]): Check =>
  (value, path) =>
    values.includes(value)
      ? null
      : `"${path}" must be one of ${values.map((v) => JSON.stringify(v)).join(', ')}`

const isBoolean: Check = (value, path) =>
  typeof value === 'boolean' ? null : `"${path}" must be a boolean`

const isAgentChoice: Check = (value, path) =>
  value === null || isAgentId(value) ? null : `"${path}" must be an agent id or null`

const isThemeId: Check = (value, path) =>
  typeof value === 'string' && THEME_ID.test(value) ? null : `"${path}" must be a theme id`

const SECTION_FIELDS = {
  general: {
    language: oneOf(...LANGUAGE_SETTINGS),
    defaultAgent: isAgentChoice,
    sendKey: oneOf('enter', 'mod-enter'),
    restoreLastSession: isBoolean,
    confirmQuitWhileRunning: isBoolean,
    openAtLogin: isBoolean,
    background: isBoolean,
    sessionTitles: isBoolean,
  },
  thread: { outlineSummaries: isBoolean, confirmLinks: isBoolean },
  appearance: {
    theme: oneOf('system', 'light', 'dark'),
    colorTheme: isThemeId,
    textSize: oneOf('small', 'default', 'large'),
    reduceMotion: oneOf('system', 'always'),
    zoom: oneOf(...ZOOM_LEVELS),
  },
  notifications: {
    permission: isBoolean,
    turnEnded: isBoolean,
    error: isBoolean,
    routines: isBoolean,
    sound: isBoolean,
    badge: isBoolean,
  },
  git: { backgroundFetch: isBoolean },
  updates: { automatic: oneOf('download', 'restart', 'notify', 'off') },
  privacy: { hideAccount: isBoolean },
  usage: { fromComputer: isBoolean, sidebar: oneOf('today', 'cost', 'limit', 'off') },
} as const satisfies Record<string, Record<string, Check>>

type FieldSection = keyof typeof SECTION_FIELDS

const FIELD_SECTIONS = Object.keys(SECTION_FIELDS) as FieldSection[]
const FONT_SIZES = [12, 13, 14] as const
const PROXY_PROTOCOLS = ['http:', 'https:', 'socks:', 'socks4:', 'socks5:']
const MAX_PATH_LENGTH = 4096
const MAX_URL_LENGTH = 2048
const MAX_NO_PROXY_LENGTH = 4096

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function checkProxy(value: unknown, path: string): string | null {
  if (!isRecord(value)) return `"${path}" must be an object`
  if (value.mode === 'environment') {
    const extra = Object.keys(value).find((key) => key !== 'mode')
    return extra ? `Unknown setting "${path}.${extra}"` : null
  }
  if (value.mode !== 'custom') return `"${path}.mode" must be one of "environment", "custom"`
  const extra = Object.keys(value).find((key) => !['mode', 'url', 'noProxy'].includes(key))
  if (extra) return `Unknown setting "${path}.${extra}"`
  if (typeof value.url !== 'string' || value.url.length > MAX_URL_LENGTH) {
    return `"${path}.url" must be a string of at most ${MAX_URL_LENGTH} characters`
  }
  const url = URL.parse(value.url.trim())
  if (!url || !PROXY_PROTOCOLS.includes(url.protocol) || !url.hostname || /\s/.test(value.url)) {
    return `"${path}.url" must be a proxy URL such as http://proxy.example.com:8080`
  }
  if (typeof value.noProxy !== 'string' || value.noProxy.length > MAX_NO_PROXY_LENGTH) {
    return `"${path}.noProxy" must be a string of at most ${MAX_NO_PROXY_LENGTH} characters`
  }
  return null
}

const AGENT_KEYS: readonly string[] = ['binaryPath', 'configDir', 'hidden']

/** The agents Kettu's own MCP server is off for: each an agent id, once. */
function checkMcpOff(value: unknown, path: string): string | null {
  if (!Array.isArray(value)) return `"${path}" must be an array`
  const seen = new Set<unknown>()
  for (const id of value) {
    if (!isAgentId(id)) return `"${path}" names an unknown agent`
    if (seen.has(id)) return `"${path}" names an agent twice`
    seen.add(id)
  }
  return null
}

function checkStoredPath(value: unknown, path: string): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH) {
    return `"${path}" must be a non-empty path`
  }
  return value.includes('\0') ? `"${path}" must not contain NUL characters` : null
}

function checkMcp(value: unknown, path: string): string | null {
  if (!isRecord(value)) return `"${path}" must be an object`
  const extra = Object.keys(value).find((key) => key !== 'kettu')
  if (extra) return `Unknown setting "${path}.${extra}"`
  const kettu = value.kettu
  if (!isRecord(kettu)) return `"${path}.kettu" must be an object`
  const unknown = Object.keys(kettu).find((key) => key !== 'off')
  if (unknown) return `Unknown setting "${path}.kettu.${unknown}"`
  return checkMcpOff(kettu.off, `${path}.kettu.off`)
}

const ADDRESS_PROBLEM = 'must be a host name or IP address and a port from 1 to 65535'

/** The owner's own direct addresses as a patch sets them: each valid, once, and few enough. */
function checkOwnAddresses(value: unknown, path: string): string | null {
  if (!Array.isArray(value)) return `"${path}" must be an array`
  if (value.length > MAX_OWN_ADDRESSES) {
    return `"${path}" may hold at most ${MAX_OWN_ADDRESSES} addresses`
  }
  const seen = new Set<string>()
  for (const [index, entry] of value.entries()) {
    const address = parseDirectAddress(entry)
    if (!address) return `"${path}[${index}]" ${ADDRESS_PROBLEM}`
    const extra = Object.keys(entry as object).find((key) => key !== 'host' && key !== 'port')
    if (extra) return `Unknown setting "${path}[${index}].${extra}"`
    const key = addressKey(address)
    if (seen.has(key)) return `"${path}" names an address twice`
    seen.add(key)
  }
  return null
}

/** A port the owner picks; whether it is free shows only when the remote host listens on it. */
const isOwnPort: Check = (value, path) =>
  isPort(value) && value >= 1024 ? null : `"${path}" must be a port from 1024 to 65535`

/** `remote` in a patch. */
function checkRemote(value: unknown, problems: string[]): void {
  if (!isRecord(value)) {
    problems.push('"remote" must be an object')
    return
  }
  for (const [key, fieldValue] of Object.entries(value)) {
    if (key === 'enabled') {
      const problem = isBoolean(fieldValue, 'remote.enabled')
      if (problem) problems.push(problem)
    } else if (key === 'direct') {
      if (!isRecord(fieldValue)) {
        problems.push('"remote.direct" must be an object')
        continue
      }
      for (const [directKey, directValue] of Object.entries(fieldValue)) {
        const path = `remote.direct.${directKey}`
        const problem =
          directKey === 'enabled'
            ? isBoolean(directValue, path)
            : directKey === 'port'
              ? isOwnPort(directValue, path)
              : directKey === 'addresses'
                ? checkOwnAddresses(directValue, path)
                : `Unknown setting "${path}"`
        if (problem) problems.push(problem)
      }
    } else {
      problems.push(`Unknown setting "remote.${key}"`)
    }
  }
}

function normalizeProxy(proxy: ProxySettings): ProxySettings {
  if (proxy.mode === 'environment') return { mode: 'environment' }
  return { mode: 'custom', url: proxy.url.trim(), noProxy: proxy.noProxy.trim() }
}

/**
 * Validates a change from the renderer. Anything unknown or out of range rejects the whole
 * patch, so a call either applies completely or changes nothing.
 */
export function validateSettingsPatch(raw: unknown): SettingsPatch {
  if (!isRecord(raw)) throw new SettingsError('Settings patch must be an object')
  const problems: string[] = []
  for (const [section, value] of Object.entries(raw)) {
    if (FIELD_SECTIONS.includes(section as FieldSection)) {
      const fields: Record<string, Check> = SECTION_FIELDS[section as FieldSection]
      if (!isRecord(value)) {
        problems.push(`"${section}" must be an object`)
        continue
      }
      for (const [key, fieldValue] of Object.entries(value)) {
        const check = fields[key]
        const problem = check
          ? check(fieldValue, `${section}.${key}`)
          : `Unknown setting "${section}.${key}"`
        if (problem) problems.push(problem)
      }
    } else if (section === 'agents') {
      if (!isRecord(value)) {
        problems.push('"agents" must be an object')
        continue
      }
      for (const [harnessId, entry] of Object.entries(value)) {
        if (!isHarnessId(harnessId)) {
          problems.push(`Unknown harness "agents.${harnessId}"`)
        } else if (
          !isRecord(entry) ||
          Object.keys(entry).some((key) => !AGENT_KEYS.includes(key))
        ) {
          problems.push(`"agents.${harnessId}" accepts only "binaryPath", "configDir" and "hidden"`)
        } else {
          if ('binaryPath' in entry && entry.binaryPath !== null) {
            problems.push(
              `"agents.${harnessId}.binaryPath" can only be cleared with null; choose a program in the dialog`,
            )
          }
          if ('configDir' in entry && entry.configDir !== null) {
            problems.push(`"agents.${harnessId}.configDir" can only be cleared with null`)
          }
          const problem =
            'hidden' in entry ? isBoolean(entry.hidden, `agents.${harnessId}.hidden`) : null
          if (problem) problems.push(problem)
        }
      }
    } else if (section === 'proxy') {
      const problem = checkProxy(value, 'proxy')
      if (problem) problems.push(problem)
    } else if (section === 'mcp') {
      const problem = checkMcp(value, 'mcp')
      if (problem) problems.push(problem)
    } else if (section === 'remote') {
      checkRemote(value, problems)
    } else if (section === 'terminal') {
      if (!isRecord(value)) {
        problems.push('"terminal" must be an object')
        continue
      }
      for (const [key, fieldValue] of Object.entries(value)) {
        if (key === 'fontSize') {
          const problem = oneOf(...FONT_SIZES)(fieldValue, 'terminal.fontSize')
          if (problem) problems.push(problem)
        } else if (key === 'shellPath') {
          if (fieldValue !== null) {
            problems.push(
              '"terminal.shellPath" can only be cleared with null; choose a program in the dialog',
            )
          }
        } else {
          problems.push(`Unknown setting "terminal.${key}"`)
        }
      }
    } else {
      problems.push(`Unknown setting "${section}"`)
    }
  }
  if (problems.length > 0) throw new SettingsError(problems.join('; '))
  return raw as SettingsPatch
}

/** Applies a validated patch. Sections merge key by key; `proxy` is replaced whole. */
export function mergeSettings(current: SettingsFile, patch: SettingsPatch): SettingsFile {
  const next = structuredClone(current)
  for (const section of FIELD_SECTIONS) {
    const changes = patch[section]
    if (changes) Object.assign(next[section], changes)
  }
  if (patch.proxy) next.proxy = normalizeProxy(patch.proxy)
  if (patch.mcp) next.mcp = { kettu: { off: [...patch.mcp.kettu.off] } }
  if (patch.agents) {
    for (const harnessId of Object.keys(patch.agents) as HarnessId[]) {
      const change = patch.agents[harnessId]
      const entry = { ...next.agents[harnessId] }
      if (change?.binaryPath === null) delete entry.binaryPath
      if (change?.configDir === null) delete entry.configDir
      if (change?.hidden === true) entry.hidden = true
      if (change?.hidden === false) delete entry.hidden
      if (Object.keys(entry).length > 0) next.agents[harnessId] = entry
      else delete next.agents[harnessId]
    }
  }
  if (patch.terminal) {
    if (patch.terminal.fontSize !== undefined) next.terminal.fontSize = patch.terminal.fontSize
    if (patch.terminal.shellPath === null) delete next.terminal.shellPath
  }
  if (patch.remote) {
    const { enabled, direct } = patch.remote
    if (enabled !== undefined) next.remote.enabled = enabled
    if (direct?.enabled !== undefined) next.remote.direct.enabled = direct.enabled
    if (direct?.port !== undefined) next.remote.direct.port = direct.port
    if (direct?.addresses) {
      next.remote.direct.addresses = direct.addresses.map(({ host, port }) => ({ host, port }))
    }
  }
  return next
}

/**
 * Gives direct connections their port the first time they are on, from `pick`, and keeps it
 * after; unchanged settings come back as they are.
 */
export function withDirectPort(current: SettingsFile, pick: () => number): SettingsFile {
  const { direct } = current.remote
  if (!direct.enabled || direct.port !== null) return current
  const next = structuredClone(current)
  next.remote.direct.port = pick()
  return next
}

export function withAgentBinary(
  current: SettingsFile,
  harnessId: HarnessId,
  binaryPath: string,
): SettingsFile {
  const next = structuredClone(current)
  next.agents[harnessId] = { ...next.agents[harnessId], binaryPath }
  return next
}

/** An agent's name as stored: trimmed, and within `AGENT_NAME_CHARS`. */
export function agentName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  const control = [...name].some((char) => char.charCodeAt(0) < 0x20)
  if (name.length === 0 || [...name].length > AGENT_NAME_CHARS || control) {
    throw new SettingsError(`An agent's name must be 1 to ${AGENT_NAME_CHARS} characters`)
  }
  return name
}

/** Adds an agent. The caller checked that no other agent has the folder. */
export function withAddedAgent(current: SettingsFile, agent: AddedAgent): SettingsFile {
  if (isDefaultAgent(agent.id) || !MULTI_AGENT_HARNESSES.includes(harnessOf(agent.id))) {
    throw new SettingsError(`"${agent.id}" is not an agent that can be added`)
  }
  if (current.addedAgents.some((other) => other.id === agent.id)) {
    throw new SettingsError(`The agent "${agent.id}" exists already`)
  }
  const next = structuredClone(current)
  next.addedAgents.push({ ...agent, name: agentName(agent.name) })
  return next
}

export function withRenamedAgent(
  current: SettingsFile,
  agentId: AgentId,
  name: string,
): SettingsFile {
  const index = current.addedAgents.findIndex((agent) => agent.id === agentId)
  if (index < 0) throw new SettingsError(`No added agent "${agentId}"`)
  const next = structuredClone(current)
  next.addedAgents[index] = { ...next.addedAgents[index]!, name: agentName(name) }
  return next
}

/** Removes an added agent, and every setting that names it. */
export function withoutAgent(current: SettingsFile, agentId: AgentId): SettingsFile {
  if (!current.addedAgents.some((agent) => agent.id === agentId)) {
    throw new SettingsError(`No added agent "${agentId}"`)
  }
  const next = structuredClone(current)
  next.addedAgents = next.addedAgents.filter((agent) => agent.id !== agentId)
  next.mcp.kettu.off = next.mcp.kettu.off.filter((id) => id !== agentId)
  if (next.general.defaultAgent === agentId) next.general.defaultAgent = null
  return next
}

export function withShellPath(current: SettingsFile, shellPath: string): SettingsFile {
  const next = structuredClone(current)
  next.terminal.shellPath = shellPath
  return next
}

export interface LoadedSettings {
  settings: SettingsFile
  /** What was wrong with the file; any problem means it is quarantined before it is rewritten. */
  problems: string[]
  /** A file written by a newer version: used for this run but never overwritten. */
  readOnly: boolean
}

/**
 * Reads a parsed settings.json leniently: missing keys take their defaults, invalid values are
 * reported and replaced by defaults, unknown keys are ignored.
 */
export function parseSettingsFile(raw: unknown): LoadedSettings {
  const settings = structuredClone(DEFAULT_SETTINGS)
  if (!isRecord(raw))
    return { settings, problems: ['The file is not a JSON object'], readOnly: false }
  const version = raw.version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { settings, problems: ['"version" is missing or invalid'], readOnly: false }
  }
  const problems: string[] = []
  for (const section of FIELD_SECTIONS) {
    const value = raw[section]
    if (value === undefined) continue
    if (!isRecord(value)) {
      problems.push(`"${section}" must be an object`)
      continue
    }
    const fields: Record<string, Check> = SECTION_FIELDS[section]
    const target = settings[section] as Record<string, unknown>
    for (const [key, check] of Object.entries(fields)) {
      if (!(key in value)) continue
      const problem = check(value[key], `${section}.${key}`)
      if (problem) problems.push(problem)
      else target[key] = value[key]
    }
  }
  if (raw.agents !== undefined) {
    if (!isRecord(raw.agents)) problems.push('"agents" must be an object')
    else {
      for (const harnessId of HARNESS_IDS) {
        const entry = raw.agents[harnessId]
        if (entry === undefined) continue
        if (!isRecord(entry)) {
          problems.push(`"agents.${harnessId}" must be an object`)
          continue
        }
        // `cli`, the choice of a bundled CLI that no longer exists, is ignored like any unknown key.
        const stored: NonNullable<SettingsFile['agents'][HarnessId]> = {}
        if (entry.binaryPath !== undefined) {
          const problem = checkStoredPath(entry.binaryPath, `agents.${harnessId}.binaryPath`)
          if (problem) problems.push(problem)
          else stored.binaryPath = entry.binaryPath as string
        }
        if (entry.configDir !== undefined) {
          const problem = !CONFIG_VARIABLES[harnessId]
            ? `"agents.${harnessId}" has no configuration folder of its own`
            : checkStoredPath(entry.configDir, `agents.${harnessId}.configDir`)
          if (problem) problems.push(problem)
          else stored.configDir = entry.configDir as string
        }
        if (entry.hidden !== undefined) {
          const problem = isBoolean(entry.hidden, `agents.${harnessId}.hidden`)
          if (problem) problems.push(problem)
          else if (entry.hidden) stored.hidden = true
        }
        if (Object.keys(stored).length > 0) settings.agents[harnessId] = stored
      }
    }
  }
  if (raw.addedAgents !== undefined) {
    if (!Array.isArray(raw.addedAgents)) problems.push('"addedAgents" must be an array')
    else settings.addedAgents = readAddedAgents(raw.addedAgents, problems)
  }
  if (raw.proxy !== undefined) {
    const problem = checkProxy(raw.proxy, 'proxy')
    if (problem) problems.push(problem)
    else settings.proxy = normalizeProxy(raw.proxy as ProxySettings)
  }
  if (raw.mcp !== undefined) {
    if (!isRecord(raw.mcp)) problems.push('"mcp" must be an object')
    else settings.mcp = readMcp(raw.mcp)
  }
  if (raw.remote !== undefined) {
    if (!isRecord(raw.remote)) problems.push('"remote" must be an object')
    else settings.remote = readRemote(raw.remote, problems)
  }
  if (raw.terminal !== undefined) {
    if (!isRecord(raw.terminal)) problems.push('"terminal" must be an object')
    else {
      const { fontSize, shellPath } = raw.terminal
      if (fontSize !== undefined) {
        const problem = oneOf(...FONT_SIZES)(fontSize, 'terminal.fontSize')
        if (problem) problems.push(problem)
        else settings.terminal.fontSize = fontSize as SettingsFile['terminal']['fontSize']
      }
      if (shellPath !== undefined) {
        const problem = checkStoredPath(shellPath, 'terminal.shellPath')
        if (problem) problems.push(problem)
        else settings.terminal.shellPath = shellPath as string
      }
    }
  }
  return { settings, problems, readOnly: version > SETTINGS_VERSION }
}

/** Reads the added agents, dropping each that is invalid or repeats an id or a folder. */
function readAddedAgents(list: unknown[], problems: string[]): AddedAgent[] {
  const agents: AddedAgent[] = []
  for (const [index, entry] of list.entries()) {
    const path = `addedAgents[${index}]`
    if (!isRecord(entry)) {
      problems.push(`"${path}" must be an object`)
      continue
    }
    const { id, name, configDir, created } = entry
    if (!isAgentId(id) || isDefaultAgent(id)) {
      problems.push(`"${path}.id" must be an added agent's id`)
      continue
    }
    let stored: string
    try {
      stored = agentName(name)
    } catch (error) {
      problems.push(`"${path}.name": ${(error as Error).message}`)
      continue
    }
    const problem =
      checkStoredPath(configDir, `${path}.configDir`) ?? isBoolean(created, `${path}.created`)
    if (problem) {
      problems.push(problem)
      continue
    }
    if (agents.some((other) => other.id === id || other.configDir === configDir)) {
      problems.push(`"${path}" repeats another agent's id or folder`)
      continue
    }
    agents.push({ id, name: stored, configDir: configDir as string, created: created as boolean })
  }
  return agents
}

/** Reads the remote section, keeping each valid value and each valid address of the owner's. */
function readRemote(raw: Record<string, unknown>, problems: string[]): SettingsFile['remote'] {
  const remote = structuredClone(DEFAULT_SETTINGS.remote)
  const read = (value: unknown, path: string, check: Check, keep: () => void): void => {
    if (value === undefined) return
    const problem = check(value, path)
    if (problem) problems.push(problem)
    else keep()
  }
  read(raw.enabled, 'remote.enabled', isBoolean, () => (remote.enabled = raw.enabled as boolean))
  const direct = raw.direct
  if (direct === undefined) return remote
  if (!isRecord(direct)) {
    problems.push('"remote.direct" must be an object')
    return remote
  }
  read(direct.enabled, 'remote.direct.enabled', isBoolean, () => {
    remote.direct.enabled = direct.enabled as boolean
  })
  const isStoredPort: Check = (value, path) =>
    value === null || isPort(value) ? null : `"${path}" must be a port from 1 to 65535 or null`
  read(direct.port, 'remote.direct.port', isStoredPort, () => {
    remote.direct.port = direct.port as number | null
  })
  if (direct.addresses === undefined) return remote
  if (!Array.isArray(direct.addresses)) {
    problems.push('"remote.direct.addresses" must be an array')
    return remote
  }
  const addresses: DirectAddress[] = []
  const seen = new Set<string>()
  for (const [index, entry] of direct.addresses.entries()) {
    const path = `remote.direct.addresses[${index}]`
    const address = parseDirectAddress(entry)
    if (!address) problems.push(`"${path}" ${ADDRESS_PROBLEM}`)
    else if (seen.has(addressKey(address))) problems.push(`"${path}" repeats another address`)
    else if (addresses.length === MAX_OWN_ADDRESSES) {
      problems.push(`"${path}" is beyond the ${MAX_OWN_ADDRESSES} addresses kept`)
    } else {
      seen.add(addressKey(address))
      addresses.push(address)
    }
  }
  remote.direct.addresses = addresses
  return remote
}

/** Reads the MCP section leniently: an unknown or repeated id is dropped and the rest kept. */
function readMcp(raw: Record<string, unknown>): SettingsFile['mcp'] {
  const kettu = isRecord(raw.kettu) ? raw.kettu : {}
  const list = Array.isArray(kettu.off) ? kettu.off : []
  const off: AgentId[] = []
  for (const id of list) {
    if (isAgentId(id) && !off.includes(id)) off.push(id)
  }
  return { kettu: { off } }
}

export function hostSettings(settings: SettingsFile, systemLocale: Locale): HostSettings {
  return {
    locale: resolveLocale(settings.general.language, systemLocale),
    agents: structuredClone(settings.agents),
    addedAgents: structuredClone(settings.addedAgents),
    proxy: structuredClone(settings.proxy),
    git: { ...settings.git },
    mcp: structuredClone(settings.mcp),
    usage: { fromComputer: settings.usage.fromComputer },
    sessionTitles: settings.general.sessionTitles,
  }
}

// The sections `hostSettings` reads, besides the language.
const HOST_SECTIONS: ReadonlySet<SettingsSection> = new Set([
  'agents',
  'addedAgents',
  'proxy',
  'git',
  'mcp',
  'usage',
])

/** Whether a change touches what the agent host is sent; a language change is checked apart. */
export function reachesHost(changed: ReadonlySet<SettingsSection>): boolean {
  return [...changed].some((section) => HOST_SECTIONS.has(section))
}

export function terminalSettings(settings: SettingsFile): TerminalSettings {
  return { shellPath: settings.terminal.shellPath ?? null, fontSize: settings.terminal.fontSize }
}

export type SettingsSection = Exclude<keyof SettingsFile, 'version'>

/** The sections whose values differ, so each consumer is told only about what it uses. */
export function changedSections(before: SettingsFile, after: SettingsFile): Set<SettingsSection> {
  const changed = new Set<SettingsSection>()
  for (const key of Object.keys(after) as (keyof SettingsFile)[]) {
    if (key === 'version') continue
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changed.add(key)
  }
  return changed
}
