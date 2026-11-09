// A server's listing: what it is and who publishes it, Install or its controls once installed,
// the facts, what it runs and the values it needs, its links, and a few servers like it.

import { useState } from 'react'
import {
  CommandLineIcon,
  Delete02Icon,
  Key01Icon,
  LinkSquare02Icon,
  MoreHorizontalIcon,
  SlidersHorizontalIcon,
  Tick02Icon,
  UserMultiple02Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import {
  specInputs,
  type CatalogServer,
  type MarketServer,
  type McpSpec,
} from '@shared/marketplace'
import { backTo } from '@renderer/app/history'
import { Dropdown, Icon, Popover } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { SettingSwitch } from '@renderer/features/settings/controls'
import { mediumAgo } from '@renderer/lib/format'
import { currentLocale, i18n } from '@renderer/lib/i18n'
import { agentName } from '@renderer/stores/agents'
import { useMarketplaceStore } from '@renderer/stores/marketplace'
import { useSettingsStore } from '@renderer/stores/settings'
import { openMarketplace, type MarketplaceTab } from '@renderer/stores/view'
import { installServer, setServerOn } from './actions'
import { ServerTile } from './brand-marks'
import { AgentsDialog, KeysDialog, UninstallDialog } from './dialogs'
import { useChoosableAgents, useInstalling } from './hooks'
import { InstallForm } from './install'
import {
  asksFirst,
  catalogEntry,
  findListing,
  itemKey,
  parseItem,
  relatedServers,
  type Listing,
} from './model'
import { ExternalLink, ListingFrame, ListingSkeleton, Missing } from './parts'
import { PluginListing } from './plugins'
import { AddButton, ItemRow, OfficialBadge } from './rows'
import { SkillListing } from './skills'

/** Who publishes it: the catalog's maker, the user for a server added by hand, else unknown. */
function publisherOf(listing: Listing): string | null {
  if (listing.publisher) return listing.publisher
  return listing.source === 'manual' ? i18n.t('marketplace:listing.addedByYou') : null
}

/** The listing's Back: to the directory on the tab it was opened from. */
function leave(tab: MarketplaceTab): void {
  backTo({ kind: 'marketplace', ...(tab !== 'all' ? { tab } : {}) }, () => openMarketplace({ tab }))
}

/** A listing by its view's `item`: an MCP server's, a plugin's or a skill's. */
export function ListingPage({ item, tab }: { item: string; tab: MarketplaceTab }) {
  const ref = parseItem(item)
  const back = () => leave(tab)
  if (ref?.kind === 'plugin') {
    return <PluginListing harness={ref.harness} id={ref.id} tab={tab} back={back} />
  }
  if (ref?.kind === 'skill') return <SkillListing id={ref.id} tab={tab} back={back} />
  if (ref?.kind === 'mcp') return <McpListing id={ref.id} tab={tab} back={back} />
  return (
    <ListingFrame back={back}>
      <Missing back={back} />
    </ListingFrame>
  )
}

function McpListing({ id, tab, back }: { id: string; tab: MarketplaceTab; back: () => void }) {
  const { t } = useTranslation('marketplace')
  const kept = useSettingsStore((s) => s.settings.marketplace.mcp)
  // Read again whenever the catalog or a search answers, since either may hold the entry.
  const catalog = useMarketplaceStore((s) => s.catalog)
  useMarketplaceStore((s) => s.search)
  const loading = useMarketplaceStore((s) => s.catalogLoading || (!s.catalog && !s.catalogError))
  const listing = findListing(id, kept)
  const entry = catalogEntry(id)
  const server = kept.find((s) => s.id === id) ?? null

  if (!listing) {
    return (
      <ListingFrame back={back}>
        {loading ? <ListingSkeleton /> : <Missing back={back} />}
      </ListingFrame>
    )
  }

  const related = relatedServers(id, catalog)
  return (
    <ListingFrame back={back} rise>
      <header className="k-mkt-head">
        <ServerTile brand={listing.brand} name={listing.title} big />
        <span className="k-mkt-head__title">
          <span className="k-mkt-head__name">
            <h1>{listing.title}</h1>
            <span className="k-mkt-kind">{t('listing.kind')}</span>
          </span>
          <span className="k-mkt-head__pub">
            {publisherOf(listing)}
            {listing.official && (
              <>
                <OfficialBadge />
                <span className="k-mkt-head__trust" aria-hidden>
                  {t('listing.official')}
                </span>
              </>
            )}
          </span>
          {listing.description && <span className="k-mkt-head__line">{listing.description}</span>}
        </span>
        <span className="k-mkt-head__act">
          {server ? (
            <KeptControls server={server} onUninstalled={back} />
          ) : entry ? (
            <InstallButton server={entry} />
          ) : null}
        </span>
      </header>

      <Facts listing={listing} server={server} />

      <div className="k-mkt-body">
        <div className="k-mkt-body__main">
          <Runs spec={server?.spec ?? listing.spec} serverId={server?.id ?? null} />
        </div>
        <Side listing={listing} />
      </div>

      {related.items.length > 0 && (
        <section className="ui-as-int-section">
          <h2 className="ui-as-int-section__title">
            {related.byPublisher && listing.publisher
              ? t('listing.relatedFrom', { publisher: listing.publisher })
              : t('listing.related')}
          </h2>
          <div className="ui-as-int-grid">
            {related.items.map((item) => (
              <RelatedRow key={item.id} server={item} tab={tab} />
            ))}
          </div>
        </section>
      )}
    </ListingFrame>
  )
}

function RelatedRow({ server, tab }: { server: CatalogServer; tab: MarketplaceTab }) {
  const open = () => openMarketplace({ item: itemKey({ kind: 'mcp', id: server.id }), tab })
  return (
    <ItemRow
      title={server.title}
      brand={server.brand}
      official={server.official}
      line={server.description || null}
      onOpen={open}
      end={<AddButton server={server} onOpen={open} />}
    />
  )
}

/** Install, at once or through the install form when the server asks for values. */
function InstallButton({ server }: { server: CatalogServer }) {
  const { t } = useTranslation('marketplace')
  const [open, setOpen] = useState(false)
  const busy = useInstalling(server.id)
  const asks = asksFirst(server.spec)
  return (
    <span className="ui-as-anchor">
      <Button
        loading={busy}
        aria-expanded={asks ? open : undefined}
        onClick={() => {
          if (busy) return
          if (asks) setOpen((o) => !o)
          else void installServer(server, 'all', {})
        }}
      >
        {busy ? t('install.installing') : t('install.submit')}
      </Button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        align="end"
        className="ui-as-menu k-mkt-install-pop"
      >
        <InstallForm
          server={server}
          onDone={(agents, values) => {
            setOpen(false)
            void installServer(server, agents, values)
          }}
        />
      </Popover>
    </span>
  )
}

/** An installed server's controls: Installed, its switch and the menu of what else it takes. */
function KeptControls({
  server,
  onUninstalled,
}: {
  server: MarketServer
  onUninstalled: () => void
}) {
  const { t } = useTranslation('marketplace')
  const [dialog, setDialog] = useState<'keys' | 'agents' | 'uninstall' | null>(null)
  const inputs = specInputs(server.spec)
  const close = (open: boolean) => {
    if (!open) setDialog(null)
  }
  return (
    <>
      <span className="k-mkt-head__on">
        <Icon icon={Tick02Icon} size={14} />
        {t('listing.installed')}
      </span>
      <SettingSwitch
        label={t('listing.switch', { name: server.title })}
        checked={server.on}
        onChange={(on) => void setServerOn(server.id, on)}
      />
      <Dropdown
        align="end"
        items={[
          ...(inputs.length > 0
            ? [
                {
                  label: t('listing.changeKeys'),
                  icon: Key01Icon,
                  onSelect: () => setDialog('keys'),
                },
              ]
            : []),
          {
            label: t('listing.chooseAgents'),
            icon: UserMultiple02Icon,
            onSelect: () => setDialog('agents'),
          },
          {
            label: t('listing.uninstall'),
            icon: Delete02Icon,
            danger: true,
            divider: true,
            onSelect: () => setDialog('uninstall'),
          },
        ]}
        trigger={({ open, toggle }) => (
          <button
            type="button"
            className="k-mkt-icon-btn"
            aria-label={t('listing.more', { name: server.title })}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={toggle}
          >
            <Icon icon={MoreHorizontalIcon} size={16} />
          </button>
        )}
      />
      <KeysDialog server={server} open={dialog === 'keys'} onOpenChange={close} />
      <AgentsDialog server={server} open={dialog === 'agents'} onOpenChange={close} />
      <UninstallDialog
        server={server}
        open={dialog === 'uninstall'}
        onOpenChange={close}
        onUninstalled={onUninstalled}
      />
    </>
  )
}

/** Works with, where it comes from, its version and when it last changed. */
function Facts({ listing, server }: { listing: Listing; server: MarketServer | null }) {
  const { t } = useTranslation('marketplace')
  const agents = useChoosableAgents()
  const chosen = server && server.agents !== 'all' ? server.agents : null
  const marks = chosen ?? agents.map((agent) => agent.id)
  const updated = listing.updated ? Date.parse(listing.updated) : NaN
  return (
    <div className="k-mkt-facts">
      <span>
        <small>{t('listing.facts.worksWith')}</small>
        <b className="k-mkt-facts__agents">
          {marks.slice(0, 6).map((id) => (
            <AgentMark key={id} agent={id} size={15} />
          ))}
          <span className="k-mkt-facts__text">
            {chosen
              ? new Intl.ListFormat(currentLocale(), { type: 'conjunction' }).format(
                  chosen.map((id) => agentName(id)),
                )
              : t('listing.everyAgent')}
          </span>
        </b>
      </span>
      <span>
        <small>{t('listing.facts.source')}</small>
        <b>{listing.source === 'manual' ? t('listing.manual') : t('listing.registry')}</b>
      </span>
      {listing.version && (
        <span>
          <small>{t('listing.facts.version')}</small>
          <b className="k-mkt-mono">{listing.version}</b>
        </span>
      )}
      {!Number.isNaN(updated) && (
        <span>
          <small>{t('listing.facts.updated')}</small>
          <b>{mediumAgo(updated)}</b>
        </span>
      )}
    </div>
  )
}

/** What the server runs or connects to, and each value it is given or asks for. */
function Runs({ spec, serverId }: { spec: McpSpec; serverId: string | null }) {
  const { t } = useTranslation('marketplace')
  const keys = useMarketplaceStore((s) => (serverId ? (s.keys?.[serverId] ?? null) : null))
  const keysKnown = useMarketplaceStore((s) => s.keys !== null)
  const values = spec.type === 'http' ? spec.headers : spec.env
  const state = (name: string, required: boolean) => {
    if (!serverId) return t('listing.input.asked')
    if (!keysKnown) return null
    if (keys?.includes(name)) return t('listing.input.set')
    return required ? t('listing.input.notSetRequired') : t('listing.input.notSet')
  }
  return (
    <section>
      <h3>{t('listing.runs')}</h3>
      <div className="k-mkt-list">
        <div className="k-mkt-item">
          <Icon icon={spec.type === 'http' ? LinkSquare02Icon : CommandLineIcon} size={15} />
          <span>
            <b>
              {spec.type === 'http'
                ? t('listing.connectsTo', { transport: t(`listing.transport.${spec.transport}`) })
                : t('listing.runsHere')}
            </b>
            <small className="k-mkt-mono" data-selectable="">
              {spec.type === 'http' ? spec.url : [spec.command, ...spec.args].join(' ')}
            </small>
          </span>
        </div>
        {values.map((value) => (
          <div key={value.name} className="k-mkt-item">
            <Icon
              icon={'input' in value && value.secret ? Key01Icon : SlidersHorizontalIcon}
              size={15}
            />
            <span>
              <b className="k-mkt-mono">{value.name}</b>
              {'input' in value ? (
                <small>
                  {[
                    state(value.name, value.required),
                    value.secret ? t('listing.input.secret') : null,
                    value.prefix?.trim()
                      ? t('listing.input.prefix', { prefix: value.prefix.trim() })
                      : null,
                    value.description || null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
              ) : (
                <small className="k-mkt-mono" data-selectable="">
                  {value.value}
                </small>
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

/** Who publishes it, its registry name, and its links, which open in the system browser. */
function Side({ listing }: { listing: Listing }) {
  const { t } = useTranslation('marketplace')
  return (
    <aside className="k-mkt-side">
      <dl>
        <dt>{t('listing.side.publisher')}</dt>
        <dd>
          {publisherOf(listing) ?? t('listing.registry')}
          {listing.official && <OfficialBadge />}
        </dd>
        {listing.source === 'registry' && (
          <>
            <dt>{t('listing.side.name')}</dt>
            <dd className="k-mkt-mono" data-selectable="">
              {listing.id}
            </dd>
          </>
        )}
        {listing.repository && (
          <>
            <dt>{t('listing.side.repository')}</dt>
            <dd>
              <ExternalLink href={listing.repository} />
            </dd>
          </>
        )}
        {listing.website && (
          <>
            <dt>{t('listing.side.website')}</dt>
            <dd>
              <ExternalLink href={listing.website} />
            </dd>
          </>
        )}
        <dt>{t('listing.side.listedIn')}</dt>
        <dd>{listing.source === 'manual' ? t('listing.manual') : t('listing.registry')}</dd>
      </dl>
    </aside>
  )
}
