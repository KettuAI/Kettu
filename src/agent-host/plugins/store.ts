// The host's record of each installed plugin: where it came from, the version in place, what it
// holds, the ids its items are kept by, and an update that waits for the user.

import path from 'node:path'
import { LISTING_ID } from '@shared/market-publish'
import { isPluginNoticeKind, type PluginNoticeKind } from '@shared/plugin-channels'
import {
  PLUGIN_FOLDERS,
  PLUGIN_ID,
  PLUGIN_ITEM_NAME,
  PLUGIN_NAME,
  PLUGIN_TOOL_NAME,
  PLUGIN_SETTING_CHARS,
  isPluginHookEvent,
  isPluginPermission,
  pluginItem,
  type PluginContents,
  type PluginHeldUpdate,
  type PluginItem,
  type PluginSettingValue,
  type PluginSource,
  type PluginTool,
} from '@shared/plugins'
import { SKILL_NAME } from '@shared/marketplace'
import { isAbsolutePath } from '../paths'
import { JsonFile, type LogFn, type Migration } from '../storage'
import { parseActions, parseChannels, parseLinks, parseMentions, parseViews } from './manifest'
import { safePackagePath } from './package'

export const PLUGINS_VERSION = 1
// No older formats exist yet; each future version adds its step here, with a test.
export const PLUGINS_MIGRATIONS: Readonly<Record<number, Migration>> = {}

/** A folder of a plugin's own folder that holds one version of the package. */
export const VERSION_DIR = /^v-[0-9a-f]{12}$/
const WORKFLOW_ID = /^[a-z0-9][a-z0-9-]{0,127}$/
const MAX_TEXT = 4_096
const MAX_ICON = 512 * 1024
const MAX_ITEMS = 500

export interface PluginRecord {
  id: string
  source: PluginSource
  development: boolean
  enabled: boolean
  installedAt: number
  updatedAt: number
  /** The commit or listing version in place; null for a folder. */
  revision: string | null
  /** For a listing: `@<publisher>/<slug>`. */
  origin: string | null
  /** The folder under the plugin's own that holds the package in place. */
  dir: string
  contents: PluginContents
  kept: { skills: string[]; servers: string[]; workflows: string[] }
  /** The skills and servers that were on when the plugin was turned off, turned on again with it. */
  wasOn: string[]
  previous: { dir: string; version: string | null; revision: string | null } | null
  held: PluginHeldUpdate | null
  /** The revision the user declined or rolled back from, which no check installs again. */
  declined: string | null
  updateError: string | null
  /** What the user set for the plugin's settings but a secret, by key. */
  values: Record<string, PluginSettingValue>
  /** The notice kinds the user sends to each declared channel, by its id; none by default. */
  channelKinds: Record<string, PluginNoticeKind[]>
}

export interface PluginsFile {
  version: 1
  plugins: Record<string, PluginRecord>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const text = (value: unknown, max = MAX_TEXT): value is string =>
  typeof value === 'string' && value.length <= max

const nullableText = (value: unknown): string | null => (text(value) ? value : null)

function sourceOf(value: unknown): PluginSource | null {
  if (!isRecord(value)) return null
  if (value.kind === 'local' && text(value.path) && isAbsolutePath(value.path, process.platform)) {
    return { kind: 'local', path: value.path }
  }
  if (value.kind === 'github' && text(value.url) && value.url.startsWith('https://github.com/')) {
    return { kind: 'github', url: value.url }
  }
  if (value.kind === 'kettu' && typeof value.id === 'string' && LISTING_ID.test(value.id)) {
    return { kind: 'kettu', id: value.id }
  }
  return null
}

function items(value: unknown, name: RegExp): PluginItem[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, MAX_ITEMS).flatMap((raw: unknown): PluginItem[] => {
    if (!isRecord(raw) || typeof raw.name !== 'string' || !name.test(raw.name)) return []
    // An item's path is joined to the package's folder, so one that could leave it is dropped.
    if (typeof raw.path !== 'string' || !safePackagePath(raw.path)) return []
    return [
      {
        name: raw.name,
        ...(text(raw.title, 200) ? { title: raw.title } : {}),
        description: text(raw.description) ? raw.description : '',
        path: raw.path,
      },
    ]
  })
}

function texts(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([, item]) => text(item))) as Record<
    string,
    string
  >
}

/** The views a stored package declares; ones that no longer read as views are left out. */
function viewsOf(value: unknown): PluginContents['views'] {
  try {
    return parseViews(value ?? undefined, 'views', [])
  } catch {
    return []
  }
}

/** The Search actions a stored package declares; ones that no longer read are left out. */
function actionsOf(value: unknown): NonNullable<PluginContents['actions']> {
  try {
    return parseActions(value ?? undefined, 'actions', [])
  } catch {
    return []
  }
}

/** The mention sources and link kinds a stored package declares; ones that no longer read are left out. */
function refsOf(
  value: Record<string, unknown>,
  permissions: readonly string[],
): Pick<PluginContents, 'mentions' | 'links'> {
  const read = <T>(parse: () => T[]): T[] => {
    try {
      return parse()
    } catch {
      return []
    }
  }
  return {
    mentions: permissions.includes('prompt.attach')
      ? read(() => parseMentions(value.mentions ?? undefined, 'mentions', []))
      : [],
    links: read(() => parseLinks(value.links ?? undefined, 'links', permissions, [])),
  }
}

/** The channels a stored package declares; ones that no longer read are left out. */
function channelsOf(value: unknown): NonNullable<PluginContents['channels']> {
  try {
    return parseChannels(value ?? undefined, 'channels', [])
  } catch {
    return []
  }
}

function contentsOf(value: unknown): PluginContents | null {
  if (!isRecord(value) || typeof value.name !== 'string' || !PLUGIN_NAME.test(value.name)) {
    return null
  }
  const script =
    isRecord(value.script) &&
    typeof value.script.entry === 'string' &&
    safePackagePath(value.script.entry) &&
    typeof value.script.api === 'number'
      ? { entry: value.script.entry, api: value.script.api }
      : null
  const folders = Object.fromEntries(
    PLUGIN_FOLDERS.map((kind) => [kind, items(value[kind], PLUGIN_ITEM_NAME)]),
  ) as Pick<PluginContents, (typeof PLUGIN_FOLDERS)[number]>
  const permissions = Array.isArray(value.permissions)
    ? value.permissions.filter(
        (item): item is string => typeof item === 'string' && isPluginPermission(item),
      )
    : []
  return {
    name: value.name,
    title: text(value.title, 200) && value.title !== '' ? value.title : value.name,
    description: text(value.description) ? value.description : '',
    version: nullableText(value.version),
    author: nullableText(value.author),
    homepage: nullableText(value.homepage),
    repository: nullableText(value.repository),
    license: nullableText(value.license),
    titles: texts(value.titles),
    descriptions: texts(value.descriptions),
    kettu: nullableText(value.kettu),
    icon: text(value.icon, MAX_ICON) && value.icon.startsWith('data:image/') ? value.icon : null,
    skills: items(value.skills, SKILL_NAME).map(({ name, description, path: folder }) => ({
      name,
      description,
      path: folder,
    })),
    servers: Array.isArray(value.servers)
      ? value.servers
          .slice(0, MAX_ITEMS)
          .flatMap((raw: unknown) =>
            isRecord(raw) &&
            typeof raw.name === 'string' &&
            PLUGIN_ITEM_NAME.test(raw.name) &&
            (raw.type === 'stdio' || raw.type === 'streamable-http' || raw.type === 'sse') &&
            text(raw.runs, 1_000_000)
              ? [{ name: raw.name, type: raw.type, runs: raw.runs }]
              : [],
          )
      : [],
    ...folders,
    script,
    permissions,
    events: Array.isArray(value.events)
      ? value.events.filter(
          (item): item is string => typeof item === 'string' && isPluginHookEvent(item),
        )
      : [],
    settings: Array.isArray(value.settings)
      ? (value.settings.filter(isRecord) as unknown as PluginContents['settings'])
      : [],
    tools: Array.isArray(value.tools)
      ? value.tools.filter(
          (item): item is PluginTool =>
            isRecord(item) &&
            typeof item.name === 'string' &&
            PLUGIN_TOOL_NAME.test(item.name) &&
            text(item.description) &&
            isRecord(item.inputSchema),
        )
      : [],
    views: viewsOf(value.views),
    actions: actionsOf(value.actions),
    ...refsOf(value, permissions),
    channels: channelsOf(value.channels),
    hooks: value.hooks === true,
    warnings: Array.isArray(value.warnings)
      ? value.warnings.filter((item): item is string => text(item)).slice(0, MAX_ITEMS)
      : [],
  }
}

function valuesOf(value: unknown): Record<string, PluginSettingValue> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, PluginSettingValue] =>
        typeof entry[1] === 'boolean' ||
        (typeof entry[1] === 'string' && entry[1].length <= PLUGIN_SETTING_CHARS),
    ),
  )
}

/** The picks of notice kinds by channel; a channel the package no longer declares keeps none. */
function channelKindsOf(
  value: unknown,
  contents: PluginContents,
): Record<string, PluginNoticeKind[]> {
  if (!isRecord(value)) return {}
  const out: Record<string, PluginNoticeKind[]> = {}
  for (const channel of contents.channels ?? []) {
    const picked = value[channel.id]
    if (!Array.isArray(picked)) continue
    const kinds = [...new Set(picked.filter(isPluginNoticeKind))]
    if (kinds.length > 0) out[channel.id] = kinds
  }
  return out
}

function ids(value: unknown, pluginId: string): string[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (item): item is string => typeof item === 'string' && pluginItem(item)?.pluginId === pluginId,
  )
}

function heldOf(value: unknown): PluginHeldUpdate | null {
  if (!isRecord(value) || !text(value.revision, 200) || typeof value.foundAt !== 'number') {
    return null
  }
  return {
    version: nullableText(value.version),
    revision: value.revision,
    script: value.script === true,
    permissions: Array.isArray(value.permissions)
      ? value.permissions.filter(
          (item): item is string => typeof item === 'string' && isPluginPermission(item),
        )
      : [],
    ...(Array.isArray(value.declared)
      ? {
          declared: value.declared.filter(
            (item): item is string => typeof item === 'string' && isPluginPermission(item),
          ),
        }
      : {}),
    foundAt: value.foundAt,
  }
}

/** Parses the file; a record that does not read is dropped alone. */
export function parsePluginsFile(data: Record<string, unknown>): PluginsFile | string {
  if (!isRecord(data.plugins)) return 'plugins is not an object'
  const plugins: PluginsFile['plugins'] = {}
  for (const [id, raw] of Object.entries(data.plugins)) {
    if (!PLUGIN_ID.test(id) || !isRecord(raw)) continue
    const source = sourceOf(raw.source)
    const contents = contentsOf(raw.contents)
    if (!source || !contents || typeof raw.dir !== 'string' || !VERSION_DIR.test(raw.dir)) continue
    if (typeof raw.installedAt !== 'number' || typeof raw.updatedAt !== 'number') continue
    const kept = isRecord(raw.kept) ? raw.kept : {}
    const previous =
      isRecord(raw.previous) &&
      typeof raw.previous.dir === 'string' &&
      VERSION_DIR.test(raw.previous.dir) &&
      raw.previous.dir !== raw.dir
        ? {
            dir: raw.previous.dir,
            version: nullableText(raw.previous.version),
            revision: nullableText(raw.previous.revision),
          }
        : null
    plugins[id] = {
      id,
      source,
      development: source.kind === 'local',
      enabled: raw.enabled !== false,
      installedAt: raw.installedAt,
      updatedAt: raw.updatedAt,
      revision: nullableText(raw.revision),
      origin: nullableText(raw.origin),
      dir: raw.dir,
      contents,
      kept: {
        skills: ids(kept.skills, id),
        servers: ids(kept.servers, id),
        workflows: Array.isArray(kept.workflows)
          ? kept.workflows.filter(
              (item): item is string => typeof item === 'string' && WORKFLOW_ID.test(item),
            )
          : [],
      },
      wasOn: ids(raw.wasOn, id),
      previous,
      held: heldOf(raw.held),
      declined: nullableText(raw.declined),
      updateError: nullableText(raw.updateError),
      values: valuesOf(raw.values),
      channelKinds: channelKindsOf(raw.channelKinds, contents),
    }
  }
  return { version: 1, plugins }
}

export function emptyPluginsFile(): PluginsFile {
  return { version: 1, plugins: {} }
}

export function pluginsFile(userDataPath: string, log: LogFn): JsonFile<PluginsFile> {
  return new JsonFile<PluginsFile>({
    file: path.join(userDataPath, 'state', 'kettu-plugins.json'),
    version: PLUGINS_VERSION,
    migrations: PLUGINS_MIGRATIONS,
    parse: parsePluginsFile,
    empty: emptyPluginsFile,
    log,
  })
}
