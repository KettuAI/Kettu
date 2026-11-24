// What the Marketplace shows of a Kettu plugin: the tags of what a package holds, its items for its
// page, and its permissions for the consent. They come from a package's contents, or from the
// names a listing's publisher check gave before anything was downloaded.

import type { IconSvgElement } from '@hugeicons/react'
import {
  CodeIcon,
  CommandLineIcon,
  Flowchart01Icon,
  Layout01Icon,
  PaintBoardIcon,
  PlugSocketIcon,
  SparklesIcon,
  UserSettings01Icon,
} from '@hugeicons/core-free-icons'
import type { PublishAdds } from '@shared/market-publish'
import {
  describePermission,
  pluginItem,
  pluginText,
  type InstalledKettuPlugin,
  type PermissionRisk,
  type PluginContents,
  type PluginServer,
} from '@shared/plugins'

/** The kinds of item a plugin holds, in the order its page lists them. */
export const ITEM_KINDS = [
  'skill',
  'server',
  'command',
  'role',
  'workflow',
  'theme',
  'template',
] as const
export type PluginItemKind = (typeof ITEM_KINDS)[number]

export const ITEM_ICON: Record<PluginItemKind, IconSvgElement> = {
  skill: SparklesIcon,
  server: PlugSocketIcon,
  command: CommandLineIcon,
  role: UserSettings01Icon,
  workflow: Flowchart01Icon,
  theme: PaintBoardIcon,
  template: Layout01Icon,
}

/** A small tag under a plugin's line: how many it holds of a kind, or its one server's name. */
export type PluginTag =
  | { kind: Exclude<PluginItemKind, 'server'>; count: number }
  | { kind: 'server'; count: number; name: string | null }
  | { kind: 'script' }

export const SCRIPT_ICON = CodeIcon

function tagsOf(
  counts: Record<PluginItemKind, number>,
  server: string | null,
  script: boolean,
): PluginTag[] {
  const tags: PluginTag[] = []
  for (const kind of ITEM_KINDS) {
    if (counts[kind] === 0) continue
    tags.push(
      kind === 'server'
        ? { kind, count: counts.server, name: counts.server === 1 ? server : null }
        : { kind, count: counts[kind] },
    )
  }
  if (script) tags.push({ kind: 'script' })
  return tags
}

/** The tags of what an installed or inspected package holds. */
export function contentsTags(contents: PluginContents): PluginTag[] {
  return tagsOf(
    {
      skill: contents.skills.length,
      server: contents.servers.length,
      command: contents.commands.length,
      role: contents.roles.length,
      workflow: contents.workflows.length,
      theme: contents.themes.length,
      template: contents.templates.length,
    },
    contents.servers[0]?.name ?? null,
    contents.script !== null,
  )
}

const ADDS_KIND: Record<string, PluginItemKind> = {
  skills: 'skill',
  servers: 'server',
  commands: 'command',
  roles: 'role',
  workflows: 'workflow',
  themes: 'theme',
  templates: 'template',
}

/** The tags of what a listing's publisher check says its version holds. */
export function addsTags(adds: PublishAdds[] | undefined): PluginTag[] {
  const counts = Object.fromEntries(ITEM_KINDS.map((kind) => [kind, 0])) as Record<
    PluginItemKind,
    number
  >
  let server: string | null = null
  let script = false
  for (const group of adds ?? []) {
    if (group.label === 'script') {
      script = true
      continue
    }
    const kind = ADDS_KIND[group.label]
    if (!kind) continue
    counts[kind] += group.items.length
    if (kind === 'server') server = group.items[0] ?? null
  }
  return tagsOf(counts, server, script)
}

/** How many items a package holds. */
export function itemCount(contents: PluginContents): number {
  return (
    contents.skills.length +
    contents.servers.length +
    contents.commands.length +
    contents.roles.length +
    contents.workflows.length +
    contents.themes.length +
    contents.templates.length
  )
}

export function pluginTitle(contents: PluginContents, locale: string): string {
  return pluginText(contents.titles, contents.title, locale)
}

export function pluginDescription(contents: PluginContents, locale: string): string {
  return pluginText(contents.descriptions, contents.description, locale)
}

/** One line of a plugin's page: what an item is, and a sentence about it. */
export interface PluginItemRow {
  kind: PluginItemKind
  title: string
  /** The sentence under the title, when the package gives one. */
  line: string | null
  /** For an MCP server: where it connects, or what it runs. */
  runs?: { url: string } | { command: string }
}

function serverRuns(server: PluginServer): PluginItemRow['runs'] {
  if (server.type === 'stdio') return { command: server.runs }
  const url = URL.parse(server.runs)
  return { url: url?.host ?? server.runs }
}

/** The rows of "In this plugin" for a package's contents. */
export function contentsRows(contents: PluginContents): PluginItemRow[] {
  const rows: PluginItemRow[] = []
  for (const skill of contents.skills) {
    rows.push({ kind: 'skill', title: skill.name, line: skill.description || null })
  }
  for (const server of contents.servers) {
    rows.push({ kind: 'server', title: server.name, line: null, runs: serverRuns(server) })
  }
  for (const [kind, items] of [
    ['command', contents.commands],
    ['role', contents.roles],
    ['workflow', contents.workflows],
    ['theme', contents.themes],
    ['template', contents.templates],
  ] as const) {
    for (const item of items) {
      rows.push({
        kind,
        title: kind === 'command' ? `/${item.name}` : (item.title ?? item.name),
        line: item.description || null,
      })
    }
  }
  return rows
}

/** The rows for a listing that has not been downloaded: names only, as its publisher check gave. */
export function addsRows(adds: PublishAdds[] | undefined): PluginItemRow[] {
  const rows: PluginItemRow[] = []
  for (const kind of ITEM_KINDS) {
    for (const group of adds ?? []) {
      if (ADDS_KIND[group.label] !== kind) continue
      for (const name of group.items) {
        rows.push({ kind, title: kind === 'command' ? `/${name}` : name, line: null })
      }
    }
  }
  return rows
}

/** The permissions a script declares, the ones that ask for most last. */
const RISK_ORDER: Record<PermissionRisk, number> = { normal: 0, caution: 1, high: 2 }

export interface PermissionRow {
  permission: string
  risk: PermissionRisk
  nameKey: string
  descriptionKey: string
  domain: string | null
}

export function permissionRows(permissions: readonly string[]): PermissionRow[] {
  return permissions
    .flatMap((permission) => {
      const info = describePermission(permission)
      return info
        ? [
            {
              permission,
              risk: info.risk,
              nameKey: info.nameKey,
              descriptionKey: info.descriptionKey,
              domain: info.params.domain ?? null,
            },
          ]
        : []
    })
    .sort((a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk])
}

/** The plugin an item of the skills or MCP servers kept came with, by its kept id. */
export function pluginOfItem(
  plugins: readonly InstalledKettuPlugin[] | null,
  id: string,
): InstalledKettuPlugin | null {
  const item = pluginItem(id)
  if (!item) return null
  return plugins?.find((plugin) => plugin.id === item.pluginId) ?? null
}

/** Whether a kept id is an item a plugin brought, whether or not the plugin is known yet. */
export function isPluginItem(id: string): boolean {
  return pluginItem(id) !== null
}

/** The host name and path of a GitHub address, without the scheme. */
export function githubShort(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

/** Whether text is a github.com address the host can read a plugin from. */
export function isGithubAddress(text: string): boolean {
  const url = URL.parse(text)
  return url?.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.length > 1
}

/** The key of the words that say what a plugin's script is doing. */
export function scriptStateKey(plugin: InstalledKettuPlugin): string {
  if (!plugin.enabled) return 'plugins.state.off'
  if (!plugin.contents.script) return 'plugins.state.noScript'
  return `plugins.state.${plugin.scriptState ?? 'idle'}`
}
