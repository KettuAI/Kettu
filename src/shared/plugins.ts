// Kettu's plugins: one package in the Agent Plugins format, installed once on the host, whose
// items every agent can use. Kettu's own content sits under the format's client namespace
// `sh.kettu`: that entry of the manifest's `extensions`, and the top-level `sh.kettu/` folder.

import type { McpSpec } from './marketplace'

export const PLUGIN_NAMESPACE = 'sh.kettu'
/** The only version of the `sh.kettu` entry this app reads. */
export const PLUGIN_FORMAT = 1
/** The plugin API versions a script may ask for. */
export const PLUGIN_API_VERSIONS: readonly number[] = [1]

/** An installed plugin's id: `p` and 12 hex digits. */
export const PLUGIN_ID = /^p[0-9a-f]{12}$/
/** A plugin's name as the format has it: lowercase letters, digits, `-` and `.`. */
export const PLUGIN_NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/
/** The name of an item in a `sh.kettu/` subfolder, and of an MCP server in `mcp.json`. */
export const PLUGIN_ITEM_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/
/** What names a package held between inspect and install. */
export const PLUGIN_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const ITEM_PREFIX = 'plugin:'

/** The id a plugin's skill or MCP server is kept by in the host's settings. */
export function pluginItemId(pluginId: string, name: string): string {
  return `${ITEM_PREFIX}${pluginId}:${name}`
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
const NETWORK_PREFIX = 'network:'
// A host name, or one with a leading `*.` for its subdomains.
const NETWORK_DOMAIN = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** Whether `text` is a permission a plugin may declare: one of the list, or `network:<domain>`. */
export function isPluginPermission(text: string): boolean {
  if ((PLUGIN_PERMISSIONS as readonly string[]).includes(text)) return true
  return text.startsWith(NETWORK_PREFIX) && NETWORK_DOMAIN.test(text.slice(NETWORK_PREFIX.length))
}

/** How much a permission lets a script do; the high ones show in red on the consent. */
export function permissionRisk(permission: string): 'normal' | 'caution' | 'high' {
  if (['sessions.content', 'requests.answer', 'sessions.start'].includes(permission)) return 'high'
  if (['prompt.attach', 'requests.check'].includes(permission)) return 'caution'
  return 'normal'
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

/** A setting the plugin declares; drawn and stored once plugin settings are. */
export interface PluginSetting {
  key: string
  type: 'boolean' | 'string' | 'select' | 'secret'
  title: string
  description?: string
  default?: string | boolean
  options?: { value: string; title: string }[]
}

/** A text by language tag, such as `en` and `zh-CN`. */
export type PluginTexts = Record<string, string>

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
  /** What the script asks for, as declared. Kept and shown; nothing runs yet. */
  permissions: string[]
  settings: PluginSetting[]
  /** The views the package declares, as written; drawn once plugin views are. */
  views: Record<string, unknown>[]
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
  permissions: string[]
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
}

/** A plugin's command, role, theme or template as its own feature reads it. */
export interface PluginResource extends PluginItem {
  pluginId: string
  plugin: string
  /** The file on the host. */
  file: string
}

/** The spec an MCP server of a plugin is kept with, and what it could not carry over. */
export interface PluginServerSpec {
  name: string
  spec: McpSpec
}
