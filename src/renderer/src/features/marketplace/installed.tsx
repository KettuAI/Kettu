// Marketplace › Installed: Kettu's own server with a switch per agent; the plugins and plugin
// marketplaces each agent has; the MCP servers and skills Kettu keeps; then the skills and MCP
// servers each agent keeps itself, which Kettu only shows.

import { useEffect, useState, type CSSProperties } from 'react'
import { Delete02Icon, RefreshIcon } from '@hugeicons/core-free-icons'
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
import { EmptyState, Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { AgentTile } from '@renderer/components/agents/agent-mark'
import { BrandIcon } from '@renderer/components/brand'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Pill, SettingSwitch } from '@renderer/features/settings/controls'
import { PlaceAction } from '@renderer/features/settings/places'
import { errorMessage } from '@renderer/lib/host'
import { agentName, usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { useMcpStore } from '@renderer/stores/mcp'
import { useMarketplaceStore } from '@renderer/stores/marketplace'
import { useSettingsStore } from '@renderer/stores/settings'
import { openMarketplace } from '@renderer/stores/view'
import { removeMarketplace, setServerOn } from './actions'
import { ConfirmDialog } from './dialogs'
import {
  catalogEntry,
  catalogPlugin,
  catalogSkill,
  fromCatalog,
  fromKept,
  itemKey,
  matchesQuery,
  matchesText,
  pluginName,
  skillMatches,
  type Listing,
} from './model'
import { InstallRow } from './plugins'
import { ItemRow, QuietNote } from './rows'
import { KeptSkillControls } from './skills'

export function InstalledView({ query }: { query: string }) {
  const load = useMcpStore((s) => s.load)
  // Read each time the tab shows, as an agent's file may have been created since.
  useEffect(() => {
    void load()
  }, [load])
  return (
    <>
      <KettuSection />
      <PluginsSection query={query} />
      <KeptSection query={query} />
      <SkillsSection query={query} />
      <MarketplacesSection />
      <OwnSkillsSection query={query} />
      <OwnSection />
    </>
  )
}

/** Kettu's own server: built in, whether it runs, and whose sessions get it. */
function KettuSection() {
  const { t } = useTranslation('marketplace')
  const status = useMcpStore((s) => s.status)
  const error = useMcpStore((s) => s.error)
  const server = status?.servers.find((s) => s.builtIn) ?? null
  return (
    <section className="ui-as-int-section ui-as-rise" aria-label={t('installed.builtIn')}>
      <h2 className="ui-as-int-section__title">{t('installed.builtIn')}</h2>
      <p className="k-mkt-section-note">{t('kettu.note')}</p>
      <div className="ui-sg-card k-mkt-card">
        {server ? (
          <>
            <div className="ui-sg-row">
              <span className="k-mkt-thing">
                <BrandIcon size={30} className="k-mkt-thing__icon" />
                <span className="ui-sg-label">
                  <b className="k-mkt-thing__name">
                    {server.title}
                    <Pill>{t('kettu.builtIn')}</Pill>
                  </b>
                  <small>{t('kettu.tools', { count: server.tools.length })}</small>
                </span>
              </span>
              {server.running ? (
                <Pill tone="success">{t('kettu.running')}</Pill>
              ) : (
                <span className="ui-ss-badge k-mkt-danger-badge">{t('kettu.notRunning')}</span>
              )}
            </div>
            {!server.running && <NotRunning error={server.error} />}
            <AgentSwitches />
          </>
        ) : error ? (
          <ReadFailed error={error} />
        ) : (
          <LoadingRows rows={3} />
        )}
      </div>
    </section>
  )
}

/** Why Kettu's server does not listen, with Retry at the end. */
function NotRunning({ error }: { error: string | null }) {
  const { t } = useTranslation('marketplace')
  return (
    <div className="ui-sg-row k-mkt-problem" role="alert">
      <span className="ui-sg-label">
        <b>{t('kettu.notRunningTitle')}</b>
        <small>{t('kettu.notRunningBody')}</small>
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

/** In place of the rows when the status could not be read. */
function ReadFailed({ error }: { error: string }) {
  const { t } = useTranslation('marketplace')
  return (
    <div className="ui-sg-row k-mkt-problem" role="alert">
      <span className="ui-sg-label">
        <b>{t('kettu.readFailed')}</b>
        <small className="k-mkt-mono k-mkt-error" data-selectable="">
          {error}
        </small>
      </span>
      <RetryButton />
    </div>
  )
}

function RetryButton() {
  const { t } = useTranslation('common')
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

/** A switch per agent in catalog order: whether its sessions get Kettu's tools. */
function AgentSwitches() {
  const agents = useAgentsStore(useShallow((s) => usableAgents(s.order, s.byId)))
  const off = useSettingsStore((s) => s.settings.mcp.kettu.off)
  const [error, setError] = useState<string | null>(null)
  const set = (agentId: AgentId, on: boolean) => {
    const next = on ? off.filter((id) => id !== agentId) : [...off, agentId]
    setError(null)
    useSettingsStore
      .getState()
      .update({ mcp: { kettu: { off: next } } })
      .catch((e: unknown) => setError(errorMessage(e)))
  }
  return (
    <>
      {error && (
        <p role="alert" className="ui-sg-row k-mkt-error">
          {error}
        </p>
      )}
      {agents.map((agent) => (
        <AgentSwitchRow key={agent.id} agentId={agent.id} off={off.includes(agent.id)} set={set} />
      ))}
    </>
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
  const status = useAgentsStore((s) => s.byId[agentId])
  const name = status?.name ?? agentId
  const active = status?.kettuServer.active ?? null
  const runs = status?.kettuServer.runs ?? !off
  const takesNone = status?.capabilities.mcpHttp === false
  return (
    <div className="ui-sg-row">
      <span className="k-mkt-thing">
        <AgentTile agent={agentId} size={24} />
        <span className="ui-sg-label">
          <b className="k-mkt-thing__name">{name}</b>
          <small>
            {takesNone
              ? t('kettu.agent.takesNone', { name })
              : t(off ? 'kettu.agent.off' : 'kettu.agent.on')}
          </small>
          {!takesNone && active !== null && active !== runs && (
            <small>{t('kettu.agent.nextStart', { name })}</small>
          )}
        </span>
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

/** The servers Kettu keeps, from the registry or added by hand, each with its switch. */
function KeptSection({ query }: { query: string }) {
  const { t } = useTranslation('marketplace')
  const kept = useSettingsStore((s) => s.settings.marketplace.mcp)
  // The catalog gives a kept server its mark, badge and line once it has answered.
  useMarketplaceStore((s) => s.catalog)
  const needle = query.trim().toLocaleLowerCase()
  const rows = kept
    .map((server) => ({ server, listing: listingOf(server) }))
    .filter(({ listing, server }) => matchesQuery(listing, query) || server.name.includes(needle))
  return (
    <section className="ui-as-int-section ui-as-rise" style={{ '--i': 2 } as CSSProperties}>
      <h2 className="ui-as-int-section__title">{t('installed.kept')}</h2>
      {kept.length === 0 ? (
        <EmptyState title={t('installed.emptyTitle')} text={t('installed.emptyText')} />
      ) : rows.length === 0 ? (
        <EmptyState title={t('search.noneTitle')} text={t('installed.noMatch', { query })} />
      ) : (
        <div className="ui-as-int-grid">
          {rows.map(({ server, listing }) => (
            <KeptRow key={server.id} server={server} listing={listing} />
          ))}
        </div>
      )}
    </section>
  )
}

function listingOf(server: MarketServer): Listing {
  const entry = server.source === 'registry' ? catalogEntry(server.id) : null
  return entry ? { ...fromCatalog(entry), title: server.title } : fromKept(server)
}

function KeptRow({ server, listing }: { server: MarketServer; listing: Listing }) {
  const { t } = useTranslation('marketplace')
  const agents = server.agents === 'all' ? null : server.agents
  const line = [
    server.on ? null : t('installed.off'),
    agents ? t('installed.forAgents', { count: agents.length }) : null,
    listing.description ?? specRuns(server.spec),
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <ItemRow
      title={listing.title}
      brand={listing.brand}
      official={listing.official}
      line={line}
      onOpen={() =>
        openMarketplace({ item: itemKey({ kind: 'mcp', id: server.id }), tab: 'installed' })
      }
      end={
        <SettingSwitch
          label={t('listing.switch', { name: server.title })}
          checked={server.on}
          onChange={(on) => void setServerOn(server.id, on)}
        />
      }
    />
  )
}

/** Each agent's own configuration, read only, as the agent finds it. */
function OwnSection() {
  const { t } = useTranslation('marketplace')
  const status = useMcpStore((s) => s.status)
  const error = useMcpStore((s) => s.error)
  // A failed read shows once, in the built-in section above.
  if (error && !status) return null
  const places = status?.places ?? null
  if (places && places.length === 0) return null
  return (
    <section className="ui-as-int-section ui-as-rise" style={{ '--i': 6 } as CSSProperties}>
      <h2 className="ui-as-int-section__title">{t('own.title')}</h2>
      <p className="k-mkt-section-note">{t('own.note')}</p>
      <div className="ui-sg-card k-mkt-card">
        {places ? (
          places.map((place) => <PlaceRow key={place.agentId} place={place} />)
        ) : (
          <LoadingRows rows={3} />
        )}
      </div>
    </section>
  )
}

/**
 * One agent's own configuration: its tile and name, then where its servers come from, saying so
 * when the file is not there yet, with Show in Finder or Copy path at the end while it is.
 */
function PlaceRow({ place }: { place: McpStatus['places'][number] }) {
  const { t } = useTranslation(['marketplace', 'settings'])
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
  // Where a command lists the servers, the line names the file only when it is missing or moved.
  const line = place.listCommand
    ? t(
        !place.exists ? 'own.withCommandMissing' : note ? 'own.withCommandFrom' : 'own.withCommand',
        values,
      )
    : t(place.exists ? 'own.from' : 'own.fromMissing', values)
  return (
    <div className="ui-sg-row">
      <span className="k-mkt-thing">
        <AgentTile agent={place.agentId} size={24} />
        <span className="ui-sg-label">
          <b className="k-mkt-thing__name">{name}</b>
          <small className="k-mkt-clamp" title={line} data-selectable="">
            {line}
          </small>
        </span>
      </span>
      {place.exists && <PlaceAction path={place.path} icon />}
    </div>
  )
}

/** Skeleton rows while the first status is on its way. */
function LoadingRows({ rows }: { rows: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="ui-sg-row" aria-hidden>
          <span className="k-mkt-thing">
            <Skeleton className="k-mkt-skeleton__mark" />
            <span className="ui-sg-label k-mkt-skeleton__lines">
              <Skeleton className="k-mkt-skeleton__name" />
              <Skeleton className="k-mkt-skeleton__line" />
            </span>
          </span>
        </div>
      ))}
    </>
  )
}

/** Groups by agent, in the order the agents come first. */
function byAgent<T extends { agentId: AgentId }>(items: T[]): [AgentId, T[]][] {
  const groups = new Map<AgentId, T[]>()
  for (const item of items) groups.set(item.agentId, [...(groups.get(item.agentId) ?? []), item])
  return [...groups]
}

/** Read the first time the tab needs them; the host lists plugins slowly. */
function usePluginsRead(): void {
  useEffect(() => {
    const store = useMarketplaceStore.getState()
    if (!store.plugins && !store.pluginsLoading) void store.loadPlugins()
  }, [])
}

function useSkillsRead(): void {
  useEffect(() => {
    const store = useMarketplaceStore.getState()
    if (!store.skills && !store.skillsLoading) void store.loadSkills()
  }, [])
}

/** The plugins each Claude Code and Codex agent has, with a switch and Uninstall each. */
function PluginsSection({ query }: { query: string }) {
  const { t } = useTranslation('marketplace')
  usePluginsRead()
  const plugins = useMarketplaceStore((s) => s.plugins)
  const failure = useMarketplaceStore((s) => s.pluginsError)
  const titleOf = (plugin: InstalledPlugin) =>
    catalogPlugin(plugin.harness, plugin.id)?.title ?? pluginName(plugin.id)
  const installed = (plugins?.installed ?? []).filter((p) =>
    matchesText([titleOf(p), p.id, agentName(p.agentId)], query),
  )
  return (
    <section className="ui-as-int-section ui-as-rise" style={{ '--i': 1 } as CSSProperties}>
      <h2 className="ui-as-int-section__title">{t('installed.plugins')}</h2>
      {failure && !plugins && <PluginsFailed error={failure} />}
      {plugins?.errors.map((error) => (
        <QuietNote key={error.agentId}>
          {t('notes.agentPlugins', { agent: agentName(error.agentId), error: error.message })}
        </QuietNote>
      ))}
      {!plugins && !failure ? (
        <div className="ui-sg-card k-mkt-card">
          <LoadingRows rows={2} />
        </div>
      ) : plugins && installed.length === 0 ? (
        <p className="k-mkt-section-note">
          {query ? t('installed.noMatch', { query }) : t('installed.noPlugins')}
        </p>
      ) : (
        byAgent(installed).map(([agentId, list]) => (
          <div key={agentId} className="k-mkt-group">
            <span className="k-mkt-group__head">
              <AgentTile agent={agentId} size={18} />
              {agentName(agentId)}
            </span>
            <div className="ui-sg-card k-mkt-card">
              {list.map((plugin) => (
                <InstallRow
                  key={`${plugin.id}|${plugin.scope}|${plugin.projectPath ?? ''}`}
                  plugin={plugin}
                  title={titleOf(plugin)}
                  showTitle
                  onOpen={() =>
                    openMarketplace({
                      item: itemKey({ kind: 'plugin', harness: plugin.harness, id: plugin.id }),
                      tab: 'installed',
                    })
                  }
                />
              ))}
            </div>
          </div>
        ))
      )}
    </section>
  )
}

function PluginsFailed({ error }: { error: string }) {
  const { t } = useTranslation(['marketplace', 'common'])
  return (
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
      {t('notes.plugins', { error })}
    </QuietNote>
  )
}

/** The plugin marketplaces each agent reads; the harness maker's own stays. */
function MarketplacesSection() {
  const { t } = useTranslation('marketplace')
  const markets = useMarketplaceStore((s) => s.plugins?.marketplaces ?? null)
  if (!markets || markets.length === 0) return null
  return (
    <section className="ui-as-int-section ui-as-rise" style={{ '--i': 4 } as CSSProperties}>
      <h2 className="ui-as-int-section__title">{t('installed.marketplaces')}</h2>
      <p className="k-mkt-section-note">{t('installed.marketplacesNote')}</p>
      {byAgent(markets).map(([agentId, list]) => (
        <div key={agentId} className="k-mkt-group">
          <span className="k-mkt-group__head">
            <AgentTile agent={agentId} size={18} />
            {agentName(agentId)}
          </span>
          <div className="ui-sg-card k-mkt-card">
            {list.map((market) => (
              <MarketplaceRow key={market.name} market={market} />
            ))}
          </div>
        </div>
      ))}
    </section>
  )
}

function MarketplaceRow({ market }: { market: PluginMarketplace }) {
  const { t } = useTranslation('marketplace')
  const [confirming, setConfirming] = useState(false)
  return (
    <div className="ui-sg-row">
      <span className="ui-sg-label">
        <b className="k-mkt-thing__name">
          {market.name}
          {market.official && <Pill>{t('listing.official')}</Pill>}
        </b>
        <small className="k-mkt-mono" data-selectable="">
          {market.source}
        </small>
      </span>
      {market.official ? (
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
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('dialogs.removeMarketplace.title', { name: market.name })}
        body={t('dialogs.removeMarketplace.body', { agent: agentName(market.agentId) })}
        confirm={t('dialogs.removeMarketplace.confirm')}
        action={() => removeMarketplace(market)}
      />
    </div>
  )
}

/** The skills Kettu keeps, with a switch and a menu each. */
function SkillsSection({ query }: { query: string }) {
  const { t } = useTranslation('marketplace')
  useSkillsRead()
  const kept = useSettingsStore((s) => s.settings.marketplace.skills)
  const rows = kept.filter((skill) => skillMatches(skill, query))
  return (
    <section className="ui-as-int-section ui-as-rise" style={{ '--i': 3 } as CSSProperties}>
      <h2 className="ui-as-int-section__title">{t('installed.skills')}</h2>
      {rows.length === 0 ? (
        <p className="k-mkt-section-note">
          {query ? t('installed.noMatch', { query }) : t('installed.noSkills')}
        </p>
      ) : (
        <div className="ui-as-int-grid">
          {rows.map((skill) => (
            <KeptSkillRow key={skill.id} skill={skill} />
          ))}
        </div>
      )}
    </section>
  )
}

function KeptSkillRow({ skill }: { skill: MarketSkill }) {
  const { t } = useTranslation('marketplace')
  // The catalog gives a kept skill its badge once it has answered.
  useMarketplaceStore((s) => s.skills)
  const entry = catalogSkill(skill.id)
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
      brand={null}
      official={entry?.official ?? false}
      line={line}
      onOpen={() =>
        openMarketplace({ item: itemKey({ kind: 'skill', id: skill.id }), tab: 'installed' })
      }
      end={
        <span className="k-mkt-row-end">
          <KeptSkillControls skill={skill} compact />
        </span>
      }
    />
  )
}

/** The skills each agent has of its own, read only. */
function OwnSkillsSection({ query }: { query: string }) {
  const { t } = useTranslation(['marketplace', 'common'])
  const skills = useMarketplaceStore((s) => s.skills)
  const failure = useMarketplaceStore((s) => s.skillsError)
  const own = (skills?.own ?? []).filter((skill) =>
    matchesText([skill.name, skill.description, agentName(skill.agentId)], query),
  )
  if (skills && own.length === 0) return null
  return (
    <section className="ui-as-int-section ui-as-rise" style={{ '--i': 5 } as CSSProperties}>
      <h2 className="ui-as-int-section__title">{t('installed.ownSkills')}</h2>
      <p className="k-mkt-section-note">{t('installed.ownSkillsNote')}</p>
      {failure && !skills ? (
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
          {t('notes.skills', { error: failure })}
        </QuietNote>
      ) : !skills ? (
        <div className="ui-sg-card k-mkt-card">
          <LoadingRows rows={2} />
        </div>
      ) : (
        byAgent(own).map(([agentId, list]) => (
          <div key={agentId} className="k-mkt-group">
            <span className="k-mkt-group__head">
              <AgentTile agent={agentId} size={18} />
              {agentName(agentId)}
            </span>
            <div className="ui-sg-card k-mkt-card">
              {list.map((skill) => (
                <OwnSkillRow key={skill.path} skill={skill} />
              ))}
            </div>
          </div>
        ))
      )}
    </section>
  )
}

function OwnSkillRow({ skill }: { skill: AgentOwnSkill }) {
  const { t } = useTranslation('marketplace')
  const note = [
    skill.enabled ? null : t('installed.off'),
    skill.plugin ? t('installed.fromPlugin', { plugin: pluginName(skill.plugin) }) : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="ui-sg-row">
      <span className="ui-sg-label">
        <b className="k-mkt-thing__name">
          {displayTitle(skill.name)}
          {note && <span className="k-mkt-quiet">{note}</span>}
        </b>
        {skill.description && <small className="k-mkt-clamp">{skill.description}</small>}
        <small className="k-mkt-mono k-mkt-path" title={skill.path} data-selectable="">
          {skill.path}
        </small>
      </span>
      <PlaceAction path={skill.path} icon />
    </div>
  )
}
