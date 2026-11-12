// Plugins: the harnesses' own, which Claude Code or Codex installs into one agent's configuration
// so its terminal sees them too. Their rows, the install form and their listing.

import { useEffect, useState, type FormEvent } from 'react'
import {
  AiBrain01Icon,
  Alert02Icon,
  CodeIcon,
  CommandLineIcon,
  Delete02Icon,
  PlugSocketIcon,
  SparklesIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type {
  CatalogPlugin,
  InstalledPlugin,
  PluginHarness,
  PluginScope,
} from '@shared/marketplace'
import type { AgentId } from '@shared/thread'
import { Icon, Popover } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Segmented, SettingSelect, SettingSwitch } from '@renderer/features/settings/controls'
import { basename, count, tokens } from '@renderer/lib/format'
import { AGENT_NAMES } from '@renderer/stores/agents'
import { useHostScope } from '@renderer/stores/host-scope'
import { busyKey, detailsKey } from '@renderer/stores/marketplace'
import { openMarketplace, type MarketplaceTab } from '@renderer/stores/view'
import { installPlugin, setPluginEnabled, uninstallPlugin } from './actions'
import { ConfirmDialog } from './dialogs'
import {
  useAgentName,
  useBusy,
  useHarnessAgents,
  useHostProjects,
  useInstallsLabel,
  usePluginInstalls,
} from './hooks'
import { ListingFrame, ListingSkeleton, Missing, ExternalLink } from './parts'
import { byInstalls, catalogPlugin, itemKey, pluginName, scopeLine } from './model'
import { AddControl, ItemRow, KindTag, OfficialBadge } from './rows'
import { pluginSubject } from './tile-art'
import { ItemTile } from './tiles'

export function PluginRow({
  plugin,
  tab,
  showKind,
  fresh,
}: {
  plugin: CatalogPlugin
  tab: MarketplaceTab
  showKind: boolean
  fresh?: boolean
}) {
  const installsLabel = useInstallsLabel()
  const open = () =>
    openMarketplace({
      item: itemKey({ kind: 'plugin', harness: plugin.harness, id: plugin.id }),
      tab,
    })
  return (
    <ItemRow
      title={plugin.title}
      subject={pluginSubject(plugin)}
      official={plugin.official}
      tag={showKind ? <KindTag kind="plugin" harness={plugin.harness} /> : undefined}
      line={[installsLabel(plugin.installs), plugin.description].filter(Boolean).join(' · ')}
      fresh={fresh}
      onOpen={open}
      end={<PluginAddButton plugin={plugin} onOpen={open} />}
    />
  )
}

function PluginAddButton({ plugin, onOpen }: { plugin: CatalogPlugin; onOpen: () => void }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const installs = usePluginInstalls(plugin.harness, plugin.id)
  const busy = useBusy(busyKey('plugin', `${plugin.harness}/${plugin.id}`))
  return (
    <AddControl
      name={plugin.title}
      label={t('row.install')}
      state={busy ? 'busy' : installs.length > 0 ? 'on' : 'off'}
      onOpen={onOpen}
      form={(close) => (
        <PluginInstallForm
          plugin={plugin}
          onDone={(agentId, pluginScope, projectPath) => {
            close()
            void installPlugin(scope, plugin, agentId, pluginScope, projectPath)
          }}
        />
      )}
    />
  )
}

/** What a plugin adds, as the chosen agent's harness reports it; null while it is read. */
function useDetails(agentId: AgentId | null, pluginId: string) {
  const { useMarketplaceStore } = useHostScope()
  const state = useMarketplaceStore((s) =>
    agentId ? (s.details[detailsKey(agentId, pluginId)] ?? null) : null,
  )
  useEffect(() => {
    if (agentId) void useMarketplaceStore.getState().loadDetails(agentId, pluginId)
  }, [agentId, pluginId, useMarketplaceStore])
  return state
}

/**
 * Install: one of the harness's agents, and for Claude Code whether every project gets it or one
 * project. Hooks are called out, since they run commands on their own.
 */
function PluginInstallForm({
  plugin,
  onDone,
}: {
  plugin: CatalogPlugin
  onDone: (agentId: AgentId, scope: PluginScope, projectPath: string | null) => void
}) {
  const { t } = useTranslation('marketplace')
  const agents = useHarnessAgents(plugin.harness)
  const installs = usePluginInstalls(plugin.harness, plugin.id)
  const projects = useHostProjects()
  const free = agents.filter((a) => !installs.some((p) => p.agentId === a.id))
  const [agentId, setAgentId] = useState<AgentId | null>(free[0]?.id ?? agents[0]?.id ?? null)
  const [scope, setScope] = useState<'user' | 'project'>('user')
  const [project, setProject] = useState<string>(projects[0]?.path ?? '')
  const details = useDetails(agentId, plugin.id)
  const scoped = plugin.harness === 'claude-code'
  const harness = AGENT_NAMES[plugin.harness]
  // Hooks are called out before Install, so it waits for the check to answer or fail.
  const checked = !!details && (details.details !== null || details.error !== null)
  const ready = agentId !== null && checked && (scope === 'user' || project !== '')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!ready) return
    onDone(agentId, scope, scope === 'project' ? project : null)
  }
  return (
    <form className="k-mkt-install" onSubmit={submit}>
      <b>{t('install.title', { name: plugin.title })}</b>
      <span>{t('plugin.installNote', { harness })}</span>
      <div className="k-mkt-install__field">
        <small>{t('plugin.agent')}</small>
        {agents.length === 0 ? (
          <p className="k-mkt-install__empty">{t('plugin.noAgents', { harness })}</p>
        ) : (
          <div className="k-mkt-agents" role="radiogroup" aria-label={t('plugin.agent')}>
            {agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                role="radio"
                aria-checked={agent.id === agentId}
                className="k-mkt-agents__agent"
                onClick={() => setAgentId(agent.id)}
              >
                <AgentMark agent={agent.id} size={13} />
                <span className="k-mkt-agents__name">{agent.name}</span>
                {installs.some((p) => p.agentId === agent.id) && (
                  <span className="k-mkt-agents__note">{t('listing.installed')}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
      {scoped && (
        <div className="k-mkt-install__field">
          <small>{t('plugin.scope')}</small>
          <Segmented
            label={t('plugin.scope')}
            value={scope}
            options={[
              { value: 'user', label: t('plugin.scopeUser') },
              { value: 'project', label: t('plugin.scopeProject'), disabled: !projects.length },
            ]}
            onChange={setScope}
          />
          {scope === 'project' && (
            <SettingSelect
              label={t('plugin.project')}
              value={project}
              options={projects.map((p) => ({ value: p.path, label: p.name || basename(p.path) }))}
              onChange={setProject}
            />
          )}
        </div>
      )}
      <DetailsNote state={details} />
      <Button size="sm" type="submit" disabled={!ready}>
        {t('install.submit')}
      </Button>
    </form>
  )
}

/**
 * While the details are read, a line's room; then, if it has hooks, the warning, or that it could
 * not be checked for them.
 */
function DetailsNote({ state }: { state: ReturnType<typeof useDetails> }) {
  const { t } = useTranslation('marketplace')
  if (!state) return null
  if (!state.details && !state.error) return <Skeleton className="k-mkt-skeleton__line" />
  if (state.error) {
    return (
      <em className="k-mkt-warn">
        <Icon icon={Alert02Icon} size={13} />
        {t('plugin.hooksUnchecked', { error: state.error })}
      </em>
    )
  }
  if (!state.details?.hooks.length) return null
  return (
    <em className="k-mkt-warn">
      <Icon icon={Alert02Icon} size={13} />
      {t('plugin.hooksWarning')}
    </em>
  )
}

/** A plugin's listing: what it adds, where it comes from, and each agent that has it. */
export function PluginListing({
  harness,
  id,
  tab,
  back,
}: {
  harness: PluginHarness
  id: string
  tab: MarketplaceTab
  back: () => void
}) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  // Read again whenever the host lists the plugins again.
  const loaded = scope.useMarketplaceStore((s) => s.plugins)
  const loading = scope.useMarketplaceStore((s) => s.pluginsLoading)
  const plugin = loaded ? catalogPlugin(scope, harness, id) : null
  const installs = usePluginInstalls(harness, id)
  const agents = useHarnessAgents(harness)
  const detailAgent = installs[0]?.agentId ?? agents[0]?.id ?? null
  const details = useDetails(detailAgent, id)
  const installsLabel = useInstallsLabel()
  const title = plugin?.title ?? pluginName(id)
  const harnessName = AGENT_NAMES[harness]

  if (!plugin && installs.length === 0) {
    return (
      <ListingFrame back={back}>
        {loading || !loaded ? <ListingSkeleton /> : <Missing back={back} />}
      </ListingFrame>
    )
  }
  const related = (loaded?.catalog ?? [])
    .filter((p) => p.id !== id && p.harness === harness)
    .filter((p) => (plugin?.category ? p.category === plugin.category : true))
    .sort(byInstalls)
    .slice(0, 4)
  const info = details?.details
  return (
    <ListingFrame back={back} rise>
      <header className="k-mkt-head">
        <ItemTile subject={pluginSubject({ harness, id, category: plugin?.category })} size="big" />
        <span className="k-mkt-head__title">
          <span className="k-mkt-head__name">
            <h1>{title}</h1>
            <KindTag kind="plugin" harness={harness} />
          </span>
          <span className="k-mkt-head__pub">
            {plugin?.publisher ?? plugin?.marketplace}
            {plugin?.official && (
              <>
                <OfficialBadge />
                <span className="k-mkt-head__trust" aria-hidden>
                  {t('listing.official')}
                </span>
              </>
            )}
          </span>
          {(info?.description ?? plugin?.description) && (
            <span className="k-mkt-head__line">{info?.description ?? plugin?.description}</span>
          )}
        </span>
        <span className="k-mkt-head__act">
          {installs.length > 0 && (
            <span className="k-mkt-head__on">
              <Icon icon={Tick02Icon} size={14} />
              {t('listing.installed')}
            </span>
          )}
          {plugin && <PluginInstallButton plugin={plugin} />}
        </span>
      </header>

      <div className="k-mkt-facts">
        <span>
          <small>{t('listing.facts.worksWith')}</small>
          <b className="k-mkt-facts__agents">
            <AgentMark agent={harness} size={15} dot={null} />
            <span className="k-mkt-facts__text">{harnessName}</span>
          </b>
        </span>
        {plugin?.installs != null && (
          <span>
            <small>{t('plugin.facts.installs')}</small>
            <b>{count(plugin.installs)}</b>
          </span>
        )}
        {plugin?.category && (
          <span>
            <small>{t('plugin.facts.category')}</small>
            <b>{plugin.category}</b>
          </span>
        )}
        {(plugin?.version ?? installs[0]?.version) && (
          <span>
            <small>{t('listing.facts.version')}</small>
            <b className="k-mkt-mono">{plugin?.version ?? installs[0]?.version}</b>
          </span>
        )}
      </div>

      <div className="k-mkt-body">
        <div className="k-mkt-body__main">
          {installs.length > 0 && <Installs installs={installs} title={title} />}
          <Adds state={details} installed={installs.length > 0} />
        </div>
        <aside className="k-mkt-side">
          <dl>
            {plugin?.publisher && (
              <>
                <dt>{t('listing.side.publisher')}</dt>
                <dd>
                  {plugin.publisher}
                  {plugin.official && <OfficialBadge />}
                </dd>
              </>
            )}
            <dt>{t('plugin.side.marketplace')}</dt>
            <dd>{plugin?.marketplace ?? id.slice(pluginName(id).length + 1)}</dd>
            <dt>{t('plugin.side.id')}</dt>
            <dd className="k-mkt-mono" data-selectable="">
              {id}
            </dd>
            {plugin?.homepage && (
              <>
                <dt>{t('plugin.side.homepage')}</dt>
                <dd>
                  <ExternalLink href={plugin.homepage} />
                </dd>
              </>
            )}
            {plugin?.installs != null && (
              <>
                <dt>{t('plugin.facts.installs')}</dt>
                <dd>{installsLabel(plugin.installs)}</dd>
              </>
            )}
          </dl>
        </aside>
      </div>

      {related.length > 0 && (
        <section className="ui-as-int-section">
          <h2 className="ui-as-int-section__title">{t('listing.related')}</h2>
          <div className="ui-as-int-grid">
            {related.map((p) => (
              <PluginRow key={p.id} plugin={p} tab={tab} showKind={false} />
            ))}
          </div>
        </section>
      )}
    </ListingFrame>
  )
}

/** The listing's Install, for one more agent once installed for some. */
function PluginInstallButton({ plugin }: { plugin: CatalogPlugin }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const [open, setOpen] = useState(false)
  const busy = useBusy(busyKey('plugin', `${plugin.harness}/${plugin.id}`))
  const installs = usePluginInstalls(plugin.harness, plugin.id)
  return (
    <span className="ui-as-anchor">
      <Button
        variant={installs.length > 0 ? 'secondary' : 'primary'}
        loading={busy}
        aria-expanded={open}
        onClick={() => !busy && setOpen((o) => !o)}
      >
        {busy
          ? t('install.installing')
          : installs.length > 0
            ? t('plugin.installAnother')
            : t('install.submit')}
      </Button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        align="end"
        className="ui-as-menu k-mkt-install-pop"
      >
        <PluginInstallForm
          plugin={plugin}
          onDone={(agentId, pluginScope, projectPath) => {
            setOpen(false)
            void installPlugin(scope, plugin, agentId, pluginScope, projectPath)
          }}
        />
      </Popover>
    </span>
  )
}

/** Each agent that has the plugin: where, its switch and Uninstall. */
function Installs({ installs, title }: { installs: InstalledPlugin[]; title: string }) {
  const { t } = useTranslation('marketplace')
  return (
    <section>
      <h3>{t('plugin.installedIn')}</h3>
      <div className="ui-sg-card k-mkt-card">
        {installs.map((plugin) => (
          <InstallRow
            key={`${plugin.agentId}|${plugin.scope}|${plugin.projectPath ?? ''}`}
            plugin={plugin}
            title={title}
          />
        ))}
      </div>
    </section>
  )
}

/** One agent's install: the agent, where, its version, its switch and Uninstall. */
export function InstallRow({ plugin, title }: { plugin: InstalledPlugin; title: string }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const agentName = useAgentName()
  const [confirming, setConfirming] = useState(false)
  const busy = useBusy(busyKey('plugin', `${plugin.agentId}|${plugin.id}|${plugin.scope}`))
  const line = [scopeLine(plugin, t), plugin.version, plugin.enabled ? null : t('installed.off')]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="ui-sg-row">
      <span className="k-mkt-thing">
        <AgentMark agent={plugin.agentId} size={20} />
        <span className="ui-sg-label">
          <b className="k-mkt-thing__name">{agentName(plugin.agentId)}</b>
          <small>{line}</small>
        </span>
      </span>
      <span className="k-mkt-row-end">
        <SettingSwitch
          label={t('plugin.switch', { name: title, agent: agentName(plugin.agentId) })}
          checked={plugin.enabled}
          disabled={busy}
          onChange={(on) => void setPluginEnabled(scope, plugin, title, on)}
        />
        <button
          type="button"
          className="k-mkt-icon-btn"
          aria-label={t('plugin.uninstallFrom', { name: title, agent: agentName(plugin.agentId) })}
          title={t('plugin.uninstall')}
          onClick={() => setConfirming(true)}
        >
          <Icon icon={Delete02Icon} size={15} />
        </button>
      </span>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('dialogs.uninstallPlugin.title', { name: title })}
        body={t('dialogs.uninstallPlugin.body', { agent: agentName(plugin.agentId) })}
        confirm={t('dialogs.uninstall.confirm')}
        action={() => uninstallPlugin(scope, plugin, title)}
      />
    </div>
  )
}

/** What the plugin adds, from the harness's report; hooks with their warning. */
function Adds({ state, installed }: { state: ReturnType<typeof useDetails>; installed: boolean }) {
  const { t } = useTranslation('marketplace')
  if (!state) return null
  if (!state.details && !state.error) {
    return (
      <section aria-busy>
        <h3>{installed ? t('plugin.adds') : t('plugin.willAdd')}</h3>
        <div className="k-mkt-list">
          <div className="k-mkt-item">
            <Skeleton className="k-mkt-skeleton__line" />
          </div>
        </div>
      </section>
    )
  }
  const info = state.details
  if (!info) {
    return <p className="k-mkt-section-note">{t('plugin.detailsFailed', { error: state.error })}</p>
  }
  const groups: { label: string; icon: IconSvgElement; items: string[]; warn?: boolean }[] = [
    { label: t('plugin.parts.skills'), icon: SparklesIcon, items: info.skills },
    { label: t('plugin.parts.commands'), icon: CommandLineIcon, items: info.commands },
    { label: t('plugin.parts.agents'), icon: AiBrain01Icon, items: info.agents },
    { label: t('plugin.parts.hooks'), icon: CodeIcon, items: info.hooks, warn: true },
    { label: t('plugin.parts.mcpServers'), icon: PlugSocketIcon, items: info.mcpServers },
    { label: t('plugin.parts.lspServers'), icon: CodeIcon, items: info.lspServers },
  ].filter((group) => group.items.length > 0)
  if (groups.length === 0 && info.alwaysOnTokens === null) return null
  return (
    <section>
      <h3>{installed ? t('plugin.adds') : t('plugin.willAdd')}</h3>
      <div className="k-mkt-list">
        {groups.map((group) => (
          <div key={group.label} className="k-mkt-item">
            <Icon icon={group.icon} size={15} />
            <span>
              <b>{group.label}</b>
              <small className="k-mkt-mono">{group.items.join(', ')}</small>
              {group.warn && (
                <em className="k-mkt-warn">
                  <Icon icon={Alert02Icon} size={12} />
                  {t('plugin.hooksWarning')}
                </em>
              )}
            </span>
          </div>
        ))}
        {info.alwaysOnTokens !== null && (
          <div className="k-mkt-item">
            <Icon icon={SparklesIcon} size={15} />
            <span>
              <b>{t('plugin.parts.context')}</b>
              <small>{t('plugin.tokensEachTurn', { value: tokens(info.alwaysOnTokens) })}</small>
            </span>
          </div>
        )}
      </div>
    </section>
  )
}
