// Marketplace › Installed, in the directory's rows: Kettu's own server, the MCP servers and skills
// Kettu keeps, its own skills among them, then what the agents keep themselves, which Kettu only
// shows: their skills, their plugins and their MCP configuration.

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { RefreshIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { McpStatus } from '@shared/agent-host'
import {
  displayTitle,
  specRuns,
  type AgentOwnPlugin,
  type AgentOwnSkill,
  type BuiltinSkill,
  type MarketServer,
  type MarketSkill,
} from '@shared/marketplace'
import type { AgentId } from '@shared/thread'
import type { InstalledKettuPlugin } from '@shared/plugins'
import { EmptyState, Icon, Popover } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { BrandIcon } from '@renderer/components/brand'
import { Pill, SettingSwitch } from '@renderer/features/settings/controls'
import { PlaceAction } from '@renderer/features/settings/places'
import { currentLocale } from '@renderer/lib/i18n'
import { isWeb } from '@renderer/lib/platform'
import { useHostScope, type HostScope } from '@renderer/stores/host-scope'
import { openMarketplace } from '@renderer/stores/view'
import { setServerOn, setSkillOn } from './actions'
import { ConnectionControls } from './connect'
import {
  useAgentName,
  useCommunityLine,
  useConnection,
  useConnectionText,
  useKettuSwitches,
} from './hooks'
import {
  catalogEntry,
  fromCatalog,
  fromKept,
  homeShort,
  keptItemKey,
  matchesQuery,
  matchesText,
  oauthFlow,
  parentPath,
  pluginName,
  scopeLine,
  skillMatches,
  type Listing,
} from './model'
import { KETTU_ITEM } from './published-keys'
import { ItemRow, MoreButton, QuietNote, SkeletonRows } from './rows'
import { workflowMatches } from './workflow-model'
import { useWorkflows } from './workflow-actions'
import { InstalledWorkflows } from './workflows'
import { pluginSubject, serverSubject, skillSubject } from './tile-art'
import { PlainTile } from './tiles'
import { isPluginItem, pluginDescription, pluginTitle } from './plugin-model'
import { useInstalledPlugins, usePluginItemOff, usePluginPublisher } from './plugin-hooks'
import { FromPlugin, PluginInstalledRow } from './plugin-ui'

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
  useOwnPluginsRead()
  useSkillsRead()
  const servers = useKeptServers(query)
  const skills = useKeptSkills(query)
  const builtIn = useBuiltinSkills(query)
  const own = useOwn(query)
  const plugins = useKeptPlugins(query)
  const workflows = useWorkflows().entries.filter((entry) =>
    workflowMatches(entry, query, currentLocale()),
  )
  const searching = query.trim() !== ''
  const nothing =
    searching &&
    !matchesText(['Kettu'], query) &&
    plugins.list.length + servers.length + builtIn.length + skills.length + workflows.length ===
      0 &&
    own.folders.length + own.plugins.length + own.places.length === 0
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
      <PluginsSection plugins={plugins} searching={searching} />
      <Section title={t('installed.kept')} count={servers.length} index={2} hide={searching}>
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
      <Section
        title={t('installed.skills')}
        count={builtIn.length + skills.length}
        index={3}
        hide={searching}
      >
        {builtIn.length + skills.length === 0 ? (
          <p className="k-mkt-section-note">{t('installed.noSkills')}</p>
        ) : (
          <div className="ui-as-int-grid">
            {builtIn.map((skill) => (
              <BuiltinSkillRow key={skill.name} skill={skill} />
            ))}
            {skills.map((skill) => (
              <KeptSkillRow key={skill.id} skill={skill} />
            ))}
          </div>
        )}
      </Section>
      <InstalledWorkflows query={query} index={4} />
      <OwnSection own={own} searching={searching} />
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
              icon={<BrandIcon size={40} className="k-mkt-kettu-tile" />}
              tag={<Pill>{t('kettu.builtIn')}</Pill>}
              line={[
                server.running ? t('kettu.running') : t('kettu.notRunning'),
                t('kettu.tools', { count: server.tools.length }),
              ].join(' · ')}
              lineTitle={t('kettu.note')}
              onOpen={() => openMarketplace({ item: KETTU_ITEM, tab: 'installed' })}
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
      size="md"
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
  const { agents, off, error, set } = useKettuSwitches()
  const [open, setOpen] = useState(false)
  const on = agents.filter((agent) => !off.includes(agent.id)).length
  return (
    <span className="ui-as-anchor">
      <Button
        size="md"
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

export function AgentSwitchRow({
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

/** A kept item's state under its name: where it stands, who gets it, whether it is off. */
function Facts({ facts }: { facts: (string | null | undefined)[] }) {
  const shown = facts.filter((fact): fact is string => !!fact)
  if (shown.length === 0) return null
  return (
    <>
      {shown.map((fact) => (
        <span key={fact}>{fact}</span>
      ))}
    </>
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
  const pluginOff = usePluginItemOff(server.id)
  const connection = useConnection(server.id)
  const connectionText = useConnectionText()
  const agents = server.agents === 'all' ? null : server.agents
  const standing = useCommunityLine(server.id, server.version)
  const state = [
    standing,
    oauth ? connectionText(connection) : null,
    server.on ? null : t('installed.off'),
    agents ? t('installed.forAgents', { count: agents.length }) : null,
  ]
  return (
    <ItemRow
      title={listing.title}
      subject={serverSubject({ ...listing, spec: server.spec })}
      meta={<Facts facts={[listing.publisher, ...state]} />}
      line={listing.description ?? specRuns(server.spec)}
      oneLine={!listing.description}
      onOpen={() => openMarketplace({ item: keptItemKey('mcp', server.id), tab: 'installed' })}
      end={
        oauth ? (
          <ConnectionControls server={server} compact />
        ) : (
          <>
            {isPluginItem(server.id) && <FromPlugin itemId={server.id} />}
            <SettingSwitch
              label={t('listing.switch', { name: server.title })}
              checked={server.on}
              disabled={pluginOff}
              onChange={(on) => void setServerOn(scope, server.id, on)}
            />
          </>
        )
      }
    />
  )
}

/** The Kettu plugins installed here, matching the search; null while the host has not answered. */
function useKeptPlugins(query: string): {
  list: InstalledKettuPlugin[]
  loading: boolean
  failure: string | null
} {
  const { useMarketplaceStore } = useHostScope()
  const plugins = useInstalledPlugins()
  const failure = useMarketplaceStore((s) => s.pluginsError)
  const locale = currentLocale()
  const publisher = usePluginPublisher()
  const list = (plugins ?? []).filter((plugin) =>
    matchesText(
      [
        pluginTitle(plugin.contents, locale),
        plugin.contents.name,
        pluginDescription(plugin.contents, locale),
        publisher(plugin),
      ],
      query,
    ),
  )
  return { list, loading: plugins === null && !failure, failure: plugins === null ? failure : null }
}

/** Kettu's own plugins, after Kettu's server: each with its switch, and an update that asks for more. */
function PluginsSection({
  plugins,
  searching,
}: {
  plugins: ReturnType<typeof useKeptPlugins>
  searching: boolean
}) {
  const { t } = useTranslation(['marketplace', 'common'])
  const { useMarketplaceStore } = useHostScope()
  const { list, loading, failure } = plugins
  return (
    <Section
      title={t('installed.kettuPlugins')}
      count={loading ? null : list.length}
      index={1}
      hide={searching}
    >
      {failure ? (
        <QuietNote
          action={
            <Button
              size="md"
              variant="ghost"
              icon={<Icon icon={RefreshIcon} size={14} />}
              onClick={() => void useMarketplaceStore.getState().loadPlugins()}
            >
              {t('common:actions.retry')}
            </Button>
          }
        >
          {t('notes.plugins', { error: failure })}
        </QuietNote>
      ) : loading ? (
        <SkeletonRows rows={1} />
      ) : list.length === 0 ? (
        <p className="k-mkt-section-note">
          {t(isWeb ? 'installed.noPluginsWeb' : 'installed.noPlugins')}
        </p>
      ) : (
        <div className="ui-as-int-grid k-plug-grid">
          {list.map((plugin) => (
            <PluginInstalledRow key={plugin.id} plugin={plugin} />
          ))}
        </div>
      )}
    </Section>
  )
}

/** Kettu's own skills, matching the search; none from a host older than them. */
function useBuiltinSkills(query: string): BuiltinSkill[] {
  const { useMarketplaceStore } = useHostScope()
  const builtIn = useMarketplaceStore((s) => s.skills?.builtIn ?? null)
  return (builtIn ?? []).filter((skill) => matchesText([skill.name, skill.description], query))
}

/** A skill Kettu ships, which comes with its own server: built in, with nothing to turn off. */
function BuiltinSkillRow({ skill }: { skill: BuiltinSkill }) {
  const { t } = useTranslation('marketplace')
  return (
    <ItemRow
      title={displayTitle(skill.name)}
      icon={<BrandIcon size={40} className="k-mkt-kettu-tile" />}
      tag={<Pill>{t('kettu.builtIn')}</Pill>}
      line={skill.description}
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
  const standing = useCommunityLine(skill.id, skill.version)
  const pluginOff = usePluginItemOff(skill.id)
  const state = [
    standing,
    skill.on ? null : t('installed.off'),
    skill.agents === 'all' ? null : t('installed.forAgents', { count: skill.agents.length }),
  ]
  return (
    <ItemRow
      title={displayTitle(skill.name)}
      subject={skillSubject(skill.name)}
      meta={<Facts facts={state} />}
      line={skill.description || null}
      onOpen={() => openMarketplace({ item: keptItemKey('skill', skill.id), tab: 'installed' })}
      end={
        <>
          {isPluginItem(skill.id) && <FromPlugin itemId={skill.id} />}
          <SettingSwitch
            label={t('listing.switch', { name: skill.name })}
            checked={skill.on}
            disabled={pluginOff}
            onChange={(on) => void setSkillOn(scope, skill.id, on)}
          />
        </>
      }
    />
  )
}

/** Read each time the tab shows, as a plugin may have been installed in the agent since. */
function useOwnPluginsRead(): void {
  const { useMarketplaceStore } = useHostScope()
  useEffect(() => {
    const store = useMarketplaceStore.getState()
    if (!store.ownPluginsLoading) void store.loadOwnPlugins(store.ownPlugins !== null)
  }, [useMarketplaceStore])
}

function useSkillsRead(): void {
  const { useMarketplaceStore } = useHostScope()
  useEffect(() => {
    const store = useMarketplaceStore.getState()
    if (!store.skills && !store.skillsLoading) void store.loadSkills(false, true)
  }, [useMarketplaceStore])
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
  plugins: AgentOwnPlugin[]
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
  const plugins = (useMarketplaceStore((s) => s.ownPlugins)?.plugins ?? []).filter((plugin) =>
    matchesText([displayTitle(pluginName(plugin.id)), plugin.id, agentName(plugin.agentId)], query),
  )
  const places = (status?.places ?? []).filter((place) =>
    matchesText([agentName(place.agentId), place.path], query),
  )
  return {
    folders,
    plugins,
    places,
    loading: !skills || !status,
    failure: skills ? null : failure,
  }
}

/** What each agent keeps itself, read only: its skills by folder, its plugins, then its MCP configuration. */
function OwnSection({ own, searching }: { own: Own; searching: boolean }) {
  const { t } = useTranslation(['marketplace', 'common'])
  const { useMarketplaceStore } = useHostScope()
  const agentName = useAgentName()
  const pluginErrors = useMarketplaceStore((s) => s.ownPlugins?.errors ?? null)
  const count = own.folders.reduce((n, group) => n + group.skills.length, 0) + own.plugins.length
  if (searching && count + own.places.length === 0) return null
  if (!own.loading && count + own.places.length === 0 && !own.failure && !pluginErrors?.length) {
    return null
  }
  return (
    <Section
      title={t('installed.own')}
      count={own.loading ? null : count}
      index={5}
      note={t('installed.ownNote')}
    >
      {own.failure && (
        <QuietNote
          action={
            <Button
              size="md"
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
      {!searching &&
        pluginErrors?.map((error) => (
          <QuietNote key={error.agentId}>
            {t('notes.agentPlugins', { agent: agentName(error.agentId), error: error.message })}
          </QuietNote>
        ))}
      {own.plugins.length > 0 && (
        <div className="k-mkt-group">
          <h3 className="k-mkt-group__head">{t('installed.plugins')}</h3>
          <div className="ui-as-int-grid">
            {own.plugins.map((plugin) => (
              <OwnPluginRow
                key={`${plugin.agentId}|${plugin.id}|${plugin.scope}|${plugin.projectPath ?? ''}`}
                plugin={plugin}
              />
            ))}
          </div>
        </div>
      )}
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

/** A plugin in an agent's own configuration: whose it is, where, its version and whether it is off. */
function OwnPluginRow({ plugin }: { plugin: AgentOwnPlugin }) {
  const { t } = useTranslation('marketplace')
  const agentName = useAgentName()
  const facts = [
    agentName(plugin.agentId),
    plugin.scope === 'user' ? null : scopeLine(plugin, t),
    plugin.version,
    plugin.enabled ? null : t('installed.off'),
  ]
  return (
    <ItemRow
      title={displayTitle(pluginName(plugin.id))}
      subject={pluginSubject(plugin)}
      quiet
      meta={<Facts facts={facts} />}
      line={plugin.id}
      oneLine
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
      oneLine
      end={place.exists ? <PlaceAction path={place.path} icon /> : undefined}
    />
  )
}
