// Kettu's own MCP server's page, opened from its Installed row: whether it runs, its tools in
// groups with the Marketplace ones first while signed in, and each agent's switch beside them.

import { useEffect, useState, type CSSProperties } from 'react'
import {
  Brain01Icon,
  BrowserIcon,
  ComputerIcon,
  ComputerTerminal01Icon,
  DashboardSquare02Icon,
  Flag01Icon,
  Flowchart01Icon,
  Message01Icon,
  PlugSocketIcon,
  Settings02Icon,
  SmartPhone01Icon,
  Store01Icon,
} from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { McpToolGroup, McpToolSummary } from '@shared/agent-host'
import { Icon } from '@renderer/components/affect/app-shell'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { BrandIcon } from '@renderer/components/brand'
import { Pill } from '@renderer/features/settings/controls'
import { isMac } from '@renderer/lib/platform'
import { useHostScope } from '@renderer/stores/host-scope'
import type { MarketplaceTab } from '@renderer/stores/view'
import { useHostName } from '@renderer/stores/window-host'
import { useKettuSwitches } from './hooks'
import { AgentSwitchRow } from './installed'
import { ListingFrame, ListingSkeleton } from './parts'
import { usePublishedStore, useShowsPublished } from './published-hooks'
import { KindTag, OfficialBadge } from './rows'

/** The groups in the order the page lists them; Marketplace first, as it is new. */
const GROUPS: { id: McpToolGroup; icon: IconSvgElement }[] = [
  { id: 'marketplace', icon: Store01Icon },
  { id: 'sessions', icon: Message01Icon },
  { id: 'artifacts', icon: DashboardSquare02Icon },
  { id: 'browser', icon: BrowserIcon },
  { id: 'computer', icon: ComputerIcon },
  { id: 'devices', icon: SmartPhone01Icon },
  { id: 'terminal', icon: ComputerTerminal01Icon },
  { id: 'memory', icon: Brain01Icon },
  { id: 'reports', icon: Flag01Icon },
  { id: 'workflows', icon: Flowchart01Icon },
  { id: 'settings', icon: Settings02Icon },
  { id: 'plugins', icon: PlugSocketIcon },
]

/** Tool names a group's row shows before "+ N more". */
const NAMED = 3

export function BuiltinServerPage({ back }: { tab: MarketplaceTab; back: () => void }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const { useMcpStore } = scope
  const status = useMcpStore((s) => s.status)
  const load = useMcpStore((s) => s.load)
  const server = status?.servers.find((s) => s.builtIn) ?? null
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    let live = true
    scope.api.getInfo().then(
      (info) => live && setVersion(info.version),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [scope])

  if (!server) {
    return (
      <ListingFrame back={back}>
        <ListingSkeleton />
      </ListingFrame>
    )
  }
  const tools = server.tools
  return (
    <ListingFrame back={back} rise>
      <header className="k-mkt-head">
        <BrandIcon size={64} className="k-pub-kettu" />
        <span className="k-mkt-head__title">
          <span className="k-mkt-head__name">
            <h1>Kettu</h1>
            <KindTag kind="mcp" />
            <Pill>{t('kettu.builtIn')}</Pill>
          </span>
          <span className="k-mkt-head__pub">
            Kettu
            <OfficialBadge />
            <span className="k-mkt-head__trust" aria-hidden>
              {t('listing.official')}
            </span>
          </span>
          <span className="k-mkt-head__line">{t('builtin.line')}</span>
        </span>
        <span className="k-mkt-head__act">
          <span className="k-pub-running" data-running={server.running || undefined}>
            <i aria-hidden />
            {server.running ? t('kettu.running') : t('kettu.notRunning')}
            {' · '}
            {t('kettu.tools', { count: tools.length })}
          </span>
        </span>
      </header>

      <Facts toolCount={tools.length} version={version} />

      <div className="k-mkt-body">
        <div className="k-mkt-body__main">
          <p className="k-mkt-about">{t('builtin.about')}</p>
          <section>
            <h3>{t('builtin.tools')}</h3>
            <div className="k-mkt-list k-pub-groups">
              {GROUPS.map(({ id, icon }) => {
                const inGroup = tools.filter((tool) => tool.group === id)
                if (inGroup.length === 0) return null
                return id === 'marketplace' ? (
                  <MarketGroup key={id} icon={icon} tools={inGroup} />
                ) : (
                  <ToolGroup key={id} id={id} icon={icon} tools={inGroup} />
                )
              })}
            </div>
          </section>
        </div>
        <Side />
      </div>
    </ListingFrame>
  )
}

function Facts({ toolCount, version }: { toolCount: number; version: string | null }) {
  const { t } = useTranslation('marketplace')
  const { agents } = useKettuSwitches()
  return (
    <div className="k-mkt-facts k-pub-facts">
      <span>
        <small>{t('listing.facts.worksWith')}</small>
        <b className="k-mkt-facts__agents">
          {agents.slice(0, 6).map((agent) => (
            <AgentMark key={agent.id} agent={agent.id} size={15} />
          ))}
          <span className="k-mkt-facts__text">{t('listing.everyAgent')}</span>
        </b>
      </span>
      <span>
        <small>{t('builtin.facts.from')}</small>
        <b>{t('builtin.facts.builtInto')}</b>
      </span>
      {version && (
        <span>
          <small>{t('listing.facts.version')}</small>
          <b className="k-mkt-mono">{version}</b>
        </span>
      )}
      <span>
        <small>{t('builtin.facts.tools')}</small>
        <b>{toolCount}</b>
      </span>
    </div>
  )
}

/** The Marketplace tools, open, each with what it does and whether it waits for the user. */
function MarketGroup({ icon, tools }: { icon: IconSvgElement; tools: McpToolSummary[] }) {
  const { t } = useTranslation('marketplace')
  return (
    <div className="k-pub-group" data-new="">
      <span className="k-pub-group__head">
        <Icon icon={icon} size={15} />
        <b>{t('builtin.groups.marketplace')}</b>
        <span className="k-pub-count">{tools.length}</span>
        <span className="k-pub-new">{t('builtin.new')}</span>
        <small className="k-pub-group__when">{t('builtin.whileSignedIn')}</small>
      </span>
      <div className="k-pub-tools">
        {tools.map((tool) => (
          <div key={tool.name} className="k-pub-tool">
            <span className="k-mkt-mono" data-selectable="">
              {tool.name}
            </span>
            <small>
              {t(`builtin.marketTools.${tool.name}`, { defaultValue: tool.description })}
            </small>
            {tool.asks ? (
              <span className="k-pub-state" data-tone="attention">
                {t('builtin.waits')}
              </span>
            ) : (
              <span />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function ToolGroup({
  id,
  icon,
  tools,
}: {
  id: McpToolGroup
  icon: IconSvgElement
  tools: McpToolSummary[]
}) {
  const { t } = useTranslation('marketplace')
  const named = tools.slice(0, NAMED).map((tool) => tool.name)
  const rest = tools.length - named.length
  return (
    <div className="k-pub-group" title={tools.map((tool) => tool.name).join(', ')}>
      <span className="k-pub-group__head">
        <Icon icon={icon} size={15} />
        <b>{t(`builtin.groups.${id}`)}</b>
        <span className="k-pub-count">{tools.length}</span>
        <small className="k-mkt-mono k-pub-group__list">
          {named.join(', ')}
          {rest > 0 && ` ${t('builtin.more', { count: rest })}`}
        </small>
      </span>
    </div>
  )
}

/** Each agent's switch, then who publishes the server, where it runs and the signed-in account. */
function Side() {
  const { t } = useTranslation('marketplace')
  const { hostId } = useHostScope()
  const hostName = useHostName()
  useShowsPublished()
  const published = usePublishedStore()
  const account = published((s) => s.account)
  const { agents, off, error, set } = useKettuSwitches()
  const runs =
    hostId === null
      ? t(isMac ? 'builtin.side.runsMac' : 'builtin.side.runsComputer')
      : t('builtin.side.runsOn', { host: hostName(hostId) })
  return (
    <aside className="k-pub-aside">
      <div className="k-mkt-side">
        <h4 className="k-pub-aside__title">{t('builtin.useIn')}</h4>
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
        <p className="k-pub-note">{t('builtin.useInNote')}</p>
      </div>
      <div className="k-mkt-side" style={{ '--i': 1 } as CSSProperties}>
        <dl>
          <dt>{t('listing.side.publisher')}</dt>
          <dd>
            Kettu
            <OfficialBadge />
          </dd>
          <dt>{t('published.listing.side.kind')}</dt>
          <dd>{t('builtin.side.kindValue')}</dd>
          <dt>{t('builtin.side.runs')}</dt>
          <dd>{runs}</dd>
          <dt>{t('builtin.side.signedIn')}</dt>
          <dd>{account ? account.email : t('builtin.side.notSignedIn')}</dd>
        </dl>
      </div>
    </aside>
  )
}
