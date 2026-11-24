// What the Marketplace draws of Kettu's plugins: the tags of what a package holds, the row of an
// installed one, its controls and page, and the "From <plugin>" mark on the skills, servers and
// workflows it brought.

import { useState, type ReactNode } from 'react'
import {
  Alert02Icon,
  ArrowReloadHorizontalIcon,
  Delete02Icon,
  InformationCircleIcon,
  MoreHorizontalIcon,
  PuzzleIcon,
  Tick02Icon,
  Undo02Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { InstalledKettuPlugin, PluginContents } from '@shared/plugins'
import { PLUGIN_FORMAT } from '@shared/plugins'
import type { CommunityItem } from '@shared/market-community'
import type { MarketListing } from '@shared/market-publish'
import { Dropdown, Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Pill, SettingSwitch } from '@renderer/features/settings/controls'
import { mediumAgo } from '@renderer/lib/format'
import { currentLocale } from '@renderer/lib/i18n'
import { useHostScope } from '@renderer/stores/host-scope'
import type { MarketplaceTab } from '@renderer/stores/view'
import { ConfirmDialog } from './dialogs'
import { useBusy, useChoosableAgents } from './hooks'
import { homeShort } from './model'
import {
  checkPluginUpdate,
  pluginBusy,
  reloadPlugin,
  rollBackPlugin,
  setPluginOn,
  uninstallPlugin,
} from './plugin-actions'
import { Line, PermissionLine, PluginUpdateDialog } from './plugin-install'
import {
  openPlugin,
  useInstalledPlugins,
  usePluginInstall,
  usePluginOfItem,
  usePluginName,
  usePluginOfListing,
  usePluginPublisher,
  useSourceReading,
} from './plugin-hooks'
import {
  ITEM_ICON,
  SCRIPT_ICON,
  addsRows,
  addsTags,
  contentsRows,
  contentsTags,
  itemCount,
  permissionRows,
  pluginDescription,
  pluginTitle,
  type PluginItemRow,
  type PluginTag,
} from './plugin-model'
import { ExternalLink, ListingFrame, ListingSkeleton, Missing } from './parts'
import { InstalledCheck, ItemRow, KindTag } from './rows'
import { kettuPluginSubject } from './tile-art'
import { ItemTile } from './tiles'

function useTagLabel(): (tag: PluginTag) => string {
  const { t } = useTranslation('marketplace')
  return (tag) =>
    tag.kind === 'script'
      ? t('plugin.tags.script')
      : t(`plugin.tags.${tag.kind}`, { count: tag.count })
}

/**
 * The small tags under a plugin's line: how many of each kind it holds, and an amber one when it
 * runs code. With `limit`, a card keeps the script tag and the first kinds that fit.
 */
export function PluginTags({ tags, limit }: { tags: PluginTag[]; limit?: number }) {
  const label = useTagLabel()
  if (tags.length === 0) return null
  let shown = tags
  if (limit !== undefined && tags.length > limit) {
    const script = tags.filter((tag) => tag.kind === 'script')
    shown = [
      ...tags.filter((tag) => tag.kind !== 'script').slice(0, limit - script.length),
      ...script,
    ]
  }
  return (
    <span className="k-plug-tags">
      {shown.map((tag) => (
        <span key={tag.kind} className="k-plug-tag" data-kind={tag.kind}>
          <Icon icon={tag.kind === 'script' ? SCRIPT_ICON : ITEM_ICON[tag.kind]} size={11} />
          {label(tag)}
        </span>
      ))}
    </span>
  )
}

/** "<version> asks for more", the mark of an update that waits for the user. */
function AsksForMore({ plugin }: { plugin: InstalledKettuPlugin }) {
  const { t } = useTranslation('marketplace')
  const version = plugin.held?.version
  return (
    <span className="k-plug-asks">
      <Icon icon={Alert02Icon} size={11} />
      {version ? t('plugin.row.asksForMore', { version }) : t('plugin.row.asksForMoreNoVersion')}
    </span>
  )
}

/** A plugin's row in Installed: its facts, tags and switch; a folder's Dev tag, path and Reload. */
export function PluginInstalledRow({ plugin }: { plugin: InstalledKettuPlugin }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const publisher = usePluginPublisher()
  const [updating, setUpdating] = useState(false)
  const locale = currentLocale()
  const { contents } = plugin
  const title = pluginTitle(contents, locale)
  const busy = useBusy(pluginBusy(plugin.id))
  const count = itemCount(contents)
  const path = plugin.source.kind === 'local' ? homeShort(plugin.source.path) : null
  const facts = [
    publisher(plugin),
    contents.version,
    t('plugin.row.items', { count }),
    t('listing.everyAgent'),
    plugin.enabled ? null : t('installed.off'),
  ].filter((fact): fact is string => !!fact)
  return (
    <>
      <ItemRow
        title={title}
        subject={kettuPluginSubject({ name: contents.name, icon: contents.icon })}
        tag={
          <>
            {plugin.development && <Pill>{t('plugin.install.dev')}</Pill>}
            {plugin.held && <AsksForMore plugin={plugin} />}
          </>
        }
        meta={facts.map((fact) => (
          <span key={fact}>{fact}</span>
        ))}
        line={path ?? (pluginDescription(contents, locale) || null)}
        oneLine={path !== null}
        extra={<PluginTags tags={contentsTags(contents)} />}
        onOpen={() => openPlugin(plugin.id, 'installed')}
        end={
          <>
            {plugin.held && (
              <Button size="md" variant="secondary" onClick={() => setUpdating(true)}>
                {t('plugin.row.viewUpdate')}
              </Button>
            )}
            {plugin.development && (
              <Button
                size="md"
                variant="ghost"
                loading={busy}
                icon={<Icon icon={ArrowReloadHorizontalIcon} size={14} />}
                aria-label={t('plugin.menu.reloadName', { name: title })}
                onClick={() => void reloadPlugin(scope, plugin)}
              >
                {t('plugin.menu.reload')}
              </Button>
            )}
            <SettingSwitch
              label={t('listing.switch', { name: title })}
              checked={plugin.enabled}
              disabled={busy}
              onChange={(on) => void setPluginOn(scope, plugin, on)}
            />
          </>
        }
      />
      {plugin.held && (
        <PluginUpdateDialog plugin={plugin} open={updating} onOpenChange={setUpdating} />
      )}
    </>
  )
}

/** An installed plugin's controls: Installed, its switch, and its other actions in a menu. */
export function PluginControls({
  plugin,
  onRemoved,
}: {
  plugin: InstalledKettuPlugin
  onRemoved: () => void
}) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const [removing, setRemoving] = useState(false)
  const title = pluginTitle(plugin.contents, currentLocale())
  const busy = useBusy(pluginBusy(plugin.id))
  const rollBackTo = plugin.previous?.version
  return (
    <>
      <span className="k-mkt-head__on">
        <Icon icon={Tick02Icon} size={14} />
        {t('listing.installed')}
      </span>
      <SettingSwitch
        label={t('listing.switch', { name: title })}
        checked={plugin.enabled}
        disabled={busy}
        onChange={(on) => void setPluginOn(scope, plugin, on)}
      />
      <Dropdown
        align="end"
        items={[
          plugin.source.kind === 'local'
            ? {
                label: t('plugin.menu.reload'),
                icon: ArrowReloadHorizontalIcon,
                disabled: busy,
                onSelect: () => void reloadPlugin(scope, plugin),
              }
            : {
                label: t('plugin.menu.checkUpdates'),
                icon: ArrowReloadHorizontalIcon,
                disabled: busy,
                onSelect: () => void checkPluginUpdate(scope, plugin),
              },
          ...(plugin.previous
            ? [
                {
                  label: rollBackTo
                    ? t('plugin.menu.rollBackTo', { version: rollBackTo })
                    : t('plugin.menu.rollBack'),
                  icon: Undo02Icon,
                  disabled: busy,
                  onSelect: () => void rollBackPlugin(scope, plugin),
                },
              ]
            : []),
          {
            label: t('listing.uninstall'),
            icon: Delete02Icon,
            danger: true,
            divider: true,
            onSelect: () => setRemoving(true),
          },
        ]}
        trigger={({ open, toggle }) => (
          <button
            type="button"
            className="k-mkt-icon-btn"
            aria-label={t('listing.more', { name: title })}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={toggle}
          >
            <Icon icon={MoreHorizontalIcon} size={16} />
          </button>
        )}
      />
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={t('plugin.remove.title', { name: title })}
        body={t('plugin.remove.body')}
        confirm={t('plugin.remove.confirm')}
        action={async () => {
          await uninstallPlugin(scope, plugin)
          onRemoved()
        }}
      />
    </>
  )
}

/** "In this plugin": one row for each item the package holds. */
export function PluginItemsSection({ rows }: { rows: PluginItemRow[] }) {
  const { t } = useTranslation('marketplace')
  if (rows.length === 0) return null
  return (
    <section>
      <h3>{t('plugin.item.heading')}</h3>
      <div className="k-mkt-list">
        {rows.map((row, i) => (
          <Line
            key={`${row.kind}:${row.title}:${i}`}
            icon={ITEM_ICON[row.kind]}
            title={row.title}
            tag={<span className="k-plug-kind">{t(`plugin.item.${row.kind}`)}</span>}
            note={
              row.runs
                ? 'url' in row.runs
                  ? t('plugin.holds.connectsTo', { host: row.runs.url })
                  : t('plugin.holds.runs', { command: row.runs.command })
                : row.line
            }
          />
        ))}
      </div>
    </section>
  )
}

/** "Runs and needs" for a package that is read: its script and each permission, or that it has none. */
export function PluginRunsSection({ contents }: { contents: PluginContents }) {
  const { t } = useTranslation('marketplace')
  const rows = permissionRows(contents.permissions)
  return (
    <section>
      <h3>{t('listing.runs')}</h3>
      <div className="k-mkt-list">
        {contents.script ? (
          <>
            <Line
              icon={SCRIPT_ICON}
              title={t('plugin.script.runs')}
              note={t('plugin.script.runsNote')}
            />
            {rows.length === 0 ? (
              <Line icon={InformationCircleIcon} title={t('plugin.script.noPermissions')} />
            ) : (
              rows.map((row) => <PermissionLine key={row.permission} row={row} />)
            )}
          </>
        ) : (
          <Line
            icon={InformationCircleIcon}
            title={t('plugin.script.none')}
            note={t('plugin.script.noneNote')}
          />
        )}
        {contents.hooks && (
          <Line
            icon={InformationCircleIcon}
            title={t('plugin.note.hooksTitle')}
            note={t('plugin.note.hooks')}
          />
        )}
      </div>
    </section>
  )
}

/** "Runs and needs" for a listing not downloaded yet: whether it runs a script, and when it asks. */
export function PluginListedRuns({ script }: { script: boolean }) {
  const { t } = useTranslation('marketplace')
  return (
    <section>
      <h3>{t('listing.runs')}</h3>
      <div className="k-mkt-list">
        {script ? (
          <Line
            icon={SCRIPT_ICON}
            title={t('plugin.script.runs')}
            note={t('plugin.script.listedNote')}
          />
        ) : (
          <Line
            icon={InformationCircleIcon}
            title={t('plugin.script.none')}
            note={t('plugin.script.noneNote')}
          />
        )}
      </div>
    </section>
  )
}

/** Works with, version, when it changed and whether it runs a script. */
export function PluginFacts({
  version,
  updated,
  script,
}: {
  version: string | null
  updated: number | null
  script: boolean
}) {
  const { t } = useTranslation('marketplace')
  const agents = useChoosableAgents()
  return (
    <div className="k-mkt-facts">
      <span>
        <small>{t('listing.facts.worksWith')}</small>
        <b className="k-mkt-facts__agents">
          {agents.slice(0, 6).map((agent) => (
            <AgentMark key={agent.id} agent={agent.id} size={15} />
          ))}
          <span className="k-mkt-facts__text">{t('listing.everyAgent')}</span>
        </b>
      </span>
      {version && (
        <span>
          <small>{t('listing.facts.version')}</small>
          <b className="k-mkt-mono">{version}</b>
        </span>
      )}
      {updated !== null && !Number.isNaN(updated) && (
        <span>
          <small>{t('listing.facts.updated')}</small>
          <b>{mediumAgo(updated)}</b>
        </span>
      )}
      <span>
        <small>{t('plugin.facts.script')}</small>
        <b>{script ? t('plugin.facts.scriptYes') : t('plugin.facts.scriptNo')}</b>
      </span>
    </div>
  )
}

/** The right column's rows: a label and what it holds, the empty ones left out. */
export function PluginSide({
  rows,
  children,
}: {
  rows: { label: string; value: ReactNode }[]
  children?: ReactNode
}) {
  return (
    <aside className="k-mkt-side">
      <dl>
        {rows.map((row) => (
          <SideRow key={row.label} {...row} />
        ))}
      </dl>
      {children}
    </aside>
  )
}

function SideRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  )
}

/** The side column of an installed plugin: where it is from, its license and the format it is in. */
function installedSide(
  plugin: InstalledKettuPlugin,
  publisher: string,
  t: ReturnType<typeof useTranslation<'marketplace'>>['t'],
): { label: string; value: ReactNode }[] {
  const { contents, source } = plugin
  const rows: { label: string; value: ReactNode }[] = [
    { label: t('listing.side.publisher'), value: publisher },
    {
      label: t('listing.facts.source'),
      value:
        source.kind === 'kettu' ? (
          t('community.source')
        ) : source.kind === 'github' ? (
          <ExternalLink href={source.url} />
        ) : (
          <span className="k-mkt-mono" data-selectable="">
            {homeShort(source.path)}
          </span>
        ),
    },
  ]
  if (contents.license) rows.push({ label: t('plugin.side.license'), value: contents.license })
  rows.push({
    label: t('plugin.side.format'),
    value: t('plugin.side.formatValue', { version: PLUGIN_FORMAT }),
  })
  if (contents.homepage) {
    rows.push({
      label: t('listing.side.website'),
      value: <ExternalLink href={contents.homepage} />,
    })
  }
  if (contents.repository && contents.repository !== contents.homepage) {
    rows.push({
      label: t('listing.side.repository'),
      value: <ExternalLink href={contents.repository} />,
    })
  }
  return rows
}

/** An installed plugin's page: what it holds, what its script may do, and its controls. */
export function PluginPage({ id, back }: { id: string; tab: MarketplaceTab; back: () => void }) {
  const { t } = useTranslation('marketplace')
  const { useMarketplaceStore } = useHostScope()
  const plugins = useInstalledPlugins()
  const error = useMarketplaceStore((s) => s.pluginsError)
  const publisher = usePluginPublisher()
  const [updating, setUpdating] = useState(false)
  const plugin = plugins?.find((item) => item.id === id) ?? null
  if (!plugin) {
    return (
      <ListingFrame back={back}>
        {plugins === null && !error ? <ListingSkeleton /> : <Missing back={back} />}
      </ListingFrame>
    )
  }
  const locale = currentLocale()
  const { contents } = plugin
  const title = pluginTitle(contents, locale)
  const description = pluginDescription(contents, locale)
  return (
    <ListingFrame back={back} rise>
      <header className="k-mkt-head">
        <ItemTile
          subject={kettuPluginSubject({ name: contents.name, icon: contents.icon })}
          size="big"
        />
        <span className="k-mkt-head__title">
          <span className="k-mkt-head__name">
            <h1>{title}</h1>
            <KindTag kind="plugin" />
            {plugin.development && <Pill>{t('plugin.install.dev')}</Pill>}
          </span>
          <span className="k-mkt-head__pub">
            {publisher(plugin)}
            {contents.version && <span className="k-mkt-head__trust">{contents.version}</span>}
          </span>
          {description && <span className="k-mkt-head__line">{description}</span>}
        </span>
        <span className="k-mkt-head__act">
          <PluginControls plugin={plugin} onRemoved={back} />
        </span>
      </header>

      {plugin.held && (
        <div className="k-plug-banner" role="status">
          <Icon icon={Alert02Icon} size={16} />
          <span>
            <b>
              {plugin.held.version
                ? t('plugin.row.asksForMore', { version: plugin.held.version })
                : t('plugin.row.asksForMoreNoVersion')}
            </b>
            <small>{t('plugin.row.asksNote')}</small>
          </span>
          <Button size="md" variant="secondary" onClick={() => setUpdating(true)}>
            {t('plugin.row.viewUpdate')}
          </Button>
          <PluginUpdateDialog plugin={plugin} open={updating} onOpenChange={setUpdating} />
        </div>
      )}
      {plugin.updateError && !plugin.held && (
        <p className="k-mkt-stale" role="status">
          <span>{t('plugin.row.updateError', { error: plugin.updateError })}</span>
        </p>
      )}
      {plugin.development && (
        <p className="k-mkt-section-note k-plug-devnote">
          {t('plugin.row.devNote', {
            path: plugin.source.kind === 'local' ? homeShort(plugin.source.path) : '',
          })}
        </p>
      )}

      <PluginFacts
        version={contents.version}
        updated={plugin.updatedAt}
        script={contents.script !== null}
      />

      <div className="k-mkt-body">
        <div className="k-mkt-body__main">
          <PluginItemsSection rows={contentsRows(contents)} />
          <PluginRunsSection contents={contents} />
          {contents.warnings.length > 0 && (
            <p className="k-mkt-section-note k-plug-devnote" data-selectable="">
              {t('plugin.note.warnings', { list: contents.warnings.slice(0, 3).join('; ') })}
            </p>
          )}
        </div>
        <PluginSide rows={installedSide(plugin, publisher(plugin), t)} />
      </div>
    </ListingFrame>
  )
}

/** "From <plugin>": opens the plugin an item came with. Quiet while the plugin is not read yet. */
export function FromPlugin({
  itemId,
  tab = 'installed',
}: {
  itemId: string
  tab?: MarketplaceTab
}) {
  const { t } = useTranslation('marketplace')
  const found = usePluginOfItem(itemId)
  if (!found) return null
  const { plugin } = found
  const name = plugin ? pluginTitle(plugin.contents, currentLocale()) : t('plugin.from.unknown')
  return (
    <button
      type="button"
      className="k-plug-from"
      data-quiet=""
      title={t('plugin.from.note')}
      disabled={!plugin}
      onClick={() => plugin && openPlugin(plugin.id, tab)}
    >
      <Icon icon={PuzzleIcon} size={12} />
      {t('plugin.from.name', { plugin: name })}
    </button>
  )
}

/** "From <plugin>" in a workflow row's facts, as plain words. */
export function PluginByline({ origin }: { origin: { pluginId: string; plugin: string } }) {
  const { t } = useTranslation('marketplace')
  const name = usePluginName(origin.pluginId, origin.plugin)
  return <span className="k-workflow-by">{t('plugin.from.name', { plugin: name })}</span>
}

/** "From <plugin>" for a workflow, by the plugin its origin names. */
export function FromPluginOrigin({ origin }: { origin: { pluginId: string; plugin: string } }) {
  const { t } = useTranslation('marketplace')
  const plugins = useInstalledPlugins()
  const plugin = plugins?.find((item) => item.id === origin.pluginId) ?? null
  const name = usePluginName(origin.pluginId, origin.plugin)
  return (
    <button
      type="button"
      className="k-plug-from"
      disabled={!plugin}
      onClick={() => plugin && openPlugin(plugin.id, 'installed')}
    >
      <Icon icon={PuzzleIcon} size={12} />
      {t('plugin.from.name', { plugin: name })}
    </button>
  )
}

/** A listing's Install in a row: the package is read, then the card asks; Installed once it is. */
export function PluginRowAction({
  item,
  onOpen,
}: {
  item: Pick<CommunityItem, 'id' | 'name' | 'handle' | 'official'>
  onOpen: () => void
}) {
  const { t } = useTranslation('marketplace')
  const install = usePluginInstall()
  const plugin = usePluginOfListing(item.id)
  const source = { kind: 'kettu', id: item.id } as const
  const reading = useSourceReading(source)
  if (plugin) return <InstalledCheck name={item.name} onOpen={onOpen} />
  return (
    <>
      <Button
        size="md"
        variant="secondary"
        loading={reading}
        aria-label={t('row.action', { action: t('row.install'), name: item.name })}
        onClick={() =>
          void install.start(source, { meta: { publisher: item.handle, official: item.official } })
        }
      >
        {t('row.install')}
      </Button>
      {install.dialogs}
    </>
  )
}

/** A listing page's Install, or once installed, the plugin's controls and a waiting update. */
export function PluginListingAction({
  listing,
  back,
}: {
  listing: MarketListing
  back: () => void
}) {
  const { t } = useTranslation('marketplace')
  const install = usePluginInstall()
  const plugin = usePluginOfListing(listing.id)
  const [updating, setUpdating] = useState(false)
  const source = { kind: 'kettu', id: listing.id } as const
  const reading = useSourceReading(source)
  if (plugin) {
    return (
      <>
        {plugin.held && (
          <>
            <Button onClick={() => setUpdating(true)}>{t('plugin.row.viewUpdate')}</Button>
            <PluginUpdateDialog plugin={plugin} open={updating} onOpenChange={setUpdating} />
          </>
        )}
        <PluginControls plugin={plugin} onRemoved={back} />
      </>
    )
  }
  return (
    <>
      <Button
        loading={reading}
        onClick={() =>
          void install.start(source, {
            meta: { publisher: listing.handle, official: listing.official },
          })
        }
      >
        {t('row.install')}
      </Button>
      {install.dialogs}
    </>
  )
}

/**
 * What a plugin's listing says it holds: its items by name from the publisher's check, or the
 * package's own rows once it is installed, and whether it runs a script.
 */
export function PluginListingBody({
  listing,
  preview = false,
}: {
  listing: MarketListing
  /** As others see it, which is never the package installed here. */
  preview?: boolean
}) {
  const installed = usePluginOfListing(listing.id)
  const plugin = preview ? null : installed
  if (plugin) {
    return (
      <>
        <PluginItemsSection rows={contentsRows(plugin.contents)} />
        <PluginRunsSection contents={plugin.contents} />
      </>
    )
  }
  const script = addsTags(listing.adds).some((tag) => tag.kind === 'script')
  return (
    <>
      <PluginItemsSection rows={addsRows(listing.adds)} />
      <PluginListedRuns script={script} />
    </>
  )
}

/** What a listing's side column adds once its plugin is read: the license and the format. */
export function PluginSideExtra({ listingId }: { listingId: string }) {
  const { t } = useTranslation('marketplace')
  const plugin = usePluginOfListing(listingId)
  if (!plugin) return null
  return (
    <>
      {plugin.contents.license && (
        <SideRow label={t('plugin.side.license')} value={plugin.contents.license} />
      )}
      <SideRow
        label={t('plugin.side.format')}
        value={t('plugin.side.formatValue', { version: PLUGIN_FORMAT })}
      />
    </>
  )
}
