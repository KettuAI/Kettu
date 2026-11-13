// Marketplace › Installed, in the directory's rows: Kettu's own server, the MCP servers and skills
// Kettu keeps, the plugins each agent has, then what the agents keep themselves, which Kettu only
// shows, and the plugin marketplaces they read.

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { Delete02Icon, RefreshIcon, Store01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { McpStatus } from '@shared/agent-host'
import {
  displayTitle,
  specRuns,
  type AgentOwnSkill,
  type InstalledPlugin,
  type MarketServer,
  type MarketSkill,
  type PluginMarketplace,
} from '@shared/marketplace'
import type { AgentId } from '@shared/thread'
import { EmptyState, Icon, Popover } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { BrandIcon } from '@renderer/components/brand'
import { Pill, SettingSwitch } from '@renderer/features/settings/controls'
import { PlaceAction } from '@renderer/features/settings/places'
import { errorMessage } from '@renderer/lib/host'
import { usableAgents } from '@renderer/stores/agents'
import { useHostScope, type HostScope } from '@renderer/stores/host-scope'
import { busyKey } from '@renderer/stores/marketplace'
import { openMarketplace } from '@renderer/stores/view'
import { removeMarketplace, setPluginEnabled, setServerOn, setSkillOn } from './actions'
import { ConnectionControls } from './connect'
import { ConfirmDialog } from './dialogs'
import { useAgentName, useBusy, useConnection, useConnectionText } from './hooks'
import {
  catalogEntry,
  catalogPlugin,
  catalogSkill,
  fromCatalog,
  fromKept,
  homeShort,
  itemKey,
  matchesQuery,
  matchesText,
  oauthFlow,
  parentPath,
  pluginName,
  scopeLine,
  skillMatches,
  type Listing,
} from './model'
import { ItemRow, MoreButton, QuietNote, SkeletonRows } from './rows'
import { pluginSubject, serverSubject, skillSubject } from './tile-art'
import { PlainTile } from './tiles'

/** Rows a group of the agents' own skills shows before "and N more". */
const GROUP_ROWS = 6

export function InstalledView({ query }: { query: string }) {
  const { t } = useTranslation('marketplace')
  const { useMcpStore } = useHostScope()
  const load = useMcpStore((s) => s.load)
  // Read each time the tab shows, as an agent's file may have been created since.
  useEffect(() => {
    void load()
  }, [load])
  usePluginsRead()
  useSkillsRead()
  const servers = useKeptServers(query)
  const skills = useKeptSkills(query)
  const plugins = useInstalledPlugins(query)
  const own = useOwn(query)
  const markets = useMarketplaces(query)
  const searching = query.trim() !== ''
  const nothing =
    searching &&
    !matchesText(['Kettu'], query) &&
    servers.length + skills.length + (plugins?.length ?? 0) === 0 &&
    own.folders.length + own.places.length + markets.length === 0
  if (nothing) {
    return (
      <section className="ui-as-int-section">
        <EmptyState title={t('search.noneTitle')} text={t('installed.noMatch', { query })} />
      </section>
    )
  }
  return (
    <>
      {(!searching || matchesText(['Kettu'], query)) && <KettuSection />}
      <Section title={t('installed.kept')} count={servers.length} index={1} hide={searching}>
        {servers.length === 0 ? (
          <p className="k-mkt-section-note">{t('installed.noServers')}</p>
        ) : (
          <div className="ui-as-int-grid">
            {servers.map(({ server, listing }) => (
              <KeptRow key={server.id} server={server} listing={listing} />
            ))}
          </div>
        )}
      </Section>
      <Section title={t('installed.skills')} count={skills.length} index={2} hide={searching}>
        {skills.length === 0 ? (
          <p className="k-mkt-section-note">{t('installed.noSkills')}</p>
        ) : (
          <div className="ui-as-int-grid">
            {skills.map((skill) => (
              <KeptSkillRow key={skill.id} skill={skill} />
            ))}
          </div>
        )}
      </Section>
      <PluginsSection plugins={plugins} searching={searching} />
      <OwnSection own={own} searching={searching} />
      <MarketplacesSection markets={markets} />
    </>
  )
}

/** A section's title with its count; while searching, a section with nothing found is left out. */
function Section({
  title,
  count,
  index,
  hide,
  note,
  children,
}: {
  title: string
  count: number | null
  index: number
  /** Leave the section out when it has nothing. */
  hide?: boolean
  note?: string
  children: ReactNode
}) {
  if (hide && count === 0) return null
  return (
    <section className="ui-as-int-section ui-as-rise" style={{ '--i': index } as CSSProperties}>
      <h2 className="ui-as-int-section__title">
        {title}
        {count !== null && count > 0 && <span className="k-mkt-count">{count}</span>}
      </h2>
      {note && <p className="k-mkt-section-note">{note}</p>}
      {children}
    </section>
  )
}

/** Kettu's own server: one row, whether it runs, and whose sessions get it from a popover. */
function KettuSection() {
  const { t } = useTranslation('marketplace')
  const { useMcpStore } = useHostScope()
  const status = useMcpStore((s) => s.status)
  const error = useMcpStore((s) => s.error)
  const server = status?.servers.find((s) => s.builtIn) ?? null
  return (
    <section className="ui-as-int-section ui-as-rise" aria-label={t('installed.builtIn')}>
      <h2 className="ui-as-int-section__title">{t('installed.builtIn')}</h2>
      {server ? (
        <>
          <div className="ui-as-int-grid">
            <ItemRow
              title={server.title}
              icon={<BrandIcon size={30} className="k-mkt-kettu-tile" />}
              tag={<Pill>{t('kettu.builtIn')}</Pill>}
              line={[
                server.running ? t('kettu.running') : t('kettu.notRunning'),
                t('kettu.tools', { count: server.tools.length }),
              ].join(' · ')}
              lineTitle={t('kettu.note')}
              end={<AgentsButton />}
            />
          </div>
          {!server.running && (
            <ProblemNote
              title={t('kettu.notRunningTitle')}
              body={t('kettu.notRunningBody')}
              error={server.error}
            />
          )}
        </>
      ) : error ? (
        <ProblemNote title={t('kettu.readFailed')} error={error} />
      ) : (
        <SkeletonRows rows={1} />
      )}
    </section>
  )
}

/** Why Kettu's server does not listen, or why its status could not be read, with Retry. */
function ProblemNote({
  title,
  body,
  error,
}: {
  title: string
  body?: string
  error: string | null
}) {
  return (
    <div className="k-mkt-problem-note" role="alert">
      <span>
        <b>{title}</b>
        {body && <small>{body}</small>}
        {error && (
          <small className="k-mkt-mono k-mkt-error" data-selectable="">
            {error}
          </small>
        )}
      </span>
      <RetryButton />
    </div>
  )
}

function RetryButton() {
  const { t } = useTranslation('common')
  const { useMcpStore } = useHostScope()
  const retry = useMcpStore((s) => s.retry)
  const [busy, setBusy] = useState(false)
  return (
    <Button
      size="sm"
      variant="secondary"
      loading={busy}
      icon={<Icon icon={RefreshIcon} size={14} />}
      onClick={() => {
        setBusy(true)
        void retry().finally(() => setBusy(false))
      }}
    >
      {t('actions.retry')}
    </Button>
  )
}

/** "5 agents", or "3 of 5 agents", opening a switch per agent: whether it gets Kettu's tools. */
function AgentsButton() {
  const { t } = useTranslation('marketplace')
  const { useAgentsStore, useSettingsStore } = useHostScope()
  const agents = useAgentsStore(useShallow((s) => usableAgents(s.order, s.byId)))
  const off = useSettingsStore((s) => s.settings.mcp.kettu.off)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const on = agents.filter((agent) => !off.includes(agent.id)).length
  const set = (agentId: AgentId, enabled: boolean) => {
    const next = enabled ? off.filter((id) => id !== agentId) : [...off, agentId]
    setError(null)
    useSettingsStore
      .getState()
      .update({ mcp: { kettu: { off: next } } })
      .catch((e: unknown) => setError(errorMessage(e)))
  }
  return (
    <span className="ui-as-anchor">
      <Button
        size="sm"
        variant="secondary"
        aria-expanded={open}
        aria-label={t('kettu.agentsLabel')}
        onClick={() => setOpen((o) => !o)}
      >
        {on === agents.length
          ? t('kettu.agents', { count: agents.length })
          : t('kettu.agentsSome', { on, count: agents.length })}
      </Button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        align="end"
        className="ui-as-menu k-mkt-install-pop"
      >
        <div className="k-mkt-install">
          <b>{t('kettu.agentsTitle')}</b>
          <span>{t('kettu.note')}</span>
          {error && (
            <p role="alert" className="k-mkt-error">
              {error}
            </p>
          )}
          <div className="k-mkt-switches">
            {agents.map((agent) => (
              <AgentSwitchRow
                key={agent.id}
                agentId={agent.id}
                off={off.includes(agent.id)}
                set={set}
              />
            ))}
          </div>
        </div>
      </Popover>
    </span>
  )
}

function AgentSwitchRow({
  agentId,
  off,
  set,
}: {
  agentId: AgentId
  off: boolean
  set: (agentId: AgentId, on: boolean) => void
}) {
  const { t } = useTranslation('marketplace')
  const { useAgentsStore } = useHostScope()
  const status = useAgentsStore((s) => s.byId[agentId])
  const name = status?.name ?? agentId
  const active = status?.kettuServer.active ?? null
  const runs = status?.kettuServer.runs ?? !off
  const takesNone = status?.capabilities.mcpHttp === false
  const note = takesNone
    ? t('kettu.agent.takesNone', { name })
    : active !== null && active !== runs
      ? t('kettu.agent.nextStart', { name })
      : null
  return (
    <div className="k-mkt-switch-row" data-disabled={takesNone || undefined}>
      <AgentMark agent={agentId} size={16} dot={null} />
      <span className="k-mkt-switch-row__text">
        <span className="k-mkt-agents__name">{name}</span>
        {note && <small>{note}</small>}
      </span>
      {!takesNone && (
        <SettingSwitch
          label={t('kettu.agent.switch', { name })}
          checked={!off}
          onChange={(on) => set(agentId, on)}
        />
      )}
    </div>
  )
}

/** The servers Kettu keeps, from the registry or added by hand, matching the search. */
function useKeptServers(query: string): { server: MarketServer; listing: Listing }[] {
  const scope = useHostScope()
  const { useSettingsStore, useMarketplaceStore } = scope
  const kept = useSettingsStore((s) => s.settings.marketplace.mcp)
  // The catalog gives a kept server its mark, badge and line once it has answered.
  useMarketplaceStore((s) => s.catalog)
  const needle = query.trim().toLocaleLowerCase()
  return kept
    .map((server) => ({ server, listing: listingOf(scope, server) }))
    .filter(({ listing, server }) => matchesQuery(listing, query) || server.name.includes(needle))
}

function listingOf(scope: HostScope, server: MarketServer): Listing {
  const entry = server.source === 'registry' ? catalogEntry(scope, server.id) : null
  return entry ? { ...fromCatalog(entry), title: server.title } : fromKept(server)
}

function KeptRow({ server, listing }: { server: MarketServer; listing: Listing }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const oauth = oauthFlow(server.spec) !== null
  const connection = useConnection(server.id)
  const connectionText = useConnectionText()
  const agents = server.agents === 'all' ? null : server.agents
  const line = [
    oauth ? connectionText(connection) : null,
    server.on ? null : t('installed.off'),
    agents ? t('installed.forAgents', { count: agents.length }) : null,
    listing.description ?? specRuns(server.spec),
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <ItemRow
      title={listing.title}
      subject={serverSubject(listing)}
      official={listing.official}
      line={line}
      onOpen={() =>
        openMarketplace({ item: itemKey({ kind: 'mcp', id: server.id }), tab: 'installed' })
      }
      end={
        oauth ? (
          <ConnectionControls server={server} compact />
        ) : (
          <SettingSwitch
            label={t('listing.switch', { name: server.title })}
            checked={server.on}
            onChange={(on) => void setServerOn(scope, server.id, on)}
          />
        )
      }
    />
  )
}

/** The skills Kettu keeps, matching the search. */
function useKeptSkills(query: string): MarketSkill[] {
  const { useSettingsStore } = useHostScope()
  const kept = useSettingsStore((s) => s.settings.marketplace.skills)
  return kept.filter((skill) => skillMatches(skill, query))
}

function KeptSkillRow({ skill }: { skill: MarketSkill }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  // The catalog gives a kept skill its badge once it has answered.
  scope.useMarketplaceStore((s) => s.skills)
  const entry = catalogSkill(scope, skill.id)
  const line = [
    skill.on ? null : t('installed.off'),
    skill.agents === 'all' ? null : t('installed.forAgents', { count: skill.agents.length }),
    skill.description,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <ItemRow
      title={displayTitle(skill.name)}
      subject={skillSubject(skill.name)}
      official={entry?.official ?? false}
      line={line}
      onOpen={() =>
        openMarketplace({ item: itemKey({ kind: 'skill', id: skill.id }), tab: 'installed' })
      }
      end={
        <SettingSwitch
          label={t('listing.switch', { name: skill.name })}
          checked={skill.on}
          onChange={(on) => void setSkillOn(scope, skill.id, on)}
        />
      }
    />
  )
}

/** Read the first time the tab needs them; the host lists plugins slowly. */
function usePluginsRead(): void {
  const { useMarketplaceStore } = useHostScope()
  useEffect(() => {
    const store = useMarketplaceStore.getState()
    if (!store.plugins && !store.pluginsLoading) void store.loadPlugins(false, true)
  }, [useMarketplaceStore])
}

function useSkillsRead(): void {
  const { useMarketplaceStore } = useHostScope()
  useEffect(() => {
    const store = useMarketplaceStore.getState()
    if (!store.skills && !store.skillsLoading) void store.loadSkills(false, true)
  }, [useMarketplaceStore])
}

const pluginTitle = (scope: HostScope, plugin: InstalledPlugin): string =>
  catalogPlugin(scope, plugin.harness, plugin.id)?.title ?? displayTitle(pluginName(plugin.id))

/** The plugins every agent has, matching the search; null until the host has listed them. */
function useInstalledPlugins(query: string): InstalledPlugin[] | null {
  const scope = useHostScope()
  const agentName = useAgentName()
  const plugins = scope.useMarketplaceStore((s) => s.plugins)
  if (!plugins) return null
  return plugins.installed.filter((p) =>
    matchesText([pluginTitle(scope, p), p.id, agentName(p.agentId)], query),
  )
}

function PluginsSection({
  plugins,
  searching,
}: {
  plugins: InstalledPlugin[] | null
  searching: boolean
}) {
  const { t } = useTranslation(['marketplace', 'common'])
  const { useMarketplaceStore } = useHostScope()
  const agentName = useAgentName()
  const failure = useMarketplaceStore((s) => s.pluginsError)
  const errors = useMarketplaceStore((s) => s.plugins?.errors ?? null)
  if (searching && !plugins?.length) return null
  return (
    <Section title={t('installed.plugins')} count={plugins?.length ?? null} index={3}>
      {failure && !plugins && (
        <QuietNote
          action={
            <Button
              size="sm"
              variant="ghost"
              icon={<Icon icon={RefreshIcon} size={14} />}
              onClick={() => void useMarketplaceStore.getState().loadPlugins(true)}
            >
              {t('common:actions.retry')}
            </Button>
          }
        >
          {t('notes.plugins', { error: failure })}
        </QuietNote>
      )}
      {errors?.map((error) => (
        <QuietNote key={error.agentId}>
          {t('notes.agentPlugins', { agent: agentName(error.agentId), error: error.message })}
        </QuietNote>
      ))}
      {!plugins ? (
        !failure && <SkeletonRows rows={2} />
      ) : plugins.length === 0 ? (
        <p className="k-mkt-section-note">{t('installed.noPlugins')}</p>
      ) : (
        <div className="ui-as-int-grid">
          {plugins.map((plugin) => (
            <PluginRow
              key={`${plugin.agentId}|${plugin.id}|${plugin.scope}|${plugin.projectPath ?? ''}`}
              plugin={plugin}
            />
          ))}
        </div>
      )}
    </Section>
  )
}

function PluginRow({ plugin }: { plugin: InstalledPlugin }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const agentName = useAgentName()
  const entry = catalogPlugin(scope, plugin.harness, plugin.id)
  const title = pluginTitle(scope, plugin)
  const busy = useBusy(busyKey('plugin', `${plugin.agentId}|${plugin.id}|${plugin.scope}`))
  const line = [
    agentName(plugin.agentId),
    plugin.scope === 'user' ? null : scopeLine(plugin, t),
    plugin.version,
    plugin.enabled ? null : t('installed.off'),
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <ItemRow
      title={title}
      subject={pluginSubject({ ...plugin, category: entry?.category })}
      official={entry?.official ?? false}
      line={line}
      onOpen={() =>
        openMarketplace({
          item: itemKey({ kind: 'plugin', harness: plugin.harness, id: plugin.id }),
          tab: 'installed',
        })
      }
      end={
        <SettingSwitch
          label={t('plugin.switch', { name: title, agent: agentName(plugin.agentId) })}
          checked={plugin.enabled}
          disabled={busy}
          onChange={(on) => void setPluginEnabled(scope, plugin, title, on)}
        />
      }
    />
  )
}

/** One skill folder an agent reads, with the skills in it, each once. */
interface SkillFolder {
  folder: string
  agents: AgentId[]
  skills: OwnSkill[]
}

interface OwnSkill {
  path: string
  name: string
  description: string | null
  /** The agents that turned it off; it is on for the others. */
  offIn: AgentId[]
}

/**
 * The agents' own skills by the folder they are in, so a folder several agents read shows once.
 * A plugin's skills come with the plugin and are left out.
 */
function skillFolders(own: AgentOwnSkill[]): SkillFolder[] {
  const folders = new Map<string, SkillFolder>()
  const skills = new Map<string, OwnSkill>()
  for (const skill of own) {
    if (skill.plugin) continue
    const folder = parentPath(parentPath(skill.path))
    let group = folders.get(folder)
    if (!group) folders.set(folder, (group = { folder, agents: [], skills: [] }))
    if (!group.agents.includes(skill.agentId)) group.agents.push(skill.agentId)
    let item = skills.get(skill.path)
    if (!item) {
      item = { path: skill.path, name: skill.name, description: skill.description, offIn: [] }
      skills.set(skill.path, item)
      group.skills.push(item)
    }
    if (!skill.enabled) item.offIn.push(skill.agentId)
  }
  return [...folders.values()]
}

interface Own {
  folders: SkillFolder[]
  places: McpStatus['places']
  loading: boolean
  failure: string | null
}

function useOwn(query: string): Own {
  const { useMarketplaceStore, useMcpStore } = useHostScope()
  const agentName = useAgentName()
  const skills = useMarketplaceStore((s) => s.skills)
  const failure = useMarketplaceStore((s) => s.skillsError)
  const status = useMcpStore((s) => s.status)
  const folders = skillFolders(skills?.own ?? [])
    .map((group) => ({
      ...group,
      skills: group.skills.filter((skill) =>
        matchesText(
          [skill.name, skill.description, ...group.agents.map((id) => agentName(id))],
          query,
        ),
      ),
    }))
    .filter((group) => group.skills.length > 0)
  const places = (status?.places ?? []).filter((place) =>
    matchesText([agentName(place.agentId), place.path], query),
  )
  return { folders, places, loading: !skills || !status, failure: skills ? null : failure }
}

/** What each agent keeps itself, read only: its skills by folder, then its MCP configuration. */
function OwnSection({ own, searching }: { own: Own; searching: boolean }) {
  const { t } = useTranslation(['marketplace', 'common'])
  const { useMarketplaceStore } = useHostScope()
  const count = own.folders.reduce((n, group) => n + group.skills.length, 0)
  if (searching && count + own.places.length === 0) return null
  if (!own.loading && count + own.places.length === 0 && !own.failure) return null
  return (
    <Section
      title={t('installed.own')}
      count={own.loading ? null : count}
      index={4}
      note={t('installed.ownNote')}
    >
      {own.failure && (
        <QuietNote
          action={
            <Button
              size="sm"
              variant="ghost"
              icon={<Icon icon={RefreshIcon} size={14} />}
              onClick={() => void useMarketplaceStore.getState().loadSkills(true)}
            >
              {t('common:actions.retry')}
            </Button>
          }
        >
          {t('notes.skills', { error: own.failure })}
        </QuietNote>
      )}
      {own.loading && !own.failure && <SkeletonRows rows={4} />}
      {own.folders.map((group) => (
        <FolderGroup key={group.folder} group={group} searching={searching} />
      ))}
      {own.places.length > 0 && (
        <div className="k-mkt-group">
          <h3 className="k-mkt-group__head">{t('installed.mcpConfig')}</h3>
          <div className="ui-as-int-grid">
            {own.places.map((place) => (
              <PlaceRow key={place.agentId} place={place} />
            ))}
          </div>
        </div>
      )}
    </Section>
  )
}

/** A folder's path and the agents that read it, over its skills: six, then "and N more". */
function FolderGroup({ group, searching }: { group: SkillFolder; searching: boolean }) {
  const agentName = useAgentName()
  const [open, setOpen] = useState(false)
  const shown = open || searching ? group.skills : group.skills.slice(0, GROUP_ROWS)
  const rest = group.skills.slice(shown.length)
  return (
    <div className="k-mkt-group">
      <h3 className="k-mkt-group__head" title={group.folder}>
        <span className="k-mkt-mono k-mkt-path">{homeShort(group.folder)}</span>
        <span className="k-mkt-group__agents">
          {group.agents.map((agentId) => (
            <span key={agentId} className="k-mkt-group__agent">
              <AgentMark agent={agentId} size={13} dot={null} />
              {agentName(agentId)}
            </span>
          ))}
        </span>
      </h3>
      <div className="ui-as-int-grid">
        {shown.map((skill, i) => (
          <OwnSkillRow key={skill.path} skill={skill} fresh={open && i >= GROUP_ROWS} />
        ))}
      </div>
      {rest.length > 0 && (
        <MoreButton
          items={rest.map((skill) => ({
            key: skill.path,
            title: displayTitle(skill.name),
            subject: skillSubject(skill.name),
          }))}
          quiet
          onClick={() => setOpen(true)}
        />
      )}
    </div>
  )
}

function OwnSkillRow({ skill, fresh }: { skill: OwnSkill; fresh: boolean }) {
  const { t } = useTranslation('marketplace')
  const agentName = useAgentName()
  const off = skill.offIn.length
    ? t('installed.offIn', { agents: skill.offIn.map((id) => agentName(id)).join(', ') })
    : null
  const line = [off, skill.description].filter(Boolean).join(' · ') || null
  return (
    <ItemRow
      title={displayTitle(skill.name)}
      subject={skillSubject(skill.name)}
      quiet
      line={line}
      lineTitle={[skill.description, skill.path].filter(Boolean).join('\n')}
      fresh={fresh}
      end={<PlaceAction path={skill.path} icon />}
    />
  )
}

/** Where one agent keeps its own MCP servers: the file, or that it is not created yet. */
function PlaceRow({ place }: { place: McpStatus['places'][number] }) {
  const { t } = useTranslation(['marketplace', 'settings'])
  const { useAgentsStore } = useHostScope()
  const agent = useAgentsStore((s) => s.byId[place.agentId])
  const name = agent?.name ?? place.agentId
  const note = place.chosen
    ? t('settings:agents.chosenInKettu')
    : place.env && t('settings:agents.setByLine', { env: place.env })
  const values = {
    path: note ? t('own.pathNote', { path: place.path, note }) : place.path,
    command: place.listCommand,
    file: place.project,
  }
  // The full account goes to the tooltip; the row names only the file.
  const about = place.listCommand
    ? t(
        !place.exists ? 'own.withCommandMissing' : note ? 'own.withCommandFrom' : 'own.withCommand',
        values,
      )
    : t(place.exists ? 'own.from' : 'own.fromMissing', values)
  const path = homeShort(place.path)
  return (
    <ItemRow
      title={name}
      icon={
        <PlainTile>
          <AgentMark agent={place.agentId} size={18} dot={null} />
        </PlainTile>
      }
      line={place.exists ? path : t('installed.notCreated', { path })}
      lineTitle={about}
      end={place.exists ? <PlaceAction path={place.path} icon /> : undefined}
    />
  )
}

/** The plugin marketplaces the agents read, matching the search. */
function useMarketplaces(query: string): PluginMarketplace[] {
  const { useMarketplaceStore } = useHostScope()
  const agentName = useAgentName()
  const markets = useMarketplaceStore((s) => s.plugins?.marketplaces ?? null)
  return (markets ?? []).filter((market) =>
    matchesText([market.name, market.source, agentName(market.agentId)], query),
  )
}

function MarketplacesSection({ markets }: { markets: PluginMarketplace[] }) {
  const { t } = useTranslation('marketplace')
  if (markets.length === 0) return null
  return (
    <Section
      title={t('installed.marketplaces')}
      count={markets.length}
      index={5}
      note={t('installed.marketplacesNote')}
    >
      <div className="ui-as-int-grid">
        {markets.map((market) => (
          <MarketplaceRow key={`${market.agentId}|${market.name}`} market={market} />
        ))}
      </div>
    </Section>
  )
}

function MarketplaceRow({ market }: { market: PluginMarketplace }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const agentName = useAgentName()
  const [confirming, setConfirming] = useState(false)
  return (
    <>
      <ItemRow
        title={market.name}
        icon={
          <PlainTile>
            <Icon icon={Store01Icon} />
          </PlainTile>
        }
        official={market.official}
        line={[agentName(market.agentId), homeShort(market.source)].join(' · ')}
        lineTitle={market.source}
        end={
          market.official ? (
            <small className="k-mkt-quiet">{t('installed.marketplaceKept')}</small>
          ) : (
            <button
              type="button"
              className="k-mkt-icon-btn"
              aria-label={t('installed.removeMarketplace', { name: market.name })}
              title={t('installed.removeMarketplace', { name: market.name })}
              onClick={() => setConfirming(true)}
            >
              <Icon icon={Delete02Icon} size={15} />
            </button>
          )
        }
      />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('dialogs.removeMarketplace.title', { name: market.name })}
        body={t('dialogs.removeMarketplace.body', { agent: agentName(market.agentId) })}
        confirm={t('dialogs.removeMarketplace.confirm')}
        action={() => removeMarketplace(scope, market)}
      />
    </>
  )
}
