// Kettu's plugins: one package in the Agent Plugins format, installed once on the host, whose
// items every agent can use. Kettu's own content sits under the format's client namespace
// `sh.kettu`: that entry of the manifest's `extensions`, and the top-level `sh.kettu/` folder.

import type { McpSpec } from './marketplace'
import type { PluginLinkDecl, PluginMentionDecl } from './plugin-refs'
import type { PluginChannelDecl, PluginNoticeKind } from './plugin-channels'
import type { PluginActionDecl, PluginViewDecl } from './plugin-views'

export const PLUGIN_NAMESPACE = 'sh.kettu'
/** The only version of the `sh.kettu` entry this app reads. */
export const PLUGIN_FORMAT = 1
/** The plugin API versions a script may ask for. */
export const PLUGIN_API_VERSIONS: readonly number[] = [1]

/** An installed plugin's id: `p` and 12 hex digits. */
export const PLUGIN_ID = /^p[0-9a-f]{12}$/
/** A key a plugin's setting is declared and addressed by. */
export const PLUGIN_SETTING_KEY = /^[a-z][a-zA-Z0-9_]{0,63}$/
/** A plugin's name as the format has it: lowercase letters, digits, `-` and `.`. */
export const PLUGIN_NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/
/** The name of an item in a `sh.kettu/` subfolder, and of an MCP server in `mcp.json`. */
export const PLUGIN_ITEM_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/
/** What names a package held between inspect and install. */
export const PLUGIN_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** What a plugin's tool is called by its own script: letters, digits and `_`, 24 characters at most. */
export const PLUGIN_TOOL_NAME = /^[a-z][a-z0-9_]{0,23}$/
/** A tool as Kettu's MCP service lists it: the plugin's short name, `__`, then the tool's name. */
const PLUGIN_TOOL_LISTED = /^[a-z0-9_]{1,24}__[a-z][a-z0-9_]{0,23}$/
export const PLUGIN_TOOL_LIMITS = {
  tools: 16,
  arguments: 16,
  description: 1_000,
  enumValues: 64,
  enumChars: 200,
} as const
/** What a plugin's own storage may hold: the JSON of its values in all, the keys and each key. */
export const PLUGIN_STORAGE_LIMITS = { bytes: 256 * 1024, keys: 1_000, keyChars: 128 } as const
/** A text setting's length at most, and a secret's size in bytes. */
export const PLUGIN_SETTING_CHARS = 2_048
export const PLUGIN_SECRET_BYTES = 8_192

const ITEM_PREFIX = 'plugin:'

/** The id a plugin's skill or MCP server is kept by in the host's settings. */
export function pluginItemId(pluginId: string, name: string): string {
  return `${ITEM_PREFIX}${pluginId}:${name}`
}

/** What a session's `startedBy` holds when a plugin started it: not the id of a session. */
export function pluginStarter(pluginId: string): string {
  return `${ITEM_PREFIX}${pluginId}`
}

/** The plugin and name a kept skill's or server's id names; null for any other source. */
export function pluginItem(id: string): { pluginId: string; name: string } | null {
  if (!id.startsWith(ITEM_PREFIX)) return null
  const rest = id.slice(ITEM_PREFIX.length)
  const colon = rest.indexOf(':')
  if (colon < 0) return null
  const pluginId = rest.slice(0, colon)
  const name = rest.slice(colon + 1)
  return PLUGIN_ID.test(pluginId) && PLUGIN_ITEM_NAME.test(name) ? { pluginId, name } : null
}

/** What a script may ask for besides its own settings and storage. */
export const PLUGIN_PERMISSIONS = [
  'sessions.summary',
  'tools',
  'prompt.attach',
  'requests.check',
  'sessions.content',
  'requests.answer',
  'sessions.start',
] as const
type FixedPermission = (typeof PLUGIN_PERMISSIONS)[number]
const NETWORK_PREFIX = 'network:'
// A host name, or one with a leading `*.` for its subdomains.
const NETWORK_DOMAIN = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** Whether `text` is a permission a plugin may declare: one of the list, or `network:<domain>`. */
export function isPluginPermission(text: string): boolean {
  if ((PLUGIN_PERMISSIONS as readonly string[]).includes(text)) return true
  return text.startsWith(NETWORK_PREFIX) && NETWORK_DOMAIN.test(text.slice(NETWORK_PREFIX.length))
}

/** The domain a `network:<domain>` permission names, `*.` included; null for any other. */
export function networkDomain(permission: string): string | null {
  if (!permission.startsWith(NETWORK_PREFIX)) return null
  const domain = permission.slice(NETWORK_PREFIX.length)
  return NETWORK_DOMAIN.test(domain) ? domain : null
}

/** Whether a host name is one a granted domain covers: it, or under it for a `*.` domain. */
export function domainCovers(domain: string, host: string): boolean {
  if (!domain.startsWith('*.')) return host === domain
  return host.endsWith(domain.slice(1)) && host.length > domain.length - 1
}

/**
 * Kettu's own events a manifest may name under `events`, each with the permission a plugin needs
 * to receive it. `session.beforeSend` and `session.permissionRequested` are hooks that may act;
 * every other one is only told.
 */
export const PLUGIN_HOOK_EVENTS = {
  'session.started': 'sessions.summary',
  'session.beforeSend': 'prompt.attach',
  'session.permissionRequested': 'requests.check',
  'session.toolFinished': 'sessions.summary',
  'session.turnEnded': 'sessions.summary',
  'session.needsUser': 'sessions.summary',
  'session.pullRequestChanged': 'sessions.summary',
  'task.stepStarted': 'sessions.summary',
  'task.stepEnded': 'sessions.summary',
} as const satisfies Record<string, FixedPermission>

export type PluginHookEvent = keyof typeof PLUGIN_HOOK_EVENTS

export function isPluginHookEvent(name: string): name is PluginHookEvent {
  return Object.hasOwn(PLUGIN_HOOK_EVENTS, name)
}

/** How much a permission lets a script do; the high ones show in red on the consent. */
export type PermissionRisk = 'normal' | 'caution' | 'high'

const PERMISSION_RISK: Readonly<Record<FixedPermission, PermissionRisk>> = {
  'sessions.summary': 'normal',
  tools: 'normal',
  'prompt.attach': 'caution',
  'requests.check': 'caution',
  'sessions.content': 'high',
  'requests.answer': 'high',
  'sessions.start': 'high',
}

export function permissionRisk(permission: string): PermissionRisk {
  return Object.hasOwn(PERMISSION_RISK, permission)
    ? PERMISSION_RISK[permission as FixedPermission]
    : 'normal'
}

// The catalog's names for each permission, under `plugin.permission` in the `marketplace` texts.
const PERMISSION_TEXT = {
  'sessions.summary': 'sessionsSummary',
  tools: 'tools',
  'prompt.attach': 'promptAttach',
  'requests.check': 'requestsCheck',
  'sessions.content': 'sessionsContent',
  'requests.answer': 'requestsAnswer',
  'sessions.start': 'sessionsStart',
} as const satisfies Record<FixedPermission, string>

type PermissionText = (typeof PERMISSION_TEXT)[FixedPermission] | 'network' | 'networkSubdomains'

/** A permission as the consent card lists it: its risk and the keys of its texts. */
export interface PluginPermissionInfo {
  permission: string
  risk: PermissionRisk
  /** Keys in the `marketplace` texts, in English and Chinese alike. */
  nameKey: `plugin.permission.${PermissionText}.name`
  descriptionKey: `plugin.permission.${PermissionText}.description`
  /** What the texts fill in: a network permission's domain as declared, a `*.` one with its `*.`. */
  params: { domain?: string }
}

/** Describes a permission for the consent card; null for one a plugin may not declare. */
export function describePermission(permission: string): PluginPermissionInfo | null {
  if (!isPluginPermission(permission)) return null
  const risk = permissionRisk(permission)
  const domain = networkDomain(permission)
  if (domain === null) {
    const text = PERMISSION_TEXT[permission as FixedPermission]
    return {
      permission,
      risk,
      nameKey: `plugin.permission.${text}.name`,
      descriptionKey: `plugin.permission.${text}.description`,
      params: {},
    }
  }
  const wildcard = domain.startsWith('*.')
  const text = wildcard ? 'networkSubdomains' : 'network'
  return {
    permission,
    risk,
    nameKey: `plugin.permission.${text}.name`,
    descriptionKey: `plugin.permission.${text}.description`,
    params: { domain },
  }
}

/** Where a plugin comes from. */
export type PluginSource =
  | { kind: 'local'; path: string } // a folder on the host with a plugin.json; in development
  | { kind: 'github'; url: string } // a repository or one folder in it, on github.com
  | { kind: 'kettu'; id: string } // a listing of the Kettu Marketplace, at its current version

/** The kinds of item the `sh.kettu/` folder holds, by its subfolder's name. */
export const PLUGIN_FOLDERS = ['commands', 'roles', 'workflows', 'themes', 'templates'] as const
export type PluginFolder = (typeof PLUGIN_FOLDERS)[number]

/** One item of a `sh.kettu/` subfolder: a file, or a folder with the kind's own file. */
export interface PluginItem {
  /** The file's or folder's name, which is what the item is known by. */
  name: string
  /** The name its own file gives it, when it gives one. */
  title?: string
  description: string
  /** The file that defines it, inside the package, with `/` between its parts. */
  path: string
}

export interface PluginSkill {
  name: string
  description: string
  /** Its folder inside the package. */
  path: string
}

/** An MCP server of the package's `mcp.json`. */
export interface PluginServer {
  /** Its name in `mcp.json`. */
  name: string
  type: 'stdio' | 'streamable-http' | 'sse'
  /** The command line or URL it runs, as the package writes it. */
  runs: string
}

/** A setting the plugin declares: drawn on its page in Settings and listed in the settings catalog. */
export interface PluginSetting {
  key: string
  type: 'boolean' | 'string' | 'select' | 'secret'
  title: string
  description?: string
  default?: string | boolean
  options?: { value: string; title: string }[]
}

export type PluginSettingValue = string | boolean

/**
 * What a setting holds now: the value set when it still fits the declaration, else the default,
 * else the type's own (off, empty, or a select's first option). A secret has none: its value
 * only ever lives in the key store.
 */
export function effectiveSetting(
  setting: PluginSetting,
  stored: unknown,
): PluginSettingValue | null {
  switch (setting.type) {
    case 'secret':
      return null
    case 'boolean':
      return typeof stored === 'boolean'
        ? stored
        : typeof setting.default === 'boolean'
          ? setting.default
          : false
    case 'string':
      return typeof stored === 'string'
        ? stored
        : typeof setting.default === 'string'
          ? setting.default
          : ''
    case 'select': {
      const options = setting.options ?? []
      const has = (value: unknown): value is string =>
        typeof value === 'string' && options.some((option) => option.value === value)
      if (has(stored)) return stored
      if (has(setting.default)) return setting.default
      return options[0]?.value ?? ''
    }
  }
}

/** A value for a setting as the declaration takes it, or why not. */
export function checkSetting(
  setting: PluginSetting,
  value: unknown,
): { value: PluginSettingValue } | { error: string } {
  switch (setting.type) {
    case 'secret':
      return { error: 'A secret is set apart from the other settings.' }
    case 'boolean':
      return typeof value === 'boolean' ? { value } : { error: 'It takes true or false.' }
    case 'string':
      if (typeof value !== 'string') return { error: 'It takes a text.' }
      return value.length <= PLUGIN_SETTING_CHARS
        ? { value }
        : { error: `It takes at most ${PLUGIN_SETTING_CHARS} characters.` }
    case 'select': {
      const values = (setting.options ?? []).map((option) => option.value)
      return typeof value === 'string' && values.includes(value)
        ? { value }
        : { error: `It takes one of ${values.map((item) => JSON.stringify(item)).join(', ')}.` }
    }
  }
}

/** One argument of a plugin's tool: the part of JSON Schema Kettu checks a call against. */
export interface PluginToolArgument {
  type: 'string' | 'number' | 'integer' | 'boolean'
  description?: string
  /** For a string: the only values it takes. */
  enum?: string[]
  minimum?: number
  maximum?: number
}

/** What `tools/list` shows of a tool's arguments: an object that takes only the ones named. */
export interface PluginToolSchema {
  type: 'object'
  properties: Record<string, PluginToolArgument>
  required?: string[]
  additionalProperties: false
}

/**
 * A tool the plugin's script gives agents. The script exports a function of the same name, which
 * gets the arguments as one object and answers with the text the agent reads.
 */
export interface PluginTool {
  name: string
  description: string
  inputSchema: PluginToolSchema
}

/** The name a plugin's tool has on Kettu's MCP service: its plugin's short name, `__`, its own. */
export function pluginToolName(pluginName: string, tool: string): string {
  const short = pluginName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+/, '')
    .slice(0, 24)
    .replace(/_+$/, '')
  return `${short || 'plugin'}__${tool}`
}

/** Whether a tool name has the shape of a plugin's tool on Kettu's MCP service. */
export function isPluginToolName(name: string): boolean {
  return PLUGIN_TOOL_LISTED.test(name)
}

/** The token that wakes a plugin for a call of one of its tools, which its activation lists. */
export function toolTrigger(tool: string): string {
  return `tool:${tool}`
}

/** A text by language tag, such as `en` and `zh-CN`. */
export type PluginTexts = Record<string, string>

/** A text in the language shown, else English, else the package's own field. */
export function pluginText(texts: PluginTexts, own: string, locale: string): string {
  const short = locale.split('-')[0] ?? locale
  return texts[locale] ?? texts[short] ?? texts.en ?? own
}

/** What a package holds and would run, read without installing or running any of it. */
export interface PluginContents {
  name: string
  /** The manifest's `displayName`, or its name. */
  title: string
  description: string
  version: string | null
  author: string | null
  homepage: string | null
  repository: string | null
  license: string | null
  /** The `sh.kettu` entry's titles and descriptions by language; empty without any. */
  titles: PluginTexts
  descriptions: PluginTexts
  /** The Kettu versions the package says it supports, as a semver range; null when it says none. */
  kettu: string | null
  /** The icon as a data URL; null without one Kettu shows. */
  icon: string | null
  skills: PluginSkill[]
  servers: PluginServer[]
  commands: PluginItem[]
  roles: PluginItem[]
  workflows: PluginItem[]
  themes: PluginItem[]
  templates: PluginItem[]
  /** The script's file inside the package and the plugin API version it asks for; null without one. */
  script: { entry: string; api: number } | null
  /** What the script asks for, as declared. */
  permissions: string[]
  /** The events of `PLUGIN_HOOK_EVENTS` that wake the script, as declared. */
  events: string[]
  settings: PluginSetting[]
  /** The tools the script gives agents; empty without the `tools` permission. */
  tools: PluginTool[]
  /** The views the package declares; its script gives their data. */
  views: PluginViewDecl[]
  /** The actions Search lists for it and its script runs; absent from a host older than them. */
  actions?: PluginActionDecl[]
  /** The sources of the composer's `@` menu; empty without the `prompt.attach` permission. */
  mentions: PluginMentionDecl[]
  /** The kinds of link in replies the plugin draws as references. */
  links: PluginLinkDecl[]
  /** The notification channels it declares; absent from a host older than them. */
  channels?: PluginChannelDecl[]
  /** Portable hooks in the package, which never run in Kettu. */
  hooks: boolean
  /** What was reported and left out: unknown manifest fields, items that do not read. */
  warnings: string[]
}

/** An inspected package waiting for the user's answer; nothing of it is installed or has run. */
export interface PluginPlan {
  /** Names the held package for plugins.install or plugins.discard. */
  token: string
  source: PluginSource
  contents: PluginContents
  /** The installed plugin this would replace, when the source is installed already. */
  replaces: string | null
  /** Why it cannot be installed as it is, such as a skill name already taken; Install stays off. */
  blocked: string | null
}

/** A newer version that waits for the user, since it adds a script or asks for more. */
export interface PluginHeldUpdate {
  version: string | null
  /** The commit or listing version that names it. */
  revision: string
  script: boolean
  /** The permissions it asks for that the installed version does not have. */
  permissions: string[]
  /** Every permission it declares, the ones the installed version has too; absent from older hosts. */
  declared?: string[]
  foundAt: number
}

/** A plugin installed on the host. */
export interface InstalledKettuPlugin {
  id: string
  source: PluginSource
  /** Added from a folder: only on this host, changed by Reload. */
  development: boolean
  enabled: boolean
  installedAt: number
  updatedAt: number
  /** The commit or listing version installed; null for a folder. */
  revision: string | null
  /** For a listing: `@<publisher>/<slug>`. */
  origin: string | null
  contents: PluginContents
  /** The ids its skills and MCP servers are kept by, and its workflows' ids in the library. */
  kept: { skills: string[]; servers: string[]; workflows: string[] }
  /** The version before the last update, which Roll back returns to; null without one. */
  previous: { version: string | null; revision: string | null } | null
  held: PluginHeldUpdate | null
  /** Why the last check for an update failed; null when it did not. */
  updateError: string | null
  /** What each declared setting but a secret holds now; absent from older hosts. */
  values?: Record<string, PluginSettingValue>
  /** The secrets that are set, by key, never their values; absent from older hosts. */
  secretsSet?: string[]
  /** The notice kinds the user sends to each declared channel, by its id; absent from older hosts. */
  channelKinds?: Record<string, PluginNoticeKind[]>
  /**
   * What its script is doing: `active` while loaded, `idle` until something wakes it, `disabled`
   * after crashing too often; null without a script or while the plugin is off. Absent from older
   * hosts.
   */
  scriptState?: 'idle' | 'active' | 'disabled' | null
}

/** A plugin's command, role, theme or template as its own feature reads it. */
export interface PluginResource extends PluginItem {
  pluginId: string
  /** The plugin's name, which qualifies its commands. */
  pluginName: string
  plugin: string
  /** The file on the host. */
  file: string
}

/** The spec an MCP server of a plugin is kept with, and what it could not carry over. */
export interface PluginServerSpec {
  name: string
  spec: McpSpec
}
