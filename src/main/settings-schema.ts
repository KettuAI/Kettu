// Pure validation and merging of settings.json and of the renderer's patches.

import {
  CONFIG_VARIABLES,
  DEFAULT_SETTINGS,
  type HostSettings,
  type ProxySettings,
  type SettingsFile,
  type SettingsPatch,
  type TerminalSettings,
  ZOOM_LEVELS,
} from '@shared/settings'
import { LANGUAGE_SETTINGS, resolveLocale, type Locale } from '@shared/locale'
import { THEME_ID } from '@shared/themes'
import { AGENT_IDS, type AgentId } from '@shared/thread'

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

const isThemeId: Check = (value, path) =>
  typeof value === 'string' && THEME_ID.test(value) ? null : `"${path}" must be a theme id`

const SECTION_FIELDS = {
  general: {
    language: oneOf(...LANGUAGE_SETTINGS),
    defaultAgent: oneOf(null, ...AGENT_IDS),
    sendKey: oneOf('enter', 'mod-enter'),
    restoreLastSession: isBoolean,
    confirmQuitWhileRunning: isBoolean,
    openAtLogin: isBoolean,
  },
  thread: { outlineSummaries: isBoolean },
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
const AGENT_CLI = oneOf('installed', 'bundled')
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

const AGENT_KEYS: readonly string[] = ['binaryPath', 'cli', 'configDir']

function checkStoredPath(value: unknown, path: string): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH) {
    return `"${path}" must be a non-empty path`
  }
  return value.includes('\0') ? `"${path}" must not contain NUL characters` : null
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
      for (const [agentId, entry] of Object.entries(value)) {
        if (!AGENT_IDS.includes(agentId as AgentId)) {
          problems.push(`Unknown agent "agents.${agentId}"`)
        } else if (
          !isRecord(entry) ||
          Object.keys(entry).some((key) => !AGENT_KEYS.includes(key))
        ) {
          problems.push(`"agents.${agentId}" accepts only "binaryPath", "cli" and "configDir"`)
        } else {
          if ('binaryPath' in entry && entry.binaryPath !== null) {
            problems.push(
              `"agents.${agentId}.binaryPath" can only be cleared with null; choose a program in the dialog`,
            )
          }
          if ('configDir' in entry) {
            const problem = !CONFIG_VARIABLES[agentId as AgentId]
              ? `"agents.${agentId}" has no configuration folder of its own`
              : entry.configDir !== null
                ? `"agents.${agentId}.configDir" can only be cleared with null; choose a folder in the dialog`
                : null
            if (problem) problems.push(problem)
          }
          const problem = 'cli' in entry ? AGENT_CLI(entry.cli, `agents.${agentId}.cli`) : null
          if (problem) problems.push(problem)
        }
      }
    } else if (section === 'proxy') {
      const problem = checkProxy(value, 'proxy')
      if (problem) problems.push(problem)
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
  if (patch.agents) {
    for (const agentId of Object.keys(patch.agents) as AgentId[]) {
      const change = patch.agents[agentId]
      const entry = { ...next.agents[agentId] }
      if (change?.binaryPath === null) delete entry.binaryPath
      if (change?.configDir === null) delete entry.configDir
      if (change?.cli) entry.cli = change.cli
      if (Object.keys(entry).length > 0) next.agents[agentId] = entry
      else delete next.agents[agentId]
    }
  }
  if (patch.terminal) {
    if (patch.terminal.fontSize !== undefined) next.terminal.fontSize = patch.terminal.fontSize
    if (patch.terminal.shellPath === null) delete next.terminal.shellPath
  }
  return next
}

export function withAgentBinary(
  current: SettingsFile,
  agentId: AgentId,
  binaryPath: string,
): SettingsFile {
  const next = structuredClone(current)
  next.agents[agentId] = { ...next.agents[agentId], binaryPath }
  return next
}

export function withAgentConfigDir(
  current: SettingsFile,
  agentId: AgentId,
  configDir: string,
): SettingsFile {
  if (!CONFIG_VARIABLES[agentId]) {
    throw new SettingsError(`"agents.${agentId}" has no configuration folder of its own`)
  }
  const next = structuredClone(current)
  next.agents[agentId] = { ...next.agents[agentId], configDir }
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
      for (const agentId of AGENT_IDS) {
        const entry = raw.agents[agentId]
        if (entry === undefined) continue
        if (!isRecord(entry)) {
          problems.push(`"agents.${agentId}" must be an object`)
          continue
        }
        const stored: NonNullable<SettingsFile['agents'][AgentId]> = {}
        if (entry.binaryPath !== undefined) {
          const problem = checkStoredPath(entry.binaryPath, `agents.${agentId}.binaryPath`)
          if (problem) problems.push(problem)
          else stored.binaryPath = entry.binaryPath as string
        }
        if (entry.cli !== undefined) {
          const problem = AGENT_CLI(entry.cli, `agents.${agentId}.cli`)
          if (problem) problems.push(problem)
          else stored.cli = entry.cli as 'installed' | 'bundled'
        }
        if (entry.configDir !== undefined) {
          const problem = !CONFIG_VARIABLES[agentId]
            ? `"agents.${agentId}" has no configuration folder of its own`
            : checkStoredPath(entry.configDir, `agents.${agentId}.configDir`)
          if (problem) problems.push(problem)
          else stored.configDir = entry.configDir as string
        }
        if (Object.keys(stored).length > 0) settings.agents[agentId] = stored
      }
    }
  }
  if (raw.proxy !== undefined) {
    const problem = checkProxy(raw.proxy, 'proxy')
    if (problem) problems.push(problem)
    else settings.proxy = normalizeProxy(raw.proxy as ProxySettings)
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

export function hostSettings(settings: SettingsFile, systemLocale: Locale): HostSettings {
  return {
    locale: resolveLocale(settings.general.language, systemLocale),
    agents: structuredClone(settings.agents),
    proxy: structuredClone(settings.proxy),
    git: { ...settings.git },
    usage: { fromComputer: settings.usage.fromComputer },
  }
}

// The sections `hostSettings` reads, besides the language.
const HOST_SECTIONS: ReadonlySet<SettingsSection> = new Set(['agents', 'proxy', 'git', 'usage'])

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
