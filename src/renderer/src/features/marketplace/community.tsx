// The Kettu Marketplace in the directory: what people published, at the Community trust level,
// and the account's own Only me items. Their rows, install forms and listing, which install and
// keep each item like the other sources' and offer the listing's newer version as an update; a
// workflow added from it has the library's page instead.

import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import {
  AiBrain01Icon,
  Alert02Icon,
  ArrowLeft01Icon,
  CodeIcon,
  CommandLineIcon,
  Flag02Icon,
  InformationCircleIcon,
  PlugSocketIcon,
  RefreshIcon,
  SparklesIcon,
  Tick02Icon,
  ViewIcon,
} from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import {
  KETTU_PLUGINS,
  kettuId,
  type BundleRef,
  type CommunityItem,
  type CommunityPlugin,
  type CommunityWorkflow,
} from '@shared/market-community'
import type { MarketListing, PublishAdds, PublishKind } from '@shared/market-publish'
import { displayTitle, type CatalogServer } from '@shared/marketplace'
import type { AgentId } from '@shared/thread'
import { Icon, Popover } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { toast } from '@renderer/components/ui/toast'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { backTo } from '@renderer/app/history'
import { Segmented, SettingSelect } from '@renderer/features/settings/controls'
import { basename, count, mediumAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { i18n } from '@renderer/lib/i18n'
import { isWeb } from '@renderer/lib/platform'
import { signIn, useAccountStore } from '@renderer/stores/account'
import { AGENT_NAMES } from '@renderer/stores/agents'
import { useHostScope, type HostScope } from '@renderer/stores/host-scope'
import { busyKey, communityScopeKey } from '@renderer/stores/marketplace'
import { openMarketplace, openSettings, type MarketplaceTab } from '@renderer/stores/view'
import {
  installCommunityPlugin,
  installServer,
  installSkill,
  updateCommunityPlugin,
  updateCommunityServer,
  updateCommunitySkill,
  type AgentChoice,
} from './actions'
import { ConnectButton, ConnectionControls } from './connect'
import {
  useBusy,
  useChoosableAgents,
  useHarnessAgents,
  useHostProjects,
  useInstallsLabel,
  useKept,
  useKeptSkill,
  usePluginInstalls,
} from './hooks'
import { BundleInstallButton, BundleNote, BundleUpdateButton } from './bundle-install'
import { AgentPicker } from './install'
import { InstallButton, KeptControls, Runs } from './listing'
import { asksFirst, itemKey, oauthFlow, updateFor } from './model'
import { ListingFrame, ListingSkeleton } from './parts'
import { usePublishedStore } from './published-hooks'
import { publishedItem } from './published-keys'
import { ReportDialog } from './report-dialog'
import { InstallRow } from './plugins'
import {
  AddControl,
  ItemRow,
  KettuMark,
  KindTag,
  Publisher,
  QuietNote,
  StepsCount,
  StepsLine,
  type ItemKind,
} from './rows'
import { KeptSkillControls } from './skills'
import { communitySubject } from './tile-art'
import { ItemTile } from './tiles'
import { addCommunityWorkflow, useListingWorkflow } from './workflow-actions'
import { FlowChart, FlowSkeleton, StepsOutline } from './workflow-flow'

// Bound to the namespace only: each call reads the language shown at the time.
const tm = i18n.getFixedT(null, 'marketplace')

const KIND = {
  skill: 'skill',
  workflow: 'workflow',
  plugin: 'plugin',
  'mcp-server': 'mcp',
} as const satisfies Record<PublishKind, ItemKind>

// The agents that do a workflow's steps.
const STEP_AGENTS = ['claude-code', 'codex'] as const satisfies readonly AgentId[]

export function CommunityRow({
  item,
  tab,
  fresh,
  card,
}: {
  item: CommunityItem
  tab: MarketplaceTab
  fresh?: boolean
  card?: boolean
}) {
  const installs = useInstallsLabel()(item.installs)
  const open = () => openMarketplace({ item: itemKey({ kind: 'community', id: item.id }), tab })
  const steps = item.kind === 'workflow' ? (item.steps ?? []) : []
  return (
    <ItemRow
      title={item.name}
      subject={communitySubject(item)}
      meta={
        <>
          <KindTag kind={KIND[item.kind]} harness={item.harness} />
          <Publisher name={item.handle} kettu={item.official} />
          {steps.length > 0 && <StepsCount count={steps.length} />}
          {installs && <span>{installs}</span>}
        </>
      }
      line={item.description || null}
      extra={steps.length > 0 ? <StepsLine names={steps} waits={item.waits ?? []} /> : undefined}
      fresh={fresh}
      card={card}
      onOpen={open}
      end={<CommunityAction item={item} tab={tab} onOpen={open} />}
    />
  )
}

/** The plugin installed from a listing, and every agent's install of it. */
function useCommunityPlugin(listingId: string, harness: CommunityItem['harness']) {
  const { useMarketplaceStore } = useHostScope()
  const record = useMarketplaceStore(
    (s) => s.communityInstalled?.plugins.find((p) => p.listingId === listingId) ?? null,
  )
  const installs = usePluginInstalls(
    harness ?? 'claude-code',
    record ? `${record.name}@${KETTU_PLUGINS}` : '',
  )
  return { record, installs: record ? installs : [] }
}

/**
 * A row's action: Add for a skill or a workflow, Install for a plugin or a server, the check once
 * installed.
 */
function CommunityAction({
  item,
  tab,
  onOpen,
}: {
  item: CommunityItem
  tab: MarketplaceTab
  onOpen: () => void
}) {
  if (item.kind === 'skill') return <SkillAction item={item} onOpen={onOpen} />
  if (item.kind === 'workflow') return <WorkflowAction item={item} tab={tab} onOpen={onOpen} />
  if (item.kind === 'plugin') return <PluginAction item={item} onOpen={onOpen} />
  return <ServerAction item={item} onOpen={onOpen} />
}

function SkillAction({ item, onOpen }: { item: CommunityItem; onOpen: () => void }) {
  const { t } = useTranslation('marketplace')
  const id = kettuId(item.id)
  const kept = useKeptSkill(id)
  const busy = useBusy(busyKey('skill', id))
  return (
    <AddControl
      name={item.name}
      label={t('row.add')}
      state={busy ? 'busy' : kept ? 'on' : 'off'}
      onOpen={onOpen}
      form={(close) => <SkillForm item={item} onDone={close} />}
    />
  )
}

/** Add: all agents or some; the host downloads and checks the skill's files, then Kettu keeps it. */
function SkillForm({
  item,
  onDone,
}: {
  item: Pick<CommunityItem, 'id' | 'name'>
  onDone: () => void
}) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const [agents, setAgents] = useState<AgentChoice>('all')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    onDone()
    void installSkill(scope, { kind: 'kettu', id: item.id }, agents, kettuId(item.id))
  }
  return (
    <form className="k-mkt-install" onSubmit={submit}>
      <b>{t('install.title', { name: item.name })}</b>
      <span>{t('community.skillNote')}</span>
      <div className="k-mkt-install__field">
        <small>{t('install.useIn')}</small>
        <AgentPicker value={agents} onChange={setAgents} label={t('install.useIn')} forSkills />
      </div>
      <Button size="sm" type="submit">
        {t('install.submit')}
      </Button>
    </form>
  )
}

/** Add, with no agent to choose: the workflow goes into the library, where its approval waits. */
function WorkflowAction({
  item,
  tab,
  onOpen,
}: {
  item: CommunityItem
  tab: MarketplaceTab
  onOpen: () => void
}) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const added = useListingWorkflow(item.id)
  const busy = useBusy(busyKey('community', item.id))
  return (
    <AddControl
      name={item.name}
      label={t('row.add')}
      state={busy ? 'busy' : added ? 'on' : 'off'}
      onOpen={onOpen}
      onAdd={() => void addCommunityWorkflow(scope, item, { tab })}
    />
  )
}

function PluginAction({ item, onOpen }: { item: CommunityItem; onOpen: () => void }) {
  const { t } = useTranslation('marketplace')
  const { installs } = useCommunityPlugin(item.id, item.harness)
  const busy = useBusy(busyKey('community', item.id))
  return (
    <AddControl
      name={item.name}
      label={t('row.install')}
      state={busy ? 'busy' : installs.length > 0 ? 'on' : 'off'}
      onOpen={onOpen}
      form={(close) => <PluginForm item={item} onDone={close} />}
    />
  )
}

/**
 * Install: one agent of the plugin's harness, and for Claude Code every project or one. Its hooks
 * are called out from what the listing says it adds, which is read before Install can be pressed.
 */
function PluginForm({
  item,
  onDone,
}: {
  item: Pick<CommunityItem, 'id' | 'name' | 'harness'>
  onDone: () => void
}) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const harness = item.harness ?? 'claude-code'
  const agents = useHarnessAgents(harness)
  const { installs } = useCommunityPlugin(item.id, harness)
  const projects = useHostProjects()
  const free = agents.filter((a) => !installs.some((p) => p.agentId === a.id))
  const [agentId, setAgentId] = useState<AgentId | null>(free[0]?.id ?? agents[0]?.id ?? null)
  const [pluginScope, setPluginScope] = useState<'user' | 'project'>('user')
  const [project, setProject] = useState<string>(projects[0]?.path ?? '')
  const page = useCommunityListing(item.id)
  const listed = page.listing?.state === 'listed' ? page.listing.listing : null
  const checked = listed !== null || page.error !== null || page.listing !== null
  const ready = agentId !== null && checked && (pluginScope === 'user' || project !== '')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!ready) return
    onDone()
    void installCommunityPlugin(
      scope,
      { id: item.id, name: item.name, harness },
      agentId,
      pluginScope,
      pluginScope === 'project' ? project : null,
    )
  }
  return (
    <form className="k-mkt-install" onSubmit={submit}>
      <b>{t('install.title', { name: item.name })}</b>
      <span>{t('community.pluginNote', { harness: AGENT_NAMES[harness] })}</span>
      <div className="k-mkt-install__field">
        <small>{t('plugin.agent')}</small>
        {agents.length === 0 ? (
          <p className="k-mkt-install__empty">
            {t('plugin.noAgents', { harness: AGENT_NAMES[harness] })}
          </p>
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
      {harness === 'claude-code' && (
        <div className="k-mkt-install__field">
          <small>{t('plugin.scope')}</small>
          <Segmented
            label={t('plugin.scope')}
            value={pluginScope}
            options={[
              { value: 'user', label: t('plugin.scopeUser') },
              { value: 'project', label: t('plugin.scopeProject'), disabled: !projects.length },
            ]}
            onChange={setPluginScope}
          />
          {pluginScope === 'project' && (
            <SettingSelect
              label={t('plugin.project')}
              value={project}
              options={projects.map((p) => ({ value: p.path, label: p.name || basename(p.path) }))}
              onChange={setProject}
            />
          )}
        </div>
      )}
      {!checked ? (
        <Skeleton className="k-mkt-skeleton__line" />
      ) : listed ? (
        hasHooks(listed.adds) && <HooksWarning />
      ) : (
        <em className="k-mkt-warn">
          <Icon icon={Alert02Icon} size={13} />
          {t('plugin.hooksUnchecked', { error: page.error ?? t('community.gone') })}
        </em>
      )}
      <Button size="sm" type="submit" disabled={!ready}>
        {t('install.submit')}
      </Button>
    </form>
  )
}

function hasHooks(adds: PublishAdds[] | undefined): boolean {
  return (adds ?? []).some((group) => group.label === 'hooks' && group.items.length > 0)
}

function HooksWarning() {
  const { t } = useTranslation('marketplace')
  return (
    <em className="k-mkt-warn">
      <Icon icon={Alert02Icon} size={13} />
      {t('plugin.hooksWarning')}
    </em>
  )
}

/**
 * A server's action: Install at once for one that asks for nothing; one that signs in or asks for
 * keys opens its listing, where Connect and the keys' form are.
 */
function ServerAction({ item, onOpen }: { item: CommunityItem; onOpen: () => void }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const id = kettuId(item.id)
  const kept = useKept(id)
  const busy = useBusy(busyKey('mcp', id))
  const [reading, setReading] = useState(false)
  const install = async () => {
    setReading(true)
    const server = await serverOf(scope, item.id)
    setReading(false)
    if (!server) return onOpen()
    if (oauthFlow(server.spec) || asksFirst(server.spec)) return onOpen()
    void installServer(scope, server, 'all', {})
  }
  return (
    <AddControl
      name={item.name}
      label={t('row.install')}
      state={busy || reading ? 'busy' : kept ? 'on' : 'off'}
      onOpen={onOpen}
      onAdd={() => void install()}
    />
  )
}

/** A server listing's spec as Kettu would install it, read from its page; null when it has none. */
async function serverOf(scope: HostScope, id: string): Promise<CatalogServer | null> {
  const store = scope.useMarketplaceStore
  await store.getState().loadCommunityListing(id)
  const state = store.getState().communityListings[id]
  if (state?.listing?.state === 'listed') return state.listing.server
  if (state?.error) {
    toast(tm('toast.listingFailed', { error: state.error }), undefined, { tone: 'warning' })
  }
  return null
}

/** A listing's page as the host gave it; `fresh` reads it again even when one was read before. */
function useCommunityListing(id: string, fresh = false) {
  const { useMarketplaceStore } = useHostScope()
  const state = useMarketplaceStore((s) => s.communityListings[id] ?? null)
  useEffect(() => {
    void useMarketplaceStore.getState().loadCommunityListing(id, fresh)
  }, [id, fresh, useMarketplaceStore])
  return state ?? { listing: null, error: null }
}

/**
 * The Community section's line while the host is signed out, or signed in with Kettu's services
 * off, with what gets it there on this computer.
 */
export function CommunitySignedOut() {
  const { t } = useTranslation('marketplace')
  const { hostId } = useHostScope()
  const signedIn = useAccountStore((s) => s.status?.state === 'signed-in')
  const here = hostId === null && !isWeb
  return (
    <QuietNote
      action={
        here ? (
          signedIn ? (
            <Button size="md" variant="ghost" onClick={() => openSettings('account')}>
              {t('community.openAccount')}
            </Button>
          ) : (
            <Button size="md" variant="ghost" onClick={() => void signIn()}>
              {t('community.signIn')}
            </Button>
          )
        ) : undefined
      }
    >
      {here && signedIn ? t('community.servicesOff') : t('community.signedOut')}
    </QuietNote>
  )
}

/** A listing of the Kettu Marketplace: what it is, who published it, and Install or its controls. */
export function CommunityListingPage({
  id,
  tab,
  back,
}: {
  id: string
  tab: MarketplaceTab
  back: () => void
}) {
  const { t } = useTranslation('marketplace')
  const { useMarketplaceStore } = useHostScope()
  // A page opened shows the listing as it is now, since a new version may have come since.
  const page = useCommunityListing(id, true)
  const signedOut = useMarketplaceStore(
    (s) => s.communityPages[communityScopeKey({})]?.signedIn === false,
  )
  if (!page.listing) {
    return (
      <ListingFrame back={back}>
        {page.error ? (
          <ListingProblem
            title={t('community.readFailed')}
            text={page.error}
            retry={() => void useMarketplaceStore.getState().loadCommunityListing(id, true)}
          />
        ) : signedOut ? (
          <CommunitySignedOut />
        ) : (
          <ListingSkeleton />
        )}
      </ListingFrame>
    )
  }
  if (page.listing.state !== 'listed') {
    return (
      <ListingFrame back={back}>
        <Unlisted id={id} takenDown={page.listing.state === 'taken-down'} back={back} />
      </ListingFrame>
    )
  }
  return (
    <ListingFrame back={back} rise>
      <Listed
        listing={page.listing.listing}
        server={page.listing.server}
        bundle={page.listing.bundle}
        tab={tab}
        back={back}
      />
    </ListingFrame>
  )
}

/**
 * One of the account's own listings as other people see it, read from the service like any
 * listing and shown as what the owner's own record says others get.
 */
export function CommunityPreviewPage({ id, tab }: { id: string; tab: MarketplaceTab }) {
  const { t } = useTranslation('marketplace')
  const { useMarketplaceStore } = useHostScope()
  const store = usePublishedStore()
  const published = store((s) => s.published)
  useEffect(() => {
    if (!store.getState().published) void store.getState().load()
  }, [store])
  const mine = published?.mine?.listings.find((l) => l.id === id) ?? null
  const page = useCommunityListing(id, true)
  const own = () =>
    backTo({ kind: 'marketplace', item: publishedItem(id), tab: 'published' }, () =>
      openMarketplace({ item: publishedItem(id), tab: 'published' }),
    )
  const frame = (line: string | null, children: ReactNode) => (
    <ListingFrame back={own} banner={<PreviewBar line={line} back={own} />} rise>
      {children}
    </ListingFrame>
  )
  if (!mine) {
    return frame(
      null,
      published ? <Gone title={t('published.listing.missingTitle')} /> : <ListingSkeleton />,
    )
  }
  if (mine.takenDown) {
    return frame(
      t('community.preview.takenDown'),
      <Gone title={t('community.takenDownTitle')} text={t('community.takenDown')} />,
    )
  }
  if (mine.visibility === 'private') {
    return frame(
      null,
      <Gone title={t('community.preview.private')} text={t('community.preview.privateText')} />,
    )
  }
  const line = t(
    mine.visibility === 'unlisted' ? 'community.preview.unlisted' : 'community.preview.public',
  )
  if (page.listing?.state !== 'listed') {
    return frame(
      line,
      page.error ? (
        <ListingProblem
          title={t('community.readFailed')}
          text={page.error}
          retry={() => void useMarketplaceStore.getState().loadCommunityListing(id, true)}
        />
      ) : (
        <ListingSkeleton />
      ),
    )
  }
  return frame(
    line,
    <Listed
      listing={page.listing.listing}
      server={page.listing.server}
      bundle={page.listing.bundle}
      tab={tab}
      back={own}
      preview
    />,
  )
}

/** The bar over a preview: whose view it is, why, and the way back to the owner's page. */
function PreviewBar({ line, back }: { line: string | null; back: () => void }) {
  const { t } = useTranslation('marketplace')
  return (
    <div className="k-mkt-preview" role="status">
      <Icon icon={ViewIcon} size={16} />
      <span className="k-mkt-preview__text">
        <b>{t('community.preview.title')}</b>
        {line && <small>{line}</small>}
      </span>
      <Button
        size="sm"
        variant="secondary"
        icon={<Icon icon={ArrowLeft01Icon} size={14} />}
        onClick={back}
      >
        {t('community.preview.back')}
      </Button>
    </div>
  )
}

function Gone({ title, text }: { title: string; text?: string }) {
  return (
    <div className="ui-as-empty">
      <b className="ui-as-empty__title">{title}</b>
      {text && <p className="ui-as-empty__text">{text}</p>}
    </div>
  )
}

/** Install as others would see it, drawn but off, since the owner previews and installs elsewhere. */
function PreviewInstall({ listing }: { listing: MarketListing }) {
  const { t } = useTranslation('marketplace')
  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} />}>
        <Button disabled>
          {listing.kind === 'skill' || listing.kind === 'workflow'
            ? t('row.add')
            : t('row.install')}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t('community.preview.installOff')}</TooltipContent>
    </Tooltip>
  )
}

function ListingProblem({
  title,
  text,
  retry,
}: {
  title: string
  text: string
  retry?: () => void
}) {
  const { t } = useTranslation('common')
  return (
    <div className="ui-as-empty">
      <b className="ui-as-empty__title">{title}</b>
      <p className="ui-as-empty__text">{text}</p>
      {retry && (
        <Button
          size="md"
          variant="secondary"
          icon={<Icon icon={RefreshIcon} size={14} />}
          onClick={retry}
        >
          {t('actions.retry')}
        </Button>
      )}
    </div>
  )
}

/** A listing taken down or gone: what is installed of it stays, with its controls. */
function Unlisted({ id, takenDown, back }: { id: string; takenDown: boolean; back: () => void }) {
  const { t } = useTranslation('marketplace')
  const { useSettingsStore } = useHostScope()
  const key = kettuId(id)
  const skill = useSettingsStore((s) => s.settings.marketplace.skills.find((x) => x.id === key))
  const server = useSettingsStore((s) => s.settings.marketplace.mcp.find((x) => x.id === key))
  const plugin = useHostScope().useMarketplaceStore(
    (s) => s.communityInstalled?.plugins.find((p) => p.listingId === id) ?? null,
  )
  const name = skill ? displayTitle(skill.name) : (server?.title ?? plugin?.name ?? null)
  return (
    <>
      <ListingProblem
        title={takenDown ? t('community.takenDownTitle') : t('community.goneTitle')}
        text={
          name
            ? t(takenDown ? 'community.takenDownKept' : 'community.goneKept', { name })
            : takenDown
              ? t('community.takenDown')
              : t('community.gone')
        }
      />
      {(skill || server) && (
        <div className="k-mkt-head__act k-mkt-unlisted">
          {skill && <KeptSkillControls skill={skill} onRemoved={back} />}
          {server &&
            (oauthFlow(server.spec) ? (
              <ConnectionControls server={server} onRemoved={back} />
            ) : (
              <KeptControls server={server} onUninstalled={back} />
            ))}
        </div>
      )}
      {plugin && <PluginInstalls record={plugin} title={plugin.name} />}
    </>
  )
}

function Listed({
  listing,
  server,
  bundle,
  tab,
  back,
  preview = false,
}: {
  listing: MarketListing
  server: CatalogServer | null
  bundle: BundleRef | null
  tab: MarketplaceTab
  back: () => void
  /** As others see it: no sign of the owner, nothing installed here, Install and Report off. */
  preview?: boolean
}) {
  const { t } = useTranslation('marketplace')
  const [reporting, setReporting] = useState(false)
  const installedHere = useInstalledHere(listing)
  const installed = preview ? false : installedHere
  return (
    <>
      <header className="k-mkt-head">
        <ItemTile subject={communitySubject(listing)} size="big" />
        <span className="k-mkt-head__title">
          <span className="k-mkt-head__name">
            <h1>{listing.name}</h1>
            <KindTag kind={KIND[listing.kind]} harness={listing.harness} />
          </span>
          <span className="k-mkt-head__pub">
            {listing.mine && !preview
              ? t('community.byYou', { handle: listing.handle })
              : listing.handle}
            {listing.official && <KettuMark />}
            <span className="k-mkt-head__trust">
              {listing.official ? t('listing.official') : t('community.trust')}
            </span>
          </span>
          {listing.description && <span className="k-mkt-head__line">{listing.description}</span>}
        </span>
        <span className="k-mkt-head__act">
          {preview ? (
            <PreviewInstall listing={listing} />
          ) : (
            <Actions listing={listing} server={server} bundle={bundle} tab={tab} back={back} />
          )}
        </span>
      </header>

      <Facts listing={listing} />

      <div className="k-mkt-body">
        <div className="k-mkt-body__main">
          {listing.about && <p className="k-mkt-about k-mkt-about--text">{listing.about}</p>}
          {listing.kind === 'plugin' && !preview && <PluginInstallsOf listing={listing} />}
          {listing.kind === 'workflow' ? (
            <WorkflowFlow listing={listing} />
          ) : (
            <Adds adds={listing.adds} kind={listing.kind} installed={installed} />
          )}
          {listing.kind === 'mcp-server' &&
            (server ? (
              <ServerRuns listing={listing} server={server} />
            ) : bundle ? (
              <BundleRuns listing={listing} bundle={bundle} />
            ) : (
              <p className="k-mkt-section-note">{t('community.cannotRun')}</p>
            ))}
        </div>
        <aside className="k-mkt-side">
          <dl>
            <dt>{t('listing.side.publisher')}</dt>
            <dd>
              {listing.handle}
              {listing.official && <KettuMark />}
            </dd>
            <dt>{t('community.side.trust')}</dt>
            <dd>{listing.official ? t('listing.official') : t('community.trust')}</dd>
            <dt>{t('plugin.facts.installs')}</dt>
            <dd>
              {listing.visibility === 'private' ? t('community.onlyMe') : count(listing.installs)}
            </dd>
            <dt>{t('community.side.kind')}</dt>
            <dd>
              {listing.harness
                ? t('community.pluginFor', { harness: AGENT_NAMES[listing.harness] })
                : t(`community.kinds.${KIND[listing.kind]}`)}
            </dd>
            <dt>{t('community.side.name')}</dt>
            <dd className="k-mkt-mono" data-selectable="">
              @{listing.handle}/{listing.slug}
            </dd>
            <dt>{t('listing.side.listedIn')}</dt>
            <dd>{t('community.source')}</dd>
          </dl>
          {/* No one reports their own listing; the preview draws it where others see it, off. */}
          {(preview || !listing.mine) && (
            <button
              type="button"
              className="k-mkt-report"
              disabled={preview}
              onClick={() => setReporting(true)}
            >
              <Icon icon={Flag02Icon} size={13} />
              {t('community.report')}
            </button>
          )}
        </aside>
      </div>
      {!preview && <ReportDialog listing={listing} open={reporting} onOpenChange={setReporting} />}
      <Related listing={listing} tab={tab} />
    </>
  )
}

/**
 * Whether this host has the listing: its skill or server kept, its plugin in an agent, or its
 * workflow in the library.
 */
function useInstalledHere(listing: MarketListing): boolean {
  const { useSettingsStore } = useHostScope()
  const id = kettuId(listing.id)
  const kept = useSettingsStore(
    (s) =>
      s.settings.marketplace.skills.some((x) => x.id === id) ||
      s.settings.marketplace.mcp.some((x) => x.id === id),
  )
  const { installs } = useCommunityPlugin(listing.id, listing.harness)
  const workflow = useListingWorkflow(listing.id)
  return kept || installs.length > 0 || workflow !== null
}

/** Others of the same publisher, else of the same kind, from the directory. */
function Related({ listing, tab }: { listing: MarketListing; tab: MarketplaceTab }) {
  const { t } = useTranslation('marketplace')
  const { useMarketplaceStore } = useHostScope()
  const items = useMarketplaceStore(
    useShallow((s) => s.communityPages[communityScopeKey({})]?.items ?? []),
  )
  const others = items.filter((item) => item.id !== listing.id)
  const same = others.filter((item) => item.handle === listing.handle)
  const shown = (
    same.length > 0 ? same : others.filter((item) => item.kind === listing.kind)
  ).slice(0, 4)
  if (shown.length === 0) return null
  return (
    <section className="ui-as-int-section">
      <h2 className="ui-as-int-section__title">
        {same.length > 0
          ? t('listing.relatedFrom', { publisher: listing.handle })
          : t('listing.related')}
      </h2>
      <div className="ui-as-int-grid">
        {shown.map((item) => (
          <CommunityRow key={item.id} item={item} tab={tab} />
        ))}
      </div>
    </section>
  )
}

/** Works with, where it comes from, its version and when it changed. */
function Facts({ listing }: { listing: MarketListing }) {
  const { t } = useTranslation('marketplace')
  const agents = useChoosableAgents()
  const updated = Date.parse(listing.updatedAt)
  const steps = listing.kind === 'workflow'
  const marks: AgentId[] = listing.harness
    ? [listing.harness]
    : steps
      ? [...STEP_AGENTS]
      : agents.slice(0, 6).map((agent) => agent.id)
  return (
    <div className="k-mkt-facts">
      <span>
        <small>{steps ? t('workflow.facts.runBy') : t('listing.facts.worksWith')}</small>
        <b className="k-mkt-facts__agents">
          {marks.map((agent) => (
            <AgentMark
              key={agent}
              agent={agent}
              size={15}
              dot={listing.harness || steps ? null : undefined}
            />
          ))}
          <span className="k-mkt-facts__text">
            {listing.harness
              ? AGENT_NAMES[listing.harness]
              : steps
                ? t('more.two', { first: AGENT_NAMES['claude-code'], second: AGENT_NAMES.codex })
                : t('listing.everyAgent')}
          </span>
        </b>
      </span>
      <span>
        <small>{t('listing.facts.source')}</small>
        <b>{t('community.source')}</b>
      </span>
      <span>
        <small>{t('listing.facts.version')}</small>
        <b className="k-mkt-mono">{listing.version}</b>
      </span>
      {!Number.isNaN(updated) && (
        <span>
          <small>{t('listing.facts.updated')}</small>
          <b>{mediumAgo(updated)}</b>
        </span>
      )}
    </div>
  )
}

const ADDS: Record<string, IconSvgElement> = {
  skills: SparklesIcon,
  commands: CommandLineIcon,
  agents: AiBrain01Icon,
  hooks: CodeIcon,
  servers: PlugSocketIcon,
}

/** What an install adds, as the publisher's check listed it; hooks with their warning. */
function Adds({
  adds,
  kind,
  installed,
}: {
  adds: PublishAdds[] | undefined
  kind: PublishKind
  installed: boolean
}) {
  const { t } = useTranslation('marketplace')
  const groups = (adds ?? []).filter((group) => group.items.length > 0 && group.label in ADDS)
  // A server adds itself, which its Runs and needs says.
  if (groups.length === 0 || kind === 'mcp-server') return null
  return (
    <section>
      <h3>{installed ? t('plugin.adds') : t('plugin.willAdd')}</h3>
      <div className="k-mkt-list">
        {groups.map((group) => (
          <div key={group.label} className="k-mkt-item">
            <Icon icon={ADDS[group.label]!} size={15} />
            <span>
              <b>{t(`community.adds.${group.label as 'skills'}`)}</b>
              <small className="k-mkt-mono">{group.items.join(', ')}</small>
              {group.label === 'hooks' && (
                <em className="k-mkt-warn">
                  <Icon icon={Alert02Icon} size={12} />
                  {t('plugin.hooksWarning')}
                </em>
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

/** A workflow listing's flow as the host read it from its current version, or why it has none. */
function useListingFlow(listing: MarketListing) {
  const scope = useHostScope()
  const [read, setRead] = useState<{
    key: string
    flow: CommunityWorkflow | null
    error: string | null
  } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const { id, version } = listing
  const key = `${id}|${version}|${attempt}`
  useEffect(() => {
    let live = true
    scope
      .request('market.communityWorkflow', { id })
      .then((flow) => live && setRead({ key, flow, error: null }))
      .catch(
        (failure: unknown) => live && setRead({ key, flow: null, error: errorMessage(failure) }),
      )
    return () => {
      live = false
    }
  }, [scope, id, key])
  // An answer to an earlier listing, version or try is not this one's.
  const current = read?.key === key ? read : null
  return {
    flow: current?.flow ?? null,
    error: current?.error ?? null,
    retry: () => setAttempt((n) => n + 1),
  }
}

/**
 * What a workflow listing does, before it is added: its flow drawn from the version's own file,
 * with each step in words under it. When the file cannot be read here, the step names its
 * publisher's check listed, in order, and a line that says what they leave out.
 */
function WorkflowFlow({ listing }: { listing: MarketListing }) {
  const { t } = useTranslation(['marketplace', 'common'])
  const { flow, error, retry } = useListingFlow(listing)
  const of = (label: string) => listing.adds?.find((group) => group.label === label)?.items ?? []
  const tools = [...of('servers'), ...of('skills')]
  const workflow = flow?.workflow ?? null
  const waiting = flow === null && error === null
  return (
    <>
      <section>
        <h3 className="k-workflow-h3">
          {t('workflow.flow.title')}
          {workflow && (
            <small className="k-workflow-h3__note">{t('workflow.preview.readOnly')}</small>
          )}
        </h3>
        {waiting ? (
          <div className="k-flow-card" aria-busy>
            <FlowSkeleton />
          </div>
        ) : workflow ? (
          <FlowChart workflow={workflow} />
        ) : (
          <ListedSteps
            steps={of('steps')}
            waits={of('waits')}
            reason={error ?? flow?.problem ?? ''}
            retry={error ? retry : undefined}
          />
        )}
      </section>
      {workflow && (
        <section>
          <h3>{t('workflow.steps.title')}</h3>
          <StepsOutline workflow={workflow} />
        </section>
      )}
      {tools.length > 0 && (
        <section>
          <h3>{t('workflow.needs.tools')}</h3>
          <div className="k-mkt-list">
            <div className="k-mkt-item">
              <Icon icon={PlugSocketIcon} size={15} />
              <span>
                <b className="k-mkt-mono">{tools.join(', ')}</b>
                <small>{t('community.workflowTools')}</small>
              </span>
            </div>
          </div>
        </section>
      )}
    </>
  )
}

/**
 * The fallback for a flow that cannot be drawn: the step names in the order the listing gives
 * them, those that wait for the user marked, and nothing the listing does not say.
 */
function ListedSteps({
  steps,
  waits,
  reason,
  retry,
}: {
  steps: string[]
  waits: string[]
  reason: string
  retry?: () => void
}) {
  const { t } = useTranslation(['marketplace', 'common'])
  return (
    <div className="k-flow-fallback">
      <p className="k-flow-fallback__note" role="status">
        <Icon icon={InformationCircleIcon} size={14} />
        <span>
          {steps.length > 0 ? t('workflow.preview.listed') : t('workflow.preview.none')}{' '}
          {reason && <span data-selectable="">{t('workflow.preview.reason', { reason })}</span>}
        </span>
        {retry && (
          <Button
            size="md"
            variant="ghost"
            icon={<Icon icon={RefreshIcon} size={14} />}
            onClick={retry}
          >
            {t('common:actions.retry')}
          </Button>
        )}
      </p>
      {steps.length > 0 && (
        <ol className="k-mkt-list k-flow-steps">
          {steps.map((name, index) => (
            <li key={index} className="k-flow-steps__step">
              <span className="k-flow-steps__n" aria-hidden>
                {index + 1}
              </span>
              <span className="k-flow-steps__text">
                <span className="k-flow-steps__name">
                  <b>{name}</b>
                  {waits.includes(name) && (
                    <span className="k-workflow-you">{t('workflow.row.waitsHere')}</span>
                  )}
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

/** A bundle's page: what it runs once installed, before that how it installs. */
function BundleRuns({ listing, bundle }: { listing: MarketListing; bundle: BundleRef }) {
  const { useSettingsStore } = useHostScope()
  const kept = useSettingsStore((s) =>
    s.settings.marketplace.mcp.find((x) => x.id === kettuId(listing.id)),
  )
  return kept ? (
    <Runs spec={kept.spec} serverId={kept.id} service={listing.name} />
  ) : (
    <BundleNote bundle={bundle} />
  )
}

function ServerRuns({ listing, server }: { listing: MarketListing; server: CatalogServer }) {
  const { useSettingsStore } = useHostScope()
  const kept = useSettingsStore((s) =>
    s.settings.marketplace.mcp.find((x) => x.id === kettuId(listing.id)),
  )
  return (
    <Runs spec={kept?.spec ?? server.spec} serverId={kept?.id ?? null} service={listing.name} />
  )
}

/** Install, or the item's controls once installed, with Update when the listing has a newer version. */
function Actions({
  listing,
  server,
  bundle,
  tab,
  back,
}: {
  listing: MarketListing
  server: CatalogServer | null
  bundle: BundleRef | null
  tab: MarketplaceTab
  back: () => void
}) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const { useSettingsStore } = scope
  const id = kettuId(listing.id)
  const skill = useSettingsStore((s) => s.settings.marketplace.skills.find((x) => x.id === id))
  const kept = useSettingsStore((s) => s.settings.marketplace.mcp.find((x) => x.id === id))
  const { record, installs } = useCommunityPlugin(listing.id, listing.harness)
  const busy = useBusy(busyKey('community', listing.id))
  const skillBusy = useBusy(busyKey('skill', id))
  const [open, setOpen] = useState(false)
  const standing = {
    state: 'listed' as const,
    current: listing.version,
    versions: listing.versions,
  }

  if (listing.kind === 'skill') {
    const update = skill ? updateFor(standing, skill.version) : null
    return skill ? (
      <>
        {update && (
          <UpdateButton
            version={update}
            busy={busy}
            onClick={() => void updateCommunitySkill(scope, skill)}
          />
        )}
        <KeptSkillControls skill={skill} onRemoved={back} compact={!!update} />
      </>
    ) : (
      <span className="ui-as-anchor">
        <Button
          loading={skillBusy}
          aria-expanded={open}
          onClick={() => !skillBusy && setOpen((o) => !o)}
        >
          {skillBusy ? t('install.installing') : t('row.add')}
        </Button>
        <Popover
          open={open}
          onClose={() => setOpen(false)}
          align="end"
          className="ui-as-menu k-mkt-install-pop"
        >
          <SkillForm item={listing} onDone={() => setOpen(false)} />
        </Popover>
      </span>
    )
  }

  if (listing.kind === 'workflow') {
    // Once added, the workflow's own page shows in place of this one.
    return (
      <Button
        loading={busy}
        onClick={() => !busy && void addCommunityWorkflow(scope, listing, { tab, stay: true })}
      >
        {busy ? t('install.installing') : t('row.add')}
      </Button>
    )
  }

  if (listing.kind === 'plugin') {
    const update = record ? updateFor(standing, record.version) : null
    return (
      <>
        {installs.length > 0 && !update && (
          <span className="k-mkt-head__on">
            <Icon icon={Tick02Icon} size={14} />
            {t('listing.installed')}
          </span>
        )}
        {update && installs.length > 0 && (
          <UpdateButton
            version={update}
            busy={busy}
            onClick={() =>
              void updateCommunityPlugin(
                scope,
                { id: listing.id, name: listing.name, harness: listing.harness ?? 'claude-code' },
                installs,
              )
            }
          />
        )}
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
            <PluginForm item={listing} onDone={() => setOpen(false)} />
          </Popover>
        </span>
      </>
    )
  }

  if (!server && bundle) {
    if (!kept) return <BundleInstallButton listing={listing} />
    const update = updateFor(standing, kept.version)
    return (
      <>
        {update && <BundleUpdateButton kept={kept} version={update} />}
        <KeptControls server={kept} onUninstalled={back} />
      </>
    )
  }
  if (!server) return null
  if (!kept)
    return oauthFlow(server.spec) ? (
      <ConnectButton server={server} big />
    ) : (
      <InstallButton server={server} />
    )
  const update = updateFor(standing, kept.version)
  return (
    <>
      {update && (
        <UpdateButton
          version={update}
          busy={false}
          onClick={() => void updateCommunityServer(scope, kept, server)}
        />
      )}
      {oauthFlow(kept.spec) ? (
        <ConnectionControls server={kept} onRemoved={back} />
      ) : (
        <KeptControls server={kept} onUninstalled={back} />
      )}
    </>
  )
}

function UpdateButton({
  version,
  busy,
  onClick,
}: {
  version: string
  busy: boolean
  onClick: () => void
}) {
  const { t } = useTranslation('marketplace')
  return (
    <Button loading={busy} onClick={() => !busy && onClick()}>
      {busy ? t('community.updating') : t('community.update', { version })}
    </Button>
  )
}

function PluginInstallsOf({ listing }: { listing: MarketListing }) {
  const { record } = useCommunityPlugin(listing.id, listing.harness)
  return record ? <PluginInstalls record={record} title={listing.name} /> : null
}

/** Each agent that has the plugin: where, its switch and Uninstall. */
function PluginInstalls({ record, title }: { record: CommunityPlugin; title: string }) {
  const { t } = useTranslation('marketplace')
  const installs = usePluginInstalls(record.harness, `${record.name}@${KETTU_PLUGINS}`)
  if (installs.length === 0) return null
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
