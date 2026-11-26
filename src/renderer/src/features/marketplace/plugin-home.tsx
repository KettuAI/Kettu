// A plugin's one home: its page in the Marketplace, which its listing turns into once it is
// installed. One page from top to bottom: the state Kettu judges and the line its script sets,
// its settings, the notices it is sent, its own views and actions, where else it shows up, what
// its script may do, and Uninstall.

import { useEffect, useState, type ReactNode } from 'react'
import {
  Alert02Icon,
  AiBrain01Icon,
  ArrowDown01Icon,
  AtIcon,
  FlashIcon,
  Link01Icon,
  Search01Icon,
  SidebarRightIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { parseLinkPattern } from '@shared/plugin-refs'
import {
  missingSettings,
  pluginState,
  type InstalledKettuPlugin,
  type PluginState,
} from '@shared/plugins'
import { Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { toast } from '@renderer/components/ui/toast'
import { languageText } from '@renderer/features/plugin-views/plugin-text'
import { PluginView } from '@renderer/features/plugin-views/plugin-view'
import { runPluginAction } from '@renderer/features/plugin-views/run-action'
import { DangerButton, Pill } from '@renderer/features/settings/controls'
import { FlashContext } from '@renderer/features/settings/model'
import { focusedPane } from '@renderer/features/split/layout'
import { hostOfPath } from '@renderer/lib/host-paths'
import { currentLocale, i18n } from '@renderer/lib/i18n'
import { useHostScope } from '@renderer/stores/host-scope'
import {
  openPluginPane,
  openSession,
  useViewStore,
  type MarketplaceTab,
} from '@renderer/stores/view'
import { useHostName, useNamesHosts } from '@renderer/stores/window-host'
import { ConfirmDialog, PluginToolAgentsDialog } from './dialogs'
import { useAgentName } from './hooks'
import { homeShort } from './model'
import { uninstallPlugin } from './plugin-actions'
import { useInstalledPlugins, usePluginPublisher } from './plugin-hooks'
import { Line, PermissionLine, PluginUpdateDialog } from './plugin-install'
import { takePluginLanding, usePluginLanding, type PluginLanding } from './plugin-landing'
import {
  channelText,
  contentsRows,
  missingWords,
  permissionRows,
  pluginDescription,
  pluginTitle,
  SCRIPT_ICON,
  settingRow,
} from './plugin-model'
import { ChannelRows, PluginSettingRow } from './plugin-settings'
import { PluginControls, PluginInstalledSide, PluginItemsSection } from './plugin-ui'
import { ListingFrame, ListingSkeleton, Missing } from './parts'
import { KindTag } from './rows'
import { kettuPluginSubject } from './tile-art'
import { ItemTile } from './tiles'

// Bound to the namespace only: each call reads the language shown at the time.
const tm = i18n.getFixedT(null, 'marketplace')

const WHERE_ICON = {
  pane: SidebarRightIcon,
  mention: AtIcon,
  link: Link01Icon,
  action: Search01Icon,
  tools: AiBrain01Icon,
} as const satisfies Record<string, IconSvgElement>

/** One place the plugin shows up: where, what it adds there, and a way to it. */
function WhereRow({
  icon,
  place,
  title,
  note,
  end,
}: {
  icon: IconSvgElement
  place: string
  title: string
  note?: string | null
  end?: ReactNode
}) {
  return (
    <div className="k-plug-where">
      <Icon icon={icon} size={15} />
      <span className="k-plug-where__place">{place}</span>
      <span className="k-plug-where__text">
        <b>{title}</b>
        {note && <small>{note}</small>}
      </span>
      {end && <span className="k-plug-where__end">{end}</span>}
    </div>
  )
}

/** The session the window last showed, when it runs on the plugin's host. */
function useLastSession(hostId: string | null): { sessionId: string; projectPath: string } | null {
  const view = useViewStore((s) => focusedPane(s.layout).view)
  if (view.kind !== 'session' || view.projectPath === null) return null
  return hostOfPath(view.projectPath) === hostId
    ? { sessionId: view.sessionId, projectPath: view.projectPath }
    : null
}

/** Side panel, @ menu, replies, Search and agents: each place the plugin adds something. */
function WhereSection({ plugin }: { plugin: InstalledKettuPlugin }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const agentName = useAgentName()
  const last = useLastSession(scope.hostId)
  const [choosing, setChoosing] = useState(false)
  const locale = currentLocale()
  const { contents } = plugin
  if (!contents.script) return null
  const rows: ReactNode[] = []
  for (const pane of contents.views.filter((view) => view.pane)) {
    rows.push(
      <WhereRow
        key={`pane:${pane.id}`}
        icon={WHERE_ICON.pane}
        place={t('plugin.where.sidePanel')}
        title={languageText(pane.title, locale) || pane.id}
        note={pane.description ? languageText(pane.description, locale) : null}
        end={
          last &&
          plugin.enabled && (
            <button
              type="button"
              className="k-plug-go"
              onClick={() => {
                openSession(last.sessionId, last.projectPath)
                openPluginPane(last.sessionId, { pluginId: plugin.id, viewId: pane.id })
              }}
            >
              {t('plugin.where.openInSession')}
            </button>
          )
        }
      />,
    )
  }
  for (const mention of contents.mentions) {
    rows.push(
      <WhereRow
        key={`mention:${mention.id}`}
        icon={WHERE_ICON.mention}
        place={t('plugin.where.mentions')}
        title={languageText(mention.title, locale) || mention.id}
        note={t('plugin.where.mentionNote')}
      />,
    )
  }
  const hosts = [
    ...new Set(
      contents.links.flatMap((link) =>
        link.patterns.flatMap((text) => parseLinkPattern(text)?.host ?? []),
      ),
    ),
  ]
  if (hosts.length > 0) {
    rows.push(
      <WhereRow
        key="links"
        icon={WHERE_ICON.link}
        place={t('plugin.where.replies')}
        title={t('plugin.where.links')}
        note={t('plugin.where.linksNote', { hosts: hosts.join(', ') })}
      />,
    )
  }
  for (const action of contents.actions ?? []) {
    rows.push(
      <WhereRow
        key={`action:${action.id}`}
        icon={WHERE_ICON.action}
        place={t('plugin.where.search')}
        title={languageText(action.title, locale) || action.id}
        note={action.description ? languageText(action.description, locale) : null}
      />,
    )
  }
  const tools = contents.permissions.includes('tools') ? contents.tools : []
  if (tools.length > 0) {
    const agents = plugin.toolAgents ?? 'all'
    const given =
      agents === 'all'
        ? t('listing.everyAgent')
        : agents.length === 1
          ? agentName(agents[0]!)
          : agents.length === 0
            ? t('plugin.where.noAgent')
            : t('plugin.where.agents', { count: agents.length })
    const title = pluginTitle(contents, locale)
    rows.push(
      <WhereRow
        key="tools"
        icon={WHERE_ICON.tools}
        place={t('plugin.where.agentsPlace')}
        title={t('plugin.where.tools', { count: tools.length })}
        note={tools.map((tool) => tool.name).join(', ')}
        end={
          <>
            <button
              type="button"
              className="k-plug-select"
              aria-label={t('plugin.where.chooseAgents', { name: title })}
              onClick={() => setChoosing(true)}
            >
              {given}
              <Icon icon={ArrowDown01Icon} size={12} />
            </button>
            <PluginToolAgentsDialog
              plugin={plugin}
              name={title}
              open={choosing}
              onOpenChange={setChoosing}
            />
          </>
        }
      />,
    )
  }
  if (rows.length === 0) return null
  return (
    <section className="k-plug-sec">
      <h3>
        {t('plugin.page.where')}
        <span className="k-plug-sec__count">{rows.length}</span>
      </h3>
      <div className="ui-sg-card">{rows}</div>
    </section>
  )
}

/** The views the plugin draws on its own page, and its actions as buttons beside them. */
function StatusSection({ plugin }: { plugin: InstalledKettuPlugin }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const locale = currentLocale()
  const { contents } = plugin
  if (!plugin.enabled || !contents.script) return null
  const views = contents.views.filter((view) => view.page)
  const actions = contents.actions ?? []
  if (views.length === 0 && actions.length === 0) return null
  return (
    <section className="k-plug-sec">
      <h3>{t('plugin.page.status')}</h3>
      {views.map((view) => (
        <div key={view.id} className="ui-sg-card k-plug-view">
          <PluginView request={scope.request} pluginId={plugin.id} viewId={view.id} bar={false} />
        </div>
      ))}
      {actions.length > 0 && (
        <div className="k-plug-actions">
          {actions.map((action) => {
            const label = languageText(action.title, locale) || action.id
            return (
              <Button
                key={action.id}
                size="md"
                variant="secondary"
                icon={<Icon icon={FlashIcon} size={14} />}
                onClick={() =>
                  void runPluginAction({
                    hostId: scope.hostId,
                    pluginId: plugin.id,
                    actionId: action.id,
                    label,
                  })
                }
              >
                {label}
              </Button>
            )
          })}
        </div>
      )}
    </section>
  )
}

/** The page's sections under its head, in the order the page reads. */
function PluginBody({
  plugin,
  focus,
  flash,
  onRemoved,
}: {
  plugin: InstalledKettuPlugin
  /** The setting to put the caret in, the first missing one on landing. */
  focus: string | null
  flash: string | null
  onRemoved: () => void
}) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const [removing, setRemoving] = useState(false)
  const { contents } = plugin
  const title = pluginTitle(contents, currentLocale())
  const missing = missingSettings(plugin)
  const attention = plugin.enabled && missing.length > 0
  const permissions = permissionRows(contents.permissions)
  return (
    <FlashContext.Provider value={flash}>
      <div className="k-mkt-body__main kettu-sd k-plug-home">
        {contents.settings.length > 0 && (
          <section className="k-plug-sec" data-attention={attention || undefined}>
            <h3>{t('plugin.page.settings')}</h3>
            <div className="ui-sg-card">
              {contents.settings.map((setting) => (
                <PluginSettingRow
                  key={setting.key}
                  plugin={plugin}
                  setting={setting}
                  focus={setting.key === focus}
                />
              ))}
            </div>
            {attention && (
              <p className="k-plug-missing" role="status">
                <Icon icon={Alert02Icon} size={14} />
                {t('plugin.page.missing', { what: missingWords(missing) })}
              </p>
            )}
          </section>
        )}
        {(contents.channels ?? []).map((channel) => {
          const text = channelText(channel)
          return (
            <section key={channel.id} className="k-plug-sec">
              <h3>
                {t('plugin.page.notices')}
                <span className="k-plug-sec__note">{text.title}</span>
              </h3>
              <div className="ui-sg-card">
                <ChannelRows plugin={plugin} channel={channel} />
              </div>
              <p className="k-plug-sec__hint">{text.description ?? t('plugin.page.noticesHint')}</p>
            </section>
          )
        })}
        <StatusSection plugin={plugin} />
        <WhereSection plugin={plugin} />
        <PluginItemsSection rows={contentsRows(contents)} />
        {contents.script && (
          <section className="k-plug-sec">
            <h3>
              {t('plugin.script.heading')}
              <span className="k-plug-sec__count">{permissions.length}</span>
            </h3>
            <div className="k-mkt-list">
              <Line
                icon={SCRIPT_ICON}
                title={t('plugin.script.runs')}
                note={t('plugin.script.runsNote')}
              />
              {permissions.map((row) => (
                <PermissionLine key={row.permission} row={row} />
              ))}
              {contents.hooks && (
                <Line
                  icon={Alert02Icon}
                  title={t('plugin.note.hooksTitle')}
                  note={t('plugin.note.hooks')}
                />
              )}
            </div>
          </section>
        )}
        {contents.warnings.length > 0 && (
          <p className="k-mkt-section-note k-plug-devnote" data-selectable="">
            {t('plugin.note.warnings', { list: contents.warnings.slice(0, 3).join('; ') })}
          </p>
        )}
        <div className="k-plug-uninstall">
          <DangerButton onClick={() => setRemoving(true)}>
            {t('plugin.page.uninstall')}
          </DangerButton>
        </div>
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
      </div>
    </FlashContext.Provider>
  )
}

/** The line under the head: what the script says about itself, or why the script was stopped. */
function StatusLine({ plugin, state }: { plugin: InstalledKettuPlugin; state: PluginState }) {
  const { t } = useTranslation('marketplace')
  if (state === 'error') {
    return (
      <p className="k-plug-status" data-state="error" role="status">
        <Icon icon={Alert02Icon} size={14} />
        {t('plugin.page.crashed')}
      </p>
    )
  }
  if (!plugin.status) return null
  return (
    <p className="k-plug-status" data-selectable="">
      <Icon icon={Tick02Icon} size={14} />
      {plugin.status}
    </p>
  )
}

/** What the page does once a way onto it asked: the row it shows and the setting it focuses. */
interface Taken {
  row: string | null
  /** Whether the row flashes, as a search result's does. */
  flash: boolean
  focus: string | null
  /** What a toast says after an install. */
  toast: string | null
}

/**
 * Takes, once, what the way onto the page asked of it: the row to show, which flashes as a search
 * result does, and the first missing setting to focus, with a toast after an install.
 */
function useLanding(
  plugin: InstalledKettuPlugin | null,
  hostId: string | null,
): {
  focus: string | null
  flash: string | null
} {
  const pluginId = plugin?.id ?? null
  const landing = usePluginLanding(pluginId, hostId)
  const [from, setFrom] = useState<PluginLanding | null>(null)
  const [taken, setTaken] = useState<Taken | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  // A new way onto the page is read as the page renders with it.
  if (landing && plugin && landing !== from) {
    setFrom(landing)
    const missing = plugin.enabled ? missingSettings(plugin) : []
    const first = landing.setup ? missing[0] : undefined
    const name = pluginTitle(plugin.contents, currentLocale())
    setTaken({
      row: landing.row ?? (first ? settingRow(first.key) : null),
      flash: !!landing.row,
      focus: first?.key ?? null,
      toast: !landing.installed
        ? null
        : missing.length > 0
          ? tm('plugin.toast.installedSetup', { name, what: missingWords(missing) })
          : tm('plugin.toast.installed', { name }),
    })
  }
  useEffect(() => {
    if (!taken || pluginId === null) return
    takePluginLanding(pluginId, hostId)
    if (taken.toast) toast(taken.toast, undefined, { tone: 'success' })
    const row = taken.row
    if (!row) return
    // After the page's own scroll to the top, which a new item starts with.
    const frame = requestAnimationFrame(() => {
      document
        .querySelector(`[data-setting-row="${CSS.escape(row)}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      if (taken.flash) setFlash(row)
    })
    const timer = setTimeout(() => setFlash(null), 1600)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [taken, pluginId, hostId])
  return { focus: taken?.focus ?? null, flash }
}

/** An installed plugin's page, from the Installed tab, its listing or anywhere that opens it. */
export function PluginHome({
  id,
  back,
  backLabel,
}: {
  id: string
  tab: MarketplaceTab
  back: () => void
  backLabel?: string
}) {
  const { t } = useTranslation('marketplace')
  const { hostId, useMarketplaceStore } = useHostScope()
  const namesHosts = useNamesHosts()
  const hostName = useHostName()
  const plugins = useInstalledPlugins()
  const error = useMarketplaceStore((s) => s.pluginsError)
  const publisher = usePluginPublisher()
  const [updating, setUpdating] = useState(false)
  const plugin = plugins?.find((item) => item.id === id) ?? null
  const { focus, flash } = useLanding(plugin, hostId)
  if (!plugin) {
    return (
      <ListingFrame back={back} label={backLabel}>
        {plugins === null && !error ? <ListingSkeleton /> : <Missing back={back} />}
      </ListingFrame>
    )
  }
  const locale = currentLocale()
  const { contents } = plugin
  const title = pluginTitle(contents, locale)
  const description = pluginDescription(contents, locale)
  const state = pluginState(plugin)
  return (
    <ListingFrame back={back} label={backLabel} rise>
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
            {namesHosts && (
              <span className="k-mkt-head__trust">
                {'· '}
                {hostName(hostId)}
              </span>
            )}
          </span>
          {description && <span className="k-mkt-head__line">{description}</span>}
        </span>
        <span className="k-mkt-head__act">
          <PluginControls plugin={plugin} onRemoved={back} />
        </span>
      </header>
      <StatusLine plugin={plugin} state={state} />

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
      {plugin.skipped?.map((skill) => (
        <p key={skill.name} className="k-mkt-stale" role="status" data-selectable="">
          <span>{t('plugin.row.skippedSkill', { name: skill.name, from: skill.from })}</span>
        </p>
      ))}
      {plugin.development && (
        <p className="k-mkt-section-note k-plug-devnote">
          {t('plugin.row.devNote', {
            path: plugin.source.kind === 'local' ? homeShort(plugin.source.path) : '',
          })}
        </p>
      )}

      <div className="k-mkt-body">
        <PluginBody plugin={plugin} focus={focus} flash={flash} onRemoved={back} />
        <PluginInstalledSide plugin={plugin} publisher={publisher(plugin)} />
      </div>
    </ListingFrame>
  )
}
