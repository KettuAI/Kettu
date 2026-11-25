// Kettu's plugins on the host: a package is inspected first, which reads it and runs nothing,
// and installed only once the user confirmed what the inspection showed. Each version lives in a
// folder of the plugin's own under the Marketplace's data; its skills and MCP servers go into
// the lists Kettu already keeps and its workflows into the workflow library, each marked with
// the plugin, and leave with it. Commands, roles, themes and templates are kept in the package
// and read from there. A script, its permissions and the views are kept and never run here: the
// plugin host runs a script, from what `scripts` lists.

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CommunityListing } from '@shared/market-community'
import type { MarketListing } from '@shared/market-publish'
import { serverName, type MarketServer, type MarketSkill } from '@shared/marketplace'
import {
  checkSetting,
  effectiveSetting,
  pluginItemId,
  pluginToolName,
  toolTrigger,
  type InstalledKettuPlugin,
  type PluginContents,
  type PluginPlan,
  type PluginResource,
  type PluginSettingValue,
  type PluginSource,
  type PluginTool,
} from '@shared/plugins'
import { linkTrigger, mentionTrigger, type PluginRefSource } from '@shared/plugin-refs'
import { channelTrigger, type PluginNoticeKind } from '@shared/plugin-channels'
import {
  actionTrigger,
  viewTrigger,
  type PluginActionDecl,
  type PluginViewDecl,
} from '@shared/plugin-views'
import type { ListEdit } from '@shared/settings'
import { HostError, notFound } from '../errors'
import { t } from '../i18n'
import { logText } from '../localized-error'
import { modeOf, type DownloadedFile } from '../marketplace/community'
import {
  branchHead,
  downloadTarball,
  folderFiles,
  githubSource,
  readTarball,
  tarballUrl,
  type TarLimits,
} from '../marketplace/tarball'
import type { JsonFile, LogFn } from '../storage'
import type { InstalledScript } from '../plugin-runtime/installed'
import { refusal } from './manifest'
import { serverSpec } from './mcp'
import {
  MANIFEST_FILE,
  PACKAGE_LIMITS,
  readPackage,
  readPackageFolder,
  type PackageFile,
  type PluginPackage,
} from './package'
import { emptyPluginsFile, type PluginRecord, type PluginsFile } from './store'

const TAR_LIMITS: TarLimits = {
  downloadBytes: 64 * 1024 * 1024,
  unpackedBytes: 256 * 1024 * 1024,
  timeoutMs: 120_000,
}
/** How long an inspected package waits for Install, and how many wait at once. */
const PLAN_MS = 15 * 60_000
const MAX_PLANS = 4
const FIRST_CHECK_MS = 60_000
export const UPDATE_CHECK_MS = 6 * 60 * 60_000
const PARTIAL = '.partial-'

/** The lists of the host's settings a plugin's skills and servers are kept in. */
export interface PluginSettings {
  skills: readonly MarketSkill[]
  servers: readonly MarketServer[]
}

/** Where a plugin's workflow came from, as the workflow library records it. */
export interface PluginWorkflowOrigin {
  kind: 'plugin'
  pluginId: string
  /** The workflow's name in the package. */
  name: string
  /** The plugin's title. */
  plugin: string
}

export interface PluginsDeps {
  userDataPath: string
  file: Pick<JsonFile<PluginsFile>, 'load' | 'save' | 'flush'>
  log: LogFn
  appVersion: string
  /** The lists as their owner holds them now. */
  settings(): Promise<PluginSettings>
  /** Edits the lists where their owner holds them; removes apply first. */
  editSettings(edit: {
    skills?: ListEdit<MarketSkill>
    servers?: ListEdit<MarketServer>
  }): Promise<void>
  /** Copies a skill's files into the skills Kettu keeps, in place of any copy before. */
  keepSkill(id: string, name: string, files: PackageFile[]): Promise<void>
  workflows: {
    /** Writes a plugin's workflow, unapproved unless its text is the one approved; gives its id. */
    install(text: string, origin: PluginWorkflowOrigin): Promise<string>
    /** Removes the plugin's workflows, but for those named in `keep`. */
    remove(pluginId: string, keep?: readonly string[]): Promise<void>
    /** A plugin was turned on or off, which its workflows follow. */
    changed(): void
  }
  /** A plugin listing of the Kettu Marketplace, its current version downloaded and checked. */
  kettu(id: string): Promise<{ listing: MarketListing; files: DownloadedFile[] }>
  listing(id: string): Promise<CommunityListing>
  /** Counts an install or update of a listing's version. */
  count?(id: string, version: string, reason: 'install' | 'update'): void
  changed(): void
  /** What a plugin's script is doing in the plugin host. */
  scriptState?(pluginId: string): 'idle' | 'active' | 'disabled'
  /** The keys of a plugin's secrets that are set, from the key store; never their values. */
  secretsSet?(pluginId: string): string[]
  /** A plugin was removed, so what it kept elsewhere goes: its secrets and its storage. */
  removed?(pluginId: string): void
  /** A setting of a plugin was set, which its script is told of when it is loaded. */
  settingChanged?(pluginId: string, key: string): void
  fetch?: typeof fetch
  now?: () => number
}

/** A channel of a plugin that is on, with the notice kinds the user sends to it. */
export interface ChannelRoute {
  pluginId: string
  channel: string
  kinds: readonly PluginNoticeKind[]
  /** The permissions of the version in place, which say what a notice tells the script. */
  permissions: readonly string[]
}

/** A tool of a plugin that is on, with the plugin it belongs to. */
export interface InstalledTool extends PluginTool {
  pluginId: string
  /** The plugin's name, which its tools are listed under. */
  pluginName: string
  /** The plugin's title, for what is shown. */
  plugin: string
}

/** A source's package as fetched: nothing of it is written or has run. */
interface Fetched {
  pkg: PluginPackage
  revision: string | null
  origin: string | null
}

interface Plan extends Fetched {
  source: PluginSource
  at: number
}

/** What a newer version asks for that the one in place does not. */
export function addedAccess(
  before: Pick<PluginContents, 'script' | 'permissions'>,
  after: Pick<PluginContents, 'script' | 'permissions'>,
): { script: boolean; permissions: string[] } {
  return {
    script: before.script === null && after.script !== null,
    permissions: after.permissions.filter((item) => !before.permissions.includes(item)),
  }
}

function sourceKey(source: PluginSource): string {
  if (source.kind === 'local') return `local:${path.resolve(source.path)}`
  if (source.kind === 'kettu') return `kettu:${source.id}`
  const github = githubSource(source.url)
  return github
    ? `github:${github.owner}/${github.repo}/${github.path}`.toLowerCase()
    : `github:${source.url}`
}

function pluginId(source: PluginSource): string {
  return `p${createHash('sha256').update(sourceKey(source)).digest('hex').slice(0, 12)}`
}

export class PluginsService {
  private data: PluginsFile | null = null
  private loading: Promise<PluginsFile> | null = null
  private readonly plans = new Map<string, Plan>()
  /** Changes run one at a time. */
  private queue: Promise<unknown> = Promise.resolve()
  private timers: ReturnType<typeof setTimeout>[] = []
  private readonly now: () => number

  constructor(private readonly deps: PluginsDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Where every plugin's folder lives. */
  get root(): string {
    return path.join(this.deps.userDataPath, 'marketplace', 'kettu-plugins')
  }

  /** A plugin's own folder: its packages, and what it keeps, which go when it does. */
  folderOf(id: string): string {
    return path.join(this.root, id)
  }

  /** The folder a record's package is in. */
  private packageDir(record: Pick<PluginRecord, 'id' | 'dir'>): string {
    return path.join(this.folderOf(record.id), record.dir)
  }

  /** A plugin's own folder for what its servers write, which updates keep. */
  private dataDir(id: string): string {
    return path.join(this.folderOf(id), 'data')
  }

  /** Checks for updates a minute after the host starts, then every six hours. */
  start(): void {
    const check = (): void => {
      void this.checkUpdates().catch((error: unknown) => {
        this.deps.log('warn', `Could not check the plugins for updates: ${logText(error)}`)
      })
    }
    const first = setTimeout(check, FIRST_CHECK_MS)
    const every = setInterval(check, UPDATE_CHECK_MS)
    first.unref()
    every.unref()
    this.timers = [first, every]
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
  }

  flush(): Promise<void> {
    return this.deps.file.flush()
  }

  async list(): Promise<InstalledKettuPlugin[]> {
    const file = await this.load()
    return Object.values(file.plugins)
      .sort((a, b) => a.contents.title.localeCompare(b.contents.title))
      .map((record) => this.installed(record))
  }

  /** One installed plugin as `list` shows it. */
  async view(id: string): Promise<InstalledKettuPlugin> {
    return this.installed(await this.record(id))
  }

  /** A plugin's title for the thread's lines; null when it is not installed. */
  titleOf(id: string): string | null {
    return this.data?.plugins[id]?.contents.title ?? null
  }

  /** Whether a plugin is installed and on; its workflows cannot start a task while it is off. */
  on(id: string): boolean {
    return this.data?.plugins[id]?.enabled === true
  }

  /** The views of a plugin that is on and has a script; none otherwise. */
  views(id: string): PluginViewDecl[] {
    const record = this.data?.plugins[id]
    return record?.enabled && record.contents.script ? [...record.contents.views] : []
  }

  /** The Search actions of a plugin that is on and has a script; none otherwise. */
  actions(id: string): PluginActionDecl[] {
    const record = this.data?.plugins[id]
    return record?.enabled && record.contents.script ? [...(record.contents.actions ?? [])] : []
  }

  /**
   * What the plugins that are on and have a script declare for the composer's `@` menu, for links
   * in replies and as tools, in the order the plugins were installed. A plugin that declares none
   * of them is left out.
   */
  refSources(): PluginRefSource[] {
    const toolsOf = (record: PluginRecord): string[] =>
      record.contents.permissions.includes('tools')
        ? record.contents.tools.map((tool) => pluginToolName(record.contents.name, tool.name))
        : []
    return Object.values(this.data?.plugins ?? {})
      .filter(
        (record) =>
          record.enabled &&
          record.contents.script !== null &&
          (record.contents.mentions.length > 0 ||
            record.contents.links.length > 0 ||
            toolsOf(record).length > 0),
      )
      .sort((a, b) => a.installedAt - b.installedAt || a.id.localeCompare(b.id))
      .map((record) => ({
        pluginId: record.id,
        name: record.contents.name,
        title: record.contents.title,
        icon: record.contents.icon,
        mentions: record.contents.mentions,
        links: record.contents.links,
        tools: toolsOf(record),
      }))
  }

  /**
   * The scripts of the plugins that are on, each with its file on the host and the permissions
   * of the version in place. An update that waits for the user is not in place, so a script
   * never has what only that update asks for. A script is woken by the events its manifest
   * names, by the views and actions it declares, and by nothing else.
   */
  scripts(): InstalledScript[] {
    return Object.values(this.data?.plugins ?? {}).flatMap((record) =>
      record.enabled && record.contents.script
        ? [
            {
              id: record.id,
              scriptPath: path.join(this.packageDir(record), record.contents.script.entry),
              activation: [
                ...record.contents.events,
                ...record.contents.views.map((view) => viewTrigger(view.id)),
                ...record.contents.mentions.map((source) => mentionTrigger(source.id)),
                ...record.contents.links.map((link) => linkTrigger(link.id)),
                ...(record.contents.permissions.includes('tools')
                  ? record.contents.tools.map((tool) => toolTrigger(tool.name))
                  : []),
                ...(record.contents.actions ?? []).map((action) => actionTrigger(action.id)),
                ...(record.contents.channels ?? []).map((channel) => channelTrigger(channel.id)),
              ],
              revision: `${record.dir}:${record.updatedAt}`,
              permissions: [...record.contents.permissions],
            },
          ]
        : [],
    )
  }

  /**
   * The tools of the plugins that are on, a plugin's that has a script and the `tools` permission
   * of the version in place, in the order the plugins were installed.
   */
  tools(): InstalledTool[] {
    return Object.values(this.data?.plugins ?? {})
      .filter(
        (record) =>
          record.enabled &&
          record.contents.script !== null &&
          record.contents.permissions.includes('tools'),
      )
      .sort((a, b) => a.installedAt - b.installedAt || a.id.localeCompare(b.id))
      .flatMap((record) =>
        record.contents.tools.map((tool) => ({
          ...tool,
          pluginId: record.id,
          pluginName: record.contents.name,
          plugin: record.contents.title,
        })),
      )
  }

  /**
   * The channels of the plugins that are on and have a script, each with the kinds the user sends
   * to it. A channel with none is left out, since no notice is told to it.
   */
  channelRoutes(): ChannelRoute[] {
    return Object.values(this.data?.plugins ?? {}).flatMap((record) =>
      record.enabled && record.contents.script
        ? (record.contents.channels ?? []).flatMap((channel) => {
            const kinds = record.channelKinds[channel.id] ?? []
            return kinds.length === 0
              ? []
              : [
                  {
                    pluginId: record.id,
                    channel: channel.id,
                    kinds,
                    permissions: record.contents.permissions,
                  },
                ]
          })
        : [],
    )
  }

  /** Picks which kinds of notice go to one of the plugin's channels; none turns it off. */
  setChannelKinds(
    id: string,
    channel: string,
    kinds: readonly PluginNoticeKind[],
  ): Promise<InstalledKettuPlugin> {
    return this.queued(async () => {
      const record = await this.record(id)
      if (!(record.contents.channels ?? []).some((item) => item.id === channel)) {
        throw new HostError('invalid_params', t('plugins.noChannel', { channel }))
      }
      const picked = [...new Set(kinds)]
      const before = record.channelKinds[channel] ?? []
      if (picked.length !== before.length || picked.some((kind) => !before.includes(kind))) {
        if (picked.length === 0) delete record.channelKinds[channel]
        else record.channelKinds[channel] = picked
        this.save()
      }
      return this.installed(record)
    })
  }

  /** What a setting of the plugin holds now, for its script; a secret is kept elsewhere. */
  settingValue(id: string, key: string): PluginSettingValue {
    const record = this.data?.plugins[id]
    const setting = record?.contents.settings.find((item) => item.key === key)
    if (!record || !setting || setting.type === 'secret') {
      throw new Error(`The plugin declares no setting "${key.slice(0, 100)}" besides its secrets`)
    }
    return effectiveSetting(setting, record.values[key])!
  }

  /** Whether the plugin declares a secret under this key. */
  declaresSecret(id: string, key: string): boolean {
    return (
      this.data?.plugins[id]?.contents.settings.some(
        (item) => item.key === key && item.type === 'secret',
      ) ?? false
    )
  }

  /** Sets a setting that is not a secret, to a value its declaration takes. */
  setSetting(id: string, key: string, value: unknown): Promise<InstalledKettuPlugin> {
    return this.queued(async () => {
      const record = await this.record(id)
      const setting = record.contents.settings.find((item) => item.key === key)
      if (!setting) throw new HostError('invalid_params', t('plugins.noSetting', { key }))
      const checked = checkSetting(setting, value)
      if ('error' in checked) throw new HostError('invalid_params', checked.error)
      if (effectiveSetting(setting, record.values[key]) !== checked.value) {
        record.values[key] = checked.value
        this.save()
        this.deps.settingChanged?.(id, key)
      }
      return this.installed(record)
    })
  }

  /**
   * The commands, roles, themes or templates of the plugins that are on, each with its file on
   * the host. Their own features read and use them.
   */
  async resources(kind: 'commands' | 'roles' | 'themes' | 'templates'): Promise<PluginResource[]> {
    const file = await this.load()
    return Object.values(file.plugins)
      .filter((record) => record.enabled)
      .flatMap((record) =>
        record.contents[kind].map((item) => ({
          ...item,
          pluginId: record.id,
          pluginName: record.contents.name,
          plugin: record.contents.title,
          file: path.join(this.packageDir(record), ...item.path.split('/')),
        })),
      )
  }

  /**
   * Reads a source's package and says what it holds and would run. Fetching it is all that
   * happens: nothing is written into the host's data and nothing of it runs.
   */
  async inspect(source: PluginSource): Promise<PluginPlan> {
    const fetched = await this.fetch(source)
    const file = await this.load()
    const id = pluginId(source)
    const token = randomUUID()
    for (const [key, plan] of this.plans) {
      if (this.now() - plan.at >= PLAN_MS) this.plans.delete(key)
    }
    while (this.plans.size >= MAX_PLANS) this.plans.delete(this.plans.keys().next().value!)
    this.plans.set(token, { ...fetched, source, at: this.now() })
    return {
      token,
      source,
      contents: fetched.pkg.contents,
      replaces: file.plugins[id] ? id : null,
      blocked: await this.blocked(id, fetched.pkg),
    }
  }

  /** Forgets an inspected package the user did not install. */
  discard(token: string): void {
    this.plans.delete(token)
  }

  /** Installs the package an inspection showed, in place of the plugin from the same source. */
  install(token: string): Promise<InstalledKettuPlugin> {
    return this.queued(async () => {
      const plan = this.plans.get(token)
      if (!plan || this.now() - plan.at >= PLAN_MS) {
        this.plans.delete(token)
        throw notFound(t('plugins.noPlan'))
      }
      const id = pluginId(plan.source)
      const file = await this.load()
      const before = file.plugins[id]
      const record = await this.put(id, plan.source, plan, before, false)
      this.plans.delete(token)
      if (plan.source.kind === 'kettu' && record.revision) {
        this.deps.count?.(plan.source.id, record.revision, before ? 'update' : 'install')
      }
      return this.installed(record)
    })
  }

  /** Removes a plugin with every item it brought and its own folder. */
  uninstall(id: string): Promise<void> {
    return this.queued(async () => {
      const record = await this.record(id)
      await this.deps.editSettings({
        skills: { remove: record.kept.skills },
        servers: { remove: record.kept.servers },
      })
      await this.deps.workflows.remove(id)
      await rm(this.folderOf(id), { recursive: true, force: true })
      const file = await this.load()
      delete file.plugins[id]
      this.save()
      this.deps.removed?.(id)
    })
  }

  /**
   * Turns a plugin off or on. Off turns off the skills and servers of it that were on, which on
   * turns on again; its workflows, commands, roles, themes and templates follow the plugin.
   */
  setEnabled(id: string, enabled: boolean): Promise<InstalledKettuPlugin> {
    return this.queued(async () => {
      const record = await this.record(id)
      if (record.enabled === enabled) return this.installed(record)
      const settings = await this.deps.settings()
      const own = new Set([...record.kept.skills, ...record.kept.servers])
      const switched = <T extends { id: string; on: boolean }>(list: readonly T[]): T[] =>
        list
          .filter(
            (item) => own.has(item.id) && (enabled ? record.wasOn.includes(item.id) : item.on),
          )
          .map((item) => ({ ...item, on: enabled }))
      const skills = switched(settings.skills)
      const servers = switched(settings.servers)
      await this.deps.editSettings({ skills: { put: skills }, servers: { put: servers } })
      record.wasOn = enabled ? [] : [...skills, ...servers].map((item) => item.id)
      record.enabled = enabled
      this.save()
      this.deps.workflows.changed()
      return this.installed(record)
    })
  }

  /** Copies a development plugin's folder again, as it is now, in place of the copy installed. */
  reload(id: string): Promise<InstalledKettuPlugin> {
    return this.queued(async () => {
      const record = await this.record(id)
      if (!record.development) throw new HostError('invalid_params', t('plugins.notDevelopment'))
      const fetched = await this.fetch(record.source)
      return this.installed(await this.put(id, record.source, fetched, record, false))
    })
  }

  /**
   * Looks for a newer version of each plugin from GitHub or the Kettu Marketplace, or of one.
   * A newer version is installed, and the one before kept to roll back to; one that adds a
   * script or asks for more permissions waits for the user instead, with what it adds.
   */
  checkUpdates(only?: string): Promise<InstalledKettuPlugin[]> {
    return this.queued(async () => {
      const file = await this.load()
      const records = only === undefined ? Object.values(file.plugins) : [await this.record(only)]
      for (const record of records) {
        if (record.development) continue
        try {
          await this.update(record, false)
          record.updateError = null
        } catch (error) {
          record.updateError = (error as Error).message
          this.deps.log('warn', `Could not update the plugin ${record.id}: ${logText(error)}`)
        }
      }
      if (records.length > 0) this.save()
      return this.list()
    })
  }

  /** Installs the update that waits, once the user agreed to what it adds. */
  applyUpdate(id: string): Promise<InstalledKettuPlugin> {
    return this.queued(async () => {
      const record = await this.record(id)
      if (!record.held) throw new HostError('conflict', t('plugins.noUpdate'))
      await this.update(record, true)
      record.updateError = null
      this.save()
      return this.installed(record)
    })
  }

  /** Stays on the version in place; the declined one is not offered again. */
  declineUpdate(id: string): Promise<InstalledKettuPlugin> {
    return this.queued(async () => {
      const record = await this.record(id)
      if (!record.held) throw new HostError('conflict', t('plugins.noUpdate'))
      record.declined = record.held.revision
      record.held = null
      this.save()
      return this.installed(record)
    })
  }

  /** Goes back to the version before the last update, which no check then installs again. */
  rollBack(id: string): Promise<InstalledKettuPlugin> {
    return this.queued(async () => {
      const record = await this.record(id)
      const { previous } = record
      if (!previous) throw new HostError('conflict', t('plugins.noPrevious'))
      const dir = this.packageDir({ id, dir: previous.dir })
      const pkg = readPackage(await readPackageFolder(dir), this.deps.appVersion)
      const left = { dir: record.dir, revision: record.revision }
      await this.apply(record, pkg, previous.dir)
      record.revision = previous.revision
      record.previous = null
      record.declined = left.revision
      record.held = null
      record.updatedAt = this.now()
      this.save()
      await rm(this.packageDir({ id, dir: left.dir }), { recursive: true, force: true })
      return this.installed(record)
    })
  }

  /**
   * Fetches the source's current version and installs it over `record` when it is newer; with
   * `agreed`, the user answered the update that waited, which is installed unless it grew since.
   */
  private async update(record: PluginRecord, agreed: boolean): Promise<void> {
    if (!agreed && !(await this.moved(record))) return
    const fetched = await this.fetch(record.source)
    if (fetched.revision === record.revision) {
      record.held = null
      return
    }
    if (!agreed && fetched.revision === record.declined) return
    const added = addedAccess(record.contents, fetched.pkg.contents)
    const shown = record.held
    const waits = added.script || added.permissions.length > 0
    const grew =
      shown !== null &&
      ((added.script && !shown.script) ||
        added.permissions.some((item) => !shown.permissions.includes(item)))
    if (waits && (!agreed || grew)) {
      record.held = {
        version: fetched.pkg.contents.version,
        revision: fetched.revision ?? '',
        ...added,
        declared: [...fetched.pkg.contents.permissions],
        foundAt: shown?.revision === fetched.revision ? shown.foundAt : this.now(),
      }
      this.save()
      if (agreed) throw new HostError('conflict', t('plugins.updateChanged'))
      return
    }
    await this.put(record.id, record.source, fetched, record, true)
    if (record.source.kind === 'kettu' && fetched.revision) {
      this.deps.count?.(record.source.id, fetched.revision, 'update')
    }
  }

  /** Whether the source may have a version other than the one in place, asked cheaply. */
  private async moved(record: PluginRecord): Promise<boolean> {
    const { source } = record
    if (source.kind === 'kettu') {
      const found = await this.deps.listing(source.id)
      if (found.state !== 'listed') return false
      return found.listing.version !== record.revision && found.listing.version !== record.declined
    }
    if (source.kind !== 'github') return false
    const github = githubSource(source.url)
    if (!github) return false
    const head = await branchHead(
      { owner: github.owner, repo: github.repo, branch: github.ref ?? 'HEAD' },
      null,
      this.deps.fetch,
    )
    if (head.kind !== 'commit') return true
    return head.commit !== record.revision && head.commit !== record.declined
  }

  /**
   * Writes a fetched package as the plugin's version in place and brings its items in line.
   * With `keep`, the version before stays on disk to roll back to; a failure leaves the plugin
   * as it was, and a first install that fails leaves nothing.
   */
  private async put(
    id: string,
    source: PluginSource,
    fetched: Fetched,
    before: PluginRecord | undefined,
    keep: boolean,
  ): Promise<PluginRecord> {
    const problem = await this.blocked(id, fetched.pkg)
    if (problem) throw new HostError('conflict', problem)
    const dir = `v-${randomBytes(6).toString('hex')}`
    await this.writePackage(this.packageDir({ id, dir }), fetched.pkg.files)
    const file = await this.load()
    const record: PluginRecord = before ?? {
      id,
      source,
      development: source.kind === 'local',
      enabled: true,
      installedAt: this.now(),
      updatedAt: this.now(),
      revision: null,
      origin: null,
      dir,
      contents: fetched.pkg.contents,
      kept: { skills: [], servers: [], workflows: [] },
      wasOn: [],
      previous: null,
      held: null,
      declined: null,
      updateError: null,
      values: {},
      channelKinds: {},
    }
    const was = before ? { dir: before.dir, contents: before.contents } : null
    try {
      await this.apply(record, fetched.pkg, dir)
    } catch (error) {
      await this.undo(record, was)
      await rm(this.packageDir({ id, dir }), { recursive: true, force: true })
      throw error
    }
    const old = was
      ? { dir: was.dir, version: was.contents.version, revision: record.revision }
      : null
    const stale = record.previous?.dir
    record.previous = keep && old ? old : null
    record.revision = fetched.revision
    record.origin = fetched.origin
    record.held = null
    record.declined = null
    record.updatedAt = this.now()
    file.plugins[id] = record
    this.save()
    for (const gone of [stale, record.previous ? undefined : old?.dir]) {
      if (gone && gone !== dir) {
        await rm(this.packageDir({ id, dir: gone }), { recursive: true, force: true })
      }
    }
    return record
  }

  /** After a failed change: the version before is applied again, or a first install removed. */
  private async undo(
    record: PluginRecord,
    was: { dir: string; contents: PluginContents } | null,
  ): Promise<void> {
    try {
      if (was) {
        const files = await readPackageFolder(this.packageDir({ id: record.id, dir: was.dir }))
        await this.apply(record, readPackage(files, this.deps.appVersion), was.dir)
        return
      }
      await this.deps.editSettings({
        skills: { remove: record.kept.skills },
        servers: { remove: record.kept.servers },
      })
      await this.deps.workflows.remove(record.id)
      await rm(this.folderOf(record.id), { recursive: true, force: true })
    } catch (error) {
      this.deps.log('warn', `Could not undo a change to the plugin ${record.id}: ${logText(error)}`)
    }
  }

  /**
   * Brings the plugin's items in line with the package in `dir`: its skills and servers in the
   * settings' lists, keeping the agents and the switch of each one already there, and its
   * workflows in the library; what the package no longer holds goes.
   */
  private async apply(record: PluginRecord, pkg: PluginPackage, dir: string): Promise<void> {
    const { id } = record
    const root = this.packageDir({ id, dir })
    const data = this.dataDir(id)
    await mkdir(data, { recursive: true })
    const settings = await this.deps.settings()
    const { contents } = pkg
    // What a version added while the plugin is off comes on with the plugin, as a new item would.
    const added: string[] = []
    const skills: MarketSkill[] = []
    for (const skill of contents.skills) {
      const itemId = pluginItemId(id, skill.name)
      const prefix = `${skill.path}/`
      const files = pkg.files
        .filter((file) => file.path.startsWith(prefix))
        .map((file) => ({ ...file, path: file.path.slice(prefix.length) }))
      await this.deps.keepSkill(itemId, skill.name, files)
      const kept = settings.skills.find((item) => item.id === itemId)
      if (!kept) added.push(itemId)
      skills.push({
        id: itemId,
        name: skill.name,
        description: skill.description,
        source: 'plugin',
        origin: contents.name,
        version: contents.version,
        agents: kept?.agents ?? 'all',
        on: kept?.on ?? record.enabled,
      })
    }
    const servers: MarketServer[] = []
    const others = settings.servers.filter((item) => !record.kept.servers.includes(item.id))
    for (const portable of pkg.servers) {
      const itemId = pluginItemId(id, portable.name)
      const kept = settings.servers.find((item) => item.id === itemId)
      if (!kept) added.push(itemId)
      servers.push({
        id: itemId,
        name: kept?.name ?? serverName(portable.name, [...others, ...servers]),
        title: portable.name,
        source: 'plugin',
        version: contents.version,
        spec: serverSpec(portable, root, data),
        agents: kept?.agents ?? 'all',
        on: kept?.on ?? record.enabled,
      })
    }
    const gone = (before: readonly string[], now: readonly { id: string }[]): string[] =>
      before.filter((itemId) => !now.some((item) => item.id === itemId))
    await this.deps.editSettings({
      skills: { remove: gone(record.kept.skills, skills), put: skills },
      servers: { remove: gone(record.kept.servers, servers), put: servers },
    })
    record.kept.skills = skills.map((item) => item.id)
    record.kept.servers = servers.map((item) => item.id)
    const workflows: string[] = []
    for (const item of contents.workflows) {
      const file = pkg.files.find((entry) => entry.path === item.path)
      if (!file) continue
      workflows.push(
        await this.deps.workflows.install(file.data.toString('utf8'), {
          kind: 'plugin',
          pluginId: id,
          name: item.name,
          plugin: contents.title,
        }),
      )
    }
    await this.deps.workflows.remove(
      id,
      contents.workflows.map((item) => item.name),
    )
    record.kept.workflows = workflows
    record.dir = dir
    record.contents = contents
    // A channel the new version no longer declares takes its picks with it.
    for (const channel of Object.keys(record.channelKinds)) {
      if (!(contents.channels ?? []).some((item) => item.id === channel)) {
        delete record.channelKinds[channel]
      }
    }
    record.wasOn = [
      ...record.wasOn.filter((itemId) =>
        [...record.kept.skills, ...record.kept.servers].includes(itemId),
      ),
      ...(record.enabled ? [] : added),
    ]
  }

  /** Why the package cannot go in as it is: a skill of it has the name of another Kettu keeps. */
  private async blocked(id: string, pkg: PluginPackage): Promise<string | null> {
    const { skills } = await this.deps.settings()
    for (const skill of pkg.contents.skills) {
      const other = skills.find(
        (item) => item.name === skill.name && item.id !== pluginItemId(id, skill.name),
      )
      if (other) return t('marketSkills.nameTaken', { name: skill.name, from: other.origin })
    }
    return null
  }

  /** A source's package, read and checked. */
  private async fetch(source: PluginSource): Promise<Fetched> {
    if (source.kind === 'local') {
      const info = await stat(source.path).catch(() => null)
      if (!info?.isDirectory()) {
        throw notFound(t('marketSkills.notFolder', { folder: source.path }))
      }
      const files = await readPackageFolder(source.path)
      return { pkg: readPackage(files, this.deps.appVersion), revision: null, origin: null }
    }
    if (source.kind === 'kettu') {
      const { listing, files } = await this.deps.kettu(source.id)
      const copied = files.map((file) => ({ ...file, mode: modeOf(file.data) }))
      return {
        pkg: readPackage(copied, this.deps.appVersion),
        revision: listing.version,
        origin: `@${listing.handle}/${listing.slug}`,
      }
    }
    const github = githubSource(source.url)
    if (!github) throw new HostError('invalid_params', t('marketSkills.needsGithub'))
    try {
      const gz = await downloadTarball(tarballUrl(github), TAR_LIMITS, this.deps.fetch)
      const tarball = await readTarball(gz, TAR_LIMITS)
      const prefix = github.path === '' ? '' : `${github.path}/`
      if (!tarball.files.some((file) => file.path === `${prefix}${MANIFEST_FILE}`)) {
        throw notFound(t('plugins.noPlugin', { url: source.url }))
      }
      // A link in the package's folder refuses it, so nothing is followed out of it.
      const files = folderFiles(tarball, github.path, PACKAGE_LIMITS)
      return {
        pkg: readPackage(files, this.deps.appVersion),
        revision: tarball.commit ?? createHash('sha256').update(gz).digest('hex').slice(0, 40),
        origin: null,
      }
    } catch (error) {
      if (error instanceof HostError) throw error
      throw new HostError('unavailable', (error as Error).message)
    }
  }

  /** Writes a package's files as `dir`, renamed into place only once every file is written. */
  private async writePackage(dir: string, files: readonly PackageFile[]): Promise<void> {
    const partial = path.join(path.dirname(dir), `${PARTIAL}${randomUUID()}`)
    const root = path.resolve(partial)
    try {
      await mkdir(root, { recursive: true })
      for (const file of files) {
        const target = path.resolve(root, ...file.path.split('/'))
        if (!target.startsWith(root + path.sep)) {
          throw refusal(t('plugins.unsafePath', { path: file.path.slice(0, 200) }))
        }
        await mkdir(path.dirname(target), { recursive: true })
        // A bundled program keeps its run bit; nothing else of the source's modes comes along.
        await writeFile(target, file.data, { mode: file.mode & 0o111 ? 0o755 : 0o644 })
      }
      await rename(partial, dir)
    } catch (error) {
      await rm(partial, { recursive: true, force: true })
      throw error
    }
  }

  private installed(record: PluginRecord): InstalledKettuPlugin {
    return {
      id: record.id,
      source: record.source,
      development: record.development,
      enabled: record.enabled,
      installedAt: record.installedAt,
      updatedAt: record.updatedAt,
      revision: record.revision,
      origin: record.origin,
      contents: record.contents,
      kept: {
        skills: [...record.kept.skills],
        servers: [...record.kept.servers],
        workflows: [...record.kept.workflows],
      },
      previous: record.previous
        ? { version: record.previous.version, revision: record.previous.revision }
        : null,
      held: record.held,
      updateError: record.updateError,
      values: Object.fromEntries(
        record.contents.settings.flatMap((setting) => {
          const value = effectiveSetting(setting, record.values[setting.key])
          return value === null ? [] : [[setting.key, value] as const]
        }),
      ),
      channelKinds: Object.fromEntries(
        Object.entries(record.channelKinds).map(([channel, kinds]) => [channel, [...kinds]]),
      ),
      scriptState:
        record.enabled && record.contents.script
          ? (this.deps.scriptState?.(record.id) ?? 'idle')
          : null,
      secretsSet: (this.deps.secretsSet?.(record.id) ?? []).filter((key) =>
        record.contents.settings.some((item) => item.key === key && item.type === 'secret'),
      ),
    }
  }

  private async record(id: string): Promise<PluginRecord> {
    const record = (await this.load()).plugins[id]
    if (!record) throw notFound(t('plugins.notFound'))
    return record
  }

  private queued<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  private save(): void {
    if (this.data) this.deps.file.save(this.data)
    this.deps.changed()
  }

  load(): Promise<PluginsFile> {
    if (this.data) return Promise.resolve(this.data)
    this.loading ??= this.deps.file.load().then(
      (file) => (this.data = file),
      (error: unknown) => {
        this.deps.log('warn', `Could not read the installed plugins: ${(error as Error).message}`)
        return (this.data = emptyPluginsFile())
      },
    )
    return this.loading
  }
}
