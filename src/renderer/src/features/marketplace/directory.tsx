// The Marketplace's directory: its tabs, search and Add over sections of skills, MCP servers and
// workflows. Each source fills its sections as it answers; the rest show at once.

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import {
  Add01Icon,
  File02Icon,
  Flowchart01Icon,
  Folder01Icon,
  GithubIcon,
  PlugSocketIcon,
  RefreshIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type {
  CatalogServer,
  CatalogSkill,
  MarketCatalog,
  MarketSkills,
  SkillRepository,
  SkillTrust,
} from '@shared/marketplace'
import { displayTitle } from '@shared/marketplace'
import type { WireWorkflowEntry } from '@shared/workflow'
import type { CommunityItem } from '@shared/market-community'
import type { PublishKind } from '@shared/market-publish'
import {
  Dropdown,
  EmptyState,
  Icon,
  SearchField,
  Tabs,
} from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { mediumAgo } from '@renderer/lib/format'
import { currentLocale } from '@renderer/lib/i18n'
import { isMac, isWeb } from '@renderer/lib/platform'
import { readJson, writeJson } from '@renderer/lib/storage'
import { useHostScope } from '@renderer/stores/host-scope'
import { useAccountStore } from '@renderer/stores/account'
import {
  SEARCH_MAX,
  SEARCH_MIN,
  communityScopeKey,
  type CommunityPages,
  type CommunityScope,
  type MarketSearchState,
} from '@renderer/stores/marketplace'
import { openMarketplace, setMarketplaceTab, type MarketplaceTab } from '@renderer/stores/view'
import { useHostName, useNamesHosts, useWindowHost } from '@renderer/stores/window-host'
import { installSkill } from './actions'
import { CommunityRow, CommunitySignedOut } from './community'
import { AddServerDialog, AddSkillDialog } from './dialogs'
import { usePluginInstall } from './plugin-hooks'
import { AddPluginGithubDialog } from './plugin-install'
import { MarketAway } from './parts'
import { InstalledView } from './installed'
import { PublishedView, PublishMenu } from './published'
import { usePublishedStore, useShowsPublished } from './published-hooks'
import {
  catalogServers,
  fromCatalog,
  itemKey,
  matchesQuery,
  skillFromAnthropic,
  skillMatches,
} from './model'
import {
  AddButton,
  ItemRow,
  KindTag,
  MoreButton,
  Publisher,
  QuietNote,
  SkeletonRow,
  SkeletonSection,
} from './rows'
import { SkillRow } from './skills'
import { workflowGroup, workflowMatches, workflowName } from './workflow-model'
import { addWorkflowFromFile, retryWorkflows, useWorkflows } from './workflow-actions'
import { AddWorkflowDialog, WorkflowRow, WorkflowSections } from './workflows'
import {
  communitySubject,
  serverSubject,
  skillSubject,
  workflowSubject,
  type TileSubject,
} from './tile-art'

const TABS: readonly MarketplaceTab[] = ['all', 'plugins', 'skills', 'mcp', 'workflow', 'installed']
/** With Published last, while the host's Kettu account is signed in with Kettu's services on. */
const SIGNED_IN_TABS: readonly MarketplaceTab[] = [...TABS, 'published']

/** Rows a section shows before it folds the rest into "… and N more", and how many more a click shows. */
const SECTION_ROWS = 6
const MORE_STEP = 60

/** How long the search field rests before the lists are filtered and the registry asked. */
const SEARCH_DELAY_MS = 300

/** How many of Kettu's own plugins the Plugins tab's Featured section shows as cards. */
const FEATURED_PLUGINS = 3

/** How many official skills the All tab's Featured section mixes in. */
const FEATURED_SKILLS = 3
/** The official skills most people reach for, in the order Featured shows them. */
const FEATURED_SKILL_NAMES = ['pdf', 'docx', 'xlsx', 'pptx', 'skill-creator', 'webapp-testing']
const featuredRank = (name: string): number => {
  const rank = FEATURED_SKILL_NAMES.indexOf(name)
  return rank < 0 ? FEATURED_SKILL_NAMES.length : rank
}

type Entry =
  | { kind: 'mcp'; key: string; title: string; subject: TileSubject; server: CatalogServer }
  | { kind: 'skill'; key: string; title: string; subject: TileSubject; skill: CatalogSkill }
  | {
      kind: 'workflow'
      key: string
      title: string
      subject: TileSubject
      workflow: WireWorkflowEntry
    }
  | { kind: 'community'; key: string; title: string; subject: TileSubject; item: CommunityItem }

interface Section {
  id: string
  /** Null while it is not known yet: a title's room. */
  title: string | null
  entries: Entry[]
  /** Skeleton rows after the entries, for a source still on its way. */
  pending: number
  /** A line in place of the rows, such as what signing in would show; under the rows it has. */
  note?: ReactNode
  /** The service's further pages, for a section read a page at a time. */
  more?: SectionMore
  /** Drawn as cards, which have room for what a row cuts short. */
  cards?: boolean
  /** After the title, such as how far a publisher is trusted. */
  caption?: string
}

interface SectionMore {
  next: boolean
  loading: boolean
  error: string | null
  load(): void
}

const mcpEntry = (server: CatalogServer): Entry => ({
  kind: 'mcp',
  key: itemKey({ kind: 'mcp', id: server.id }),
  title: server.title,
  subject: serverSubject(server),
  server,
})
const skillEntry = (skill: CatalogSkill): Entry => ({
  kind: 'skill',
  key: itemKey({ kind: 'skill', id: skill.id }),
  title: displayTitle(skill.name),
  subject: skillSubject(skill.name),
  skill,
})

const workflowEntry = (workflow: WireWorkflowEntry): Entry => ({
  kind: 'workflow',
  key: itemKey({ kind: 'workflow', id: workflow.id }),
  title: workflowName(workflow, currentLocale()),
  subject: workflowSubject(workflow),
  workflow,
})

const communityEntry = (item: CommunityItem): Entry => ({
  kind: 'community',
  key: itemKey({ kind: 'community', id: item.id }),
  title: item.name,
  subject: communitySubject(item),
  item,
})

/** The lists taken in turn, one item from each, so a section mixes its kinds. */
function interleave<T>(...lists: T[][]): T[] {
  const out: T[] = []
  for (let i = 0; lists.some((list) => i < list.length); i++) {
    for (const list of lists) if (i < list.length) out.push(list[i]!)
  }
  return out
}

interface Sources {
  catalog: MarketCatalog | null
  catalogPending: boolean
  skills: MarketSkills | null
  skillsPending: boolean
  workflows: WireWorkflowEntry[]
  workflowsPending: boolean
  search: MarketSearchState | null
  communityPages: Record<string, CommunityPages>
  loadMoreCommunity(scope: CommunityScope): void
  retrySkillRepository(id: string): Promise<void>
}

/** The Community kind a tab lists; null for all of them. */
const tabKind = (tab: MarketplaceTab): PublishKind | null =>
  tab === 'plugins'
    ? 'agent-plugin'
    : tab === 'skills'
      ? 'skill'
      : tab === 'mcp'
        ? 'mcp-server'
        : tab === 'workflow'
          ? 'workflow'
          : null

/**
 * The Plugins tab without a query: Kettu's own plugins as cards under Featured, the account's own
 * Only me items, then the Community's by installs. A service that lists no plugins yet shows no
 * section, and the tab its empty state.
 */
function pluginSections(src: Sources, t: TFunction<'marketplace'>): Section[] {
  const scope = communityScope('plugins', '')
  const pages = src.communityPages[communityScopeKey(scope)]
  if (!pages || (pages.at === 0 && pages.loading)) {
    return [{ id: 'plugins-pending', title: t('sections.plugins'), entries: [], pending: 3 }]
  }
  if (!pages.signedIn) {
    return [
      {
        id: 'community',
        title: t('sections.community'),
        entries: [],
        pending: 0,
        note: <CommunitySignedOut />,
      },
    ]
  }
  const featured = pages.items.filter((item) => item.official).slice(0, FEATURED_PLUGINS)
  const shown = new Set(featured.map((item) => item.id))
  return [
    {
      id: 'featured',
      title: t('sections.featured'),
      entries: featured.map(communityEntry),
      pending: 0,
      cards: true,
    },
    {
      id: 'yours',
      title: t('sections.yours'),
      entries: pages.yours.map(communityEntry),
      pending: 0,
    },
    {
      id: 'community',
      title: t('sections.community'),
      entries: pages.items.filter((item) => !shown.has(item.id)).map(communityEntry),
      pending: 0,
      more: moreOf(src, scope, pages),
    },
  ]
}

/** The part of the Kettu Marketplace's directory a tab shows for a query, or without one. */
function communityScope(tab: MarketplaceTab, query: string): CommunityScope {
  const kind = tabKind(tab)
  const q = query.slice(0, SEARCH_MAX)
  return { ...(kind ? { kind } : {}), ...(q ? { q } : {}) }
}

function useSources(): Sources {
  const { useMarketplaceStore } = useHostScope()
  const catalog = useMarketplaceStore((s) => s.catalog)
  const catalogPending = useMarketplaceStore((s) => !s.catalog && !s.catalogError)
  const skills = useMarketplaceStore((s) => s.skills)
  const skillsPending = useMarketplaceStore((s) => !s.skills && !s.skillsError)
  const search = useMarketplaceStore((s) => s.search)
  const { entries: workflows, loaded: workflowsLoaded } = useWorkflows()
  const workflowsPending = !workflowsLoaded
  const communityPages = useMarketplaceStore((s) => s.communityPages)
  return useMemo(
    () => ({
      catalog,
      catalogPending,
      skills,
      skillsPending,
      workflows,
      workflowsPending,
      search,
      communityPages,
      loadMoreCommunity: (scope: CommunityScope) =>
        void useMarketplaceStore.getState().loadMoreCommunity(scope),
      retrySkillRepository: (id: string) =>
        useMarketplaceStore.getState().loadSkillRepository(id, true),
    }),
    [
      catalog,
      catalogPending,
      skills,
      skillsPending,
      workflows,
      workflowsPending,
      search,
      communityPages,
      useMarketplaceStore,
    ],
  )
}

/**
 * The account's own Only me items, then the Community's public ones by installs, of `kind` when
 * given; while signed out, the Community section says what signing in shows.
 */
function communitySections(
  src: Sources,
  t: TFunction<'marketplace'>,
  kind: PublishKind | null,
): Section[] {
  const scope: CommunityScope = kind ? { kind } : {}
  const pages = src.communityPages[communityScopeKey(scope)]
  if (!pages || (pages.at === 0 && pages.loading)) {
    return [{ id: 'community', title: t('sections.community'), entries: [], pending: 2 }]
  }
  if (!pages.signedIn) {
    return [
      {
        id: 'community',
        title: t('sections.community'),
        entries: [],
        pending: 0,
        note: <CommunitySignedOut />,
      },
    ]
  }
  return [
    {
      id: 'yours',
      title: t('sections.yours'),
      entries: pages.yours.map(communityEntry),
      pending: 0,
    },
    {
      id: 'community',
      title: t('sections.community'),
      entries: pages.items.map(communityEntry),
      pending: 0,
      more: moreOf(src, scope, pages),
    },
  ]
}

/**
 * The workflow tab's Community group: the workflows this host added from it or, an older host,
 * shipped with, and the account's own Only me listings first, then the rest by installs, a page at a
 * time; null when a search finds nothing in it.
 */
function workflowCommunity(
  src: Sources,
  t: TFunction<'marketplace'>,
  query: string,
): Section | null {
  const title = t('sections.community')
  const locale = currentLocale()
  const added = src.workflows.filter(
    (entry) => workflowGroup(entry) === 'community' && workflowMatches(entry, query, locale),
  )
  const listings = new Set(
    added.flatMap((entry) => (entry.origin?.kind === 'community' ? [entry.origin.listingId] : [])),
  )
  const scope = communityScope('workflow', query)
  const pages = src.communityPages[communityScopeKey(scope)]
  const loading = !pages || (pages.at === 0 && pages.loading)
  const signedOut = !loading && !pages.signedIn
  const items = loading || signedOut ? [] : [...pages.yours, ...pages.items]
  const seen = new Set<string>()
  const rest = items.filter((item) => {
    if (listings.has(item.id) || seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
  const section: Section = {
    id: 'community',
    title,
    entries: [...added.map(workflowEntry), ...rest.map(communityEntry)],
    pending: loading ? 2 : 0,
    ...(signedOut ? { note: <CommunitySignedOut /> } : {}),
    ...(pages && !loading && !signedOut ? { more: moreOf(src, scope, pages) } : {}),
  }
  if (section.entries.length === 0 && section.pending === 0 && !section.note) {
    if (query) return null
    section.note = <p className="k-mkt-section-note">{t('workflow.communityEmpty')}</p>
  }
  return section
}

/** The workflow tab, its Community group paged like the other tabs'. */
function WorkflowTab({ query }: { query: string }) {
  const { t } = useTranslation('marketplace')
  const src = useSources()
  const section = useMemo(() => workflowCommunity(src, t, query), [src, t, query])
  return (
    <>
      <Notes tab="workflow" registry={null} query={query} />
      <WorkflowSections
        query={query}
        community={section && <SectionView tab="workflow" section={section} index={0} />}
      />
    </>
  )
}

function moreOf(src: Sources, scope: CommunityScope, pages: CommunityPages): SectionMore {
  return {
    next: pages.next !== null,
    loading: pages.loading,
    error: pages.moreError,
    load: () => src.loadMoreCommunity(scope),
  }
}

/** The MCP catalog's own sections, titled from the app's copy by their ids. */
function mcpSections(src: Sources, t: TFunction<'marketplace'>, skip: string | null): Section[] {
  if (!src.catalog) {
    return src.catalogPending ? [{ id: 'mcp-pending', title: null, entries: [], pending: 6 }] : []
  }
  return src.catalog.sections
    .filter((section) => section.id !== skip)
    .map((section) => ({
      id: `mcp-${section.id}`,
      title: sectionTitle(section.id, t),
      entries: section.items.map(mcpEntry),
      pending: 0,
    }))
}

function sectionTitle(id: string, t: TFunction<'marketplace'>): string {
  switch (id) {
    case 'featured':
      return t('sections.featured')
    case 'development':
      return t('sections.development')
    case 'data':
      return t('sections.data')
    case 'productivity':
      return t('sections.productivity')
    case 'design':
      return t('sections.design')
    default:
      return t('sections.other')
  }
}

/** All without a query: Featured, From Anthropic and workflow, then the MCP categories. */
function allSections(src: Sources, t: TFunction<'marketplace'>): Section[] {
  const skills = src.skills?.catalog ?? []
  const featuredMcp = src.catalog?.sections.find((s) => s.id === 'featured')?.items ?? []
  const featured = interleave(
    featuredMcp.map(mcpEntry),
    skills
      .filter((s) => s.official)
      .sort((a, b) => featuredRank(a.name) - featuredRank(b.name))
      .slice(0, FEATURED_SKILLS)
      .map(skillEntry),
  )
  const pendingRows = src.skillsPending ? 1 : 0
  return [
    {
      id: 'featured',
      title: t('sections.featured'),
      entries: featured,
      pending: pendingRows + (src.catalogPending ? 2 : 0),
      cards: true,
    },
    {
      id: 'anthropic',
      title: t('sections.anthropic'),
      entries: skills.filter(skillFromAnthropic).map(skillEntry),
      pending: pendingRows,
    },
    {
      id: 'workflows',
      title: t('sections.workflow'),
      entries: src.workflows.map(workflowEntry),
      pending: src.workflowsPending ? 2 : 0,
    },
    ...mcpSections(src, t, 'featured'),
    ...communitySections(src, t, null),
  ]
}

const TRUST_ORDER: Record<SkillTrust, number> = { official: 0, verified: 1, community: 2 }

/**
 * Skills without a query: one section per publisher, the official ones first, then the verified;
 * a repository not read yet shows its rows on their way, and one that failed says so with Retry.
 */
function skillSections(src: Sources, t: TFunction<'marketplace'>): Section[] {
  if (!src.skills) {
    return src.skillsPending
      ? [{ id: 'skills-pending', title: null, entries: [], pending: 6 }]
      : communitySections(src, t, 'skill')
  }
  const groups = new Map<string, { skills: CatalogSkill[]; repositories: SkillRepository[] }>()
  const group = (publisher: string) => {
    const found = groups.get(publisher) ?? { skills: [], repositories: [] }
    groups.set(publisher, found)
    return found
  }
  // An older host lists no repositories: its catalog is grouped by what it says of each skill.
  for (const repository of src.skills.repositories ?? []) {
    group(repository.publisher).repositories.push(repository)
  }
  for (const skill of src.skills.catalog) group(skill.publisher).skills.push(skill)
  const rank = ({
    skills,
    repositories,
  }: {
    skills: CatalogSkill[]
    repositories: SkillRepository[]
  }) =>
    Math.min(
      ...repositories.map((r) => TRUST_ORDER[r.trust]),
      ...skills.map((s) => TRUST_ORDER[s.trust ?? (s.official ? 'official' : 'community')]),
    )
  return [...groups]
    .sort(([, a], [, b]) => rank(a) - rank(b))
    .map(([publisher, { skills, repositories }]): Section => {
      const failed = repositories.find((r) => r.error !== null)
      const failure = failed && (
        <QuietNote action={<Retry onRetry={() => src.retrySkillRepository(failed.id)} />}>
          {t(skills.length > 0 ? 'notes.skillRepositoryStale' : 'notes.skillRepository', {
            repository: failed.id,
            error: failed.error,
          })}
        </QuietNote>
      )
      const trust = (['official', 'verified', 'community'] as const)[rank({ skills, repositories })]
      return {
        id: `publisher-${publisher}`,
        title: t('sections.from', { publisher }),
        ...(trust ? { caption: t(`sections.trust.${trust}`) } : {}),
        entries: skills.map(skillEntry),
        pending: repositories.some((r) => !r.read && r.error === null) ? 2 : 0,
        ...(failure && { note: failure }),
      }
    })
    .concat(communitySections(src, t, 'skill'))
}

/** With a query: one section of each kind the tab shows, the registry's for a long one. */
function foundSections(
  src: Sources,
  t: TFunction<'marketplace'>,
  tab: MarketplaceTab,
  query: string,
  registry: string | null,
): Section[] {
  const sections: Section[] = []
  if (tab === 'all' || tab === 'skills') {
    sections.push({
      id: 'found-skills',
      title: t('sections.skills'),
      entries: (src.skills?.catalog ?? []).filter((s) => skillMatches(s, query)).map(skillEntry),
      pending: src.skillsPending ? 2 : 0,
    })
  }
  if (tab === 'all') {
    sections.push({
      id: 'found-workflows',
      title: t('sections.workflow'),
      entries: src.workflows
        .filter((s) => workflowMatches(s, query, currentLocale()))
        .map(workflowEntry),
      pending: src.workflowsPending ? 2 : 0,
    })
  }
  if (tab === 'all' || tab === 'mcp') {
    if (registry !== null) {
      const search = src.search?.query === registry ? src.search : null
      sections.push({
        id: 'found-registry',
        title: t('sections.results'),
        entries: (search?.result?.items ?? []).map(mcpEntry),
        pending: !search || (!search.result && !search.error) ? 4 : 0,
      })
    } else {
      sections.push({
        id: 'found-mcp',
        title: t('sections.mcp'),
        entries: catalogServers(src.catalog)
          .filter((server) => matchesQuery(fromCatalog(server), query))
          .map(mcpEntry),
        pending: src.catalogPending ? 2 : 0,
      })
    }
  }
  const scope = communityScope(tab, query)
  const found = src.communityPages[communityScopeKey(scope)]
  if (src.communityPages[communityScopeKey({})]?.signedIn !== false && found?.signedIn !== false) {
    const first = !found || (found.at === 0 && found.loading)
    sections.push({
      id: 'found-community',
      title: t('sections.community'),
      entries: first ? [] : [...found.yours, ...found.items].map(communityEntry),
      pending: first ? 2 : 0,
      ...(found && !first ? { more: moreOf(src, scope, found) } : {}),
    })
  }
  return sections
}

export function Directory({ tab }: { tab: MarketplaceTab }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const { useMarketplaceStore } = scope
  const query = useMarketplaceStore((s) => s.query)
  const [dialog, setDialog] = useState<'mcp' | 'skill' | 'workflow' | 'plugin' | null>(null)
  const pluginInstall = usePluginInstall()
  const namesHosts = useNamesHosts()
  const windowHost = useWindowHost()
  const hostName = useHostName()
  const showsPublished = useShowsPublished()
  const tabs = showsPublished ? SIGNED_IN_TABS : TABS
  const published = tab === 'published'
  const labels: Record<MarketplaceTab, string> = {
    all: t('page.tabs.all'),
    plugins: t('page.tabs.plugins'),
    skills: t('page.tabs.skills'),
    mcp: t('page.tabs.mcp'),
    workflow: t('page.tabs.workflow'),
    installed: t('page.tabs.installed'),
    published: t('page.tabs.published'),
  }
  const publishedStore = usePublishedStore()
  const account = publishedStore((s) => s.account)
  // Signed out or Local mode takes the tab away, and the page back to All.
  useEffect(() => {
    if (published && account === null) setMarketplaceTab('all')
  }, [published, account])
  const q = query.trim()
  // The lists are long, so they filter once typing rests, as the registry is asked.
  const [filter, setFilter] = useState(q)
  useEffect(() => {
    const timer = setTimeout(() => setFilter(q), q ? SEARCH_DELAY_MS : 0)
    return () => clearTimeout(timer)
  }, [q])
  const registry =
    (tab === 'all' || tab === 'mcp') && filter.length >= SEARCH_MIN
      ? filter.slice(0, SEARCH_MAX)
      : null

  useEffect(() => {
    const store = useMarketplaceStore.getState()
    if (registry === null) store.clearSearch()
    else void store.find(registry)
  }, [registry, useMarketplaceStore])

  // The Kettu Marketplace is read by the service a page at a time, each kind and search on its own.
  const lists = tab !== 'installed' && tab !== 'published'
  const communityKey = lists ? communityScopeKey(communityScope(tab, filter)) : null
  useEffect(() => {
    const store = useMarketplaceStore.getState()
    if (!filter) store.clearCommunitySearch()
    if (communityKey !== null) store.ensureCommunity(communityScope(tab, filter))
    // communityKey stands for tab and filter together.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [communityKey, useMarketplaceStore])

  // Signing in or out of this computer's account changes what the Community shows.
  const accountState = useAccountStore((s) => s.status?.state ?? null)
  useEffect(() => {
    if (scope.hostId !== null || accountState === null) return
    const store = useMarketplaceStore.getState()
    const all = store.communityPages[communityScopeKey({})]
    if (all && all.signedIn !== (accountState === 'signed-in')) {
      useMarketplaceStore.setState({ communityPages: {} })
      void store.loadCommunity({}, true)
      if (communityKey !== null && communityKey !== communityScopeKey({})) {
        void store.loadCommunity(communityScope(tab, filter), true)
      }
    }
    // Only a change of account reads again; the tab's own reads are the effect above's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountState, scope.hostId, useMarketplaceStore])

  const addFolder = async () => {
    const path = await scope.api.dialogs.openProject()
    if (path) void installSkill(scope, { kind: 'local', path }, 'all', `local:${path}`)
  }
  const addPluginFolder = async () => {
    const path = await scope.api.dialogs.openProject()
    if (path) {
      void pluginInstall.start(
        { kind: 'local', path },
        { onInstalled: () => setMarketplaceTab('installed') },
      )
    }
  }

  return (
    <div className="ui-as-integrations k-mkt">
      <h1 className="ui-as-page-title">{t('page.title')}</h1>
      <p className="ui-as-page-sub">
        {!namesHosts
          ? t('page.description')
          : windowHost.kind === 'all'
            ? t(isMac ? 'page.descriptionAllMac' : 'page.descriptionAllComputer')
            : scope.hostId === null
              ? t(isMac ? 'page.descriptionThisMac' : 'page.descriptionThisComputer')
              : t('page.descriptionOn', { host: hostName(scope.hostId) })}
      </p>
      <MarketAway>
        <div className="ui-as-toolbar ui-as-integrations__bar">
          <Tabs
            items={tabs.map((id) => labels[id])}
            value={labels[tab]}
            onChange={(label) =>
              setMarketplaceTab(tabs.find((id) => labels[id] === label) ?? 'all')
            }
          />
          <div className="ui-as-toolbar__right">
            <SearchField
              placeholder={published ? t('page.searchPublished') : t('page.search')}
              width={230}
              value={query}
              onChange={(next) => useMarketplaceStore.setState({ query: next })}
            />
            {published ? (
              <PublishMenu />
            ) : (
              <Dropdown
                align="end"
                className="k-mkt-add"
                items={[
                  { label: t('add.heading'), heading: true },
                  {
                    label: t('add.pluginGithub'),
                    description: t('add.pluginGithubLine'),
                    icon: GithubIcon,
                    onSelect: () => setDialog('plugin'),
                  },
                  ...(isWeb
                    ? []
                    : [
                        {
                          label: t('add.pluginFolder'),
                          description: t('add.pluginFolderLine'),
                          icon: Folder01Icon,
                          onSelect: () => void addPluginFolder(),
                        },
                      ]),
                  {
                    label: t('add.mcp'),
                    description: t('add.mcpLine'),
                    icon: PlugSocketIcon,
                    onSelect: () => setDialog('mcp'),
                  },
                  {
                    label: t('add.skillGithub'),
                    description: t('add.skillGithubLine'),
                    icon: GithubIcon,
                    onSelect: () => setDialog('skill'),
                  },
                  ...(isWeb
                    ? []
                    : [
                        {
                          label: t('add.skillFolder'),
                          description: t('add.skillFolderLine'),
                          icon: Folder01Icon,
                          onSelect: () => void addFolder(),
                        },
                      ]),
                  {
                    label: t('add.workflowGithub'),
                    description: t('add.workflowGithubLine'),
                    icon: Flowchart01Icon,
                    onSelect: () => setDialog('workflow'),
                  },
                  {
                    label: t('add.workflowFile'),
                    description: t('add.workflowFileLine'),
                    icon: File02Icon,
                    onSelect: () => addWorkflowFromFile(scope),
                  },
                ]}
                trigger={({ open, toggle }) => (
                  <Button
                    size="md"
                    icon={<Icon icon={Add01Icon} size={15} />}
                    aria-expanded={open}
                    aria-haspopup="menu"
                    onClick={toggle}
                  >
                    {t('add.button')}
                  </Button>
                )}
              />
            )}
          </div>
        </div>
        <HarnessPluginsNote />
        {published ? (
          <div key="published">
            <PublishedView query={filter} />
          </div>
        ) : tab === 'installed' ? (
          <div key="installed">
            <InstalledView query={filter} />
          </div>
        ) : tab === 'workflow' ? (
          <div key={`workflow|${filter}`}>
            <WorkflowTab query={filter} />
          </div>
        ) : (
          <div key={`${tab}|${filter}`}>
            <Sections tab={tab} query={filter} registry={registry} />
          </div>
        )}
        <AddServerDialog
          open={dialog === 'mcp'}
          onOpenChange={(open) => setDialog(open ? 'mcp' : null)}
          onAdded={() => setMarketplaceTab('installed')}
        />
        <AddSkillDialog
          open={dialog === 'skill'}
          onOpenChange={(open) => setDialog(open ? 'skill' : null)}
        />
        <AddWorkflowDialog
          open={dialog === 'workflow'}
          onOpenChange={(open) => setDialog(open ? 'workflow' : null)}
        />
        <AddPluginGithubDialog
          open={dialog === 'plugin'}
          onOpenChange={(open) => setDialog(open ? 'plugin' : null)}
          install={pluginInstall}
        />
        {pluginInstall.dialogs}
      </MarketAway>
    </div>
  )
}

// Kept on this device in localStorage once the note was closed or the page left.
const PLUGINS_NOTE_KEY = 'market-harness-plugins-note'

/**
 * Said once, the first time the Marketplace shows: Claude Code's and Codex's plugins are now
 * managed in those tools.
 */
function HarnessPluginsNote() {
  const { t } = useTranslation('marketplace')
  const [shown, setShown] = useState(() => !readJson<boolean>(PLUGINS_NOTE_KEY, false))
  useEffect(() => {
    if (!shown) return
    return () => void writeJson(PLUGINS_NOTE_KEY, true)
  }, [shown])
  if (!shown) return null
  return (
    <div className="k-mkt-notes">
      <QuietNote
        action={
          <Button size="md" variant="ghost" onClick={() => setShown(false)}>
            {t('notes.harnessPluginsDismiss')}
          </Button>
        }
      >
        {t('notes.harnessPlugins')}
      </QuietNote>
    </div>
  )
}

function Sections({
  tab,
  query,
  registry,
}: {
  tab: MarketplaceTab
  query: string
  registry: string | null
}) {
  const { t } = useTranslation('marketplace')
  const src = useSources()
  const sections = useMemo(() => {
    const built = query
      ? foundSections(src, t, tab, query, registry)
      : tab === 'all'
        ? allSections(src, t)
        : tab === 'skills'
          ? skillSections(src, t)
          : tab === 'plugins'
            ? pluginSections(src, t)
            : [...mcpSections(src, t, null), ...communitySections(src, t, 'mcp-server')]
    return built.filter(
      (section) => section.entries.length > 0 || section.pending > 0 || section.note,
    )
  }, [src, t, tab, query, registry])

  return (
    <>
      <Notes tab={tab} registry={registry} query={query} />
      {sections.length === 0 && <Empty tab={tab} query={query} />}
      {sections.map((section, i) => (
        <SectionView key={section.id} tab={tab} section={section} index={i} />
      ))}
    </>
  )
}

function SectionView({
  tab,
  section,
  index,
}: {
  tab: MarketplaceTab
  section: Section
  index: number
}) {
  const { t } = useTranslation('marketplace')
  const key = `${tab}:${section.id}`
  const { useMarketplaceStore } = useHostScope()
  const extra = useMarketplaceStore((s) => s.more[key] ?? 0)
  const more = section.more
  if (section.title === null) return <SkeletonSection rows={section.pending} />
  const count = section.entries.length
  const heading = (
    <h2 className="ui-as-int-section__title k-mkt-section-title">
      <span>{section.title}</span>
      {count > 0 && (
        <small aria-label={t('sections.count', { count })}>
          {more?.next ? t('sections.countOpen', { count }) : count}
        </small>
      )}
      {section.caption && <small className="k-mkt-section-title__caption">{section.caption}</small>}
    </h2>
  )
  if (section.note && section.entries.length === 0) {
    return (
      <section className="ui-as-int-section ui-as-rise" style={{ '--i': index } as CSSProperties}>
        {heading}
        {section.note}
      </section>
    )
  }
  const visible = SECTION_ROWS + extra
  const shown = section.entries.slice(0, visible)
  const rest = section.entries.slice(visible)
  // Rows asked for that the service has yet to send.
  const awaited = more?.loading && rest.length === 0 && shown.length > SECTION_ROWS ? 2 : 0
  const showMore = () => {
    useMarketplaceStore.setState((s) => ({
      more: { ...s.more, [key]: (s.more[key] ?? 0) + MORE_STEP },
    }))
    if (more?.next && rest.length < MORE_STEP) more.load()
  }
  return (
    <section className="ui-as-int-section ui-as-rise" style={{ '--i': index } as CSSProperties}>
      {heading}
      <div className={section.cards ? 'ui-as-int-grid k-mkt-cards' : 'ui-as-int-grid'}>
        {shown.map((entry, i) => (
          <EntryRow
            key={entry.key}
            entry={entry}
            tab={tab}
            fresh={i >= SECTION_ROWS}
            card={section.cards}
          />
        ))}
        {rest.length === 0 &&
          Array.from({ length: section.pending + awaited }, (_, i) => (
            <SkeletonRow key={`pending-${i}`} card={section.cards} />
          ))}
      </div>
      {section.note}
      {more?.error && (
        <QuietNote action={<Retry onRetry={async () => more.load()} />}>
          {t('notes.communityMore', { error: more.error })}
        </QuietNote>
      )}
      {(rest.length > 0 || (more?.next && !more.error && !awaited)) && (
        <MoreButton
          items={rest}
          open={!!more?.next}
          loading={!!more?.loading && rest.length === 0}
          onClick={showMore}
        />
      )}
    </section>
  )
}

function EntryRow({
  entry,
  tab,
  fresh,
  card,
}: {
  entry: Entry
  tab: MarketplaceTab
  fresh: boolean
  card?: boolean
}) {
  if (entry.kind === 'community') {
    return <CommunityRow item={entry.item} tab={tab} fresh={fresh} card={card} />
  }
  if (entry.kind === 'skill') {
    return <SkillRow skill={entry.skill} tab={tab} fresh={fresh} card={card} />
  }
  if (entry.kind === 'workflow') {
    return <WorkflowRow entry={entry.workflow} tab={tab} fresh={fresh} card={card} />
  }
  const server = entry.server
  const open = () => openMarketplace({ item: entry.key, tab })
  return (
    <ItemRow
      title={server.title}
      subject={serverSubject(server)}
      meta={
        <>
          <KindTag kind="mcp" />
          {server.publisher && <Publisher name={server.publisher} />}
        </>
      }
      line={server.description || null}
      fresh={fresh}
      card={card}
      onOpen={open}
      end={<AddButton server={server} onOpen={open} />}
    />
  )
}

/** What could not be read, quietly over the sections of the tab it concerns, with Retry. */
function Notes({
  tab,
  registry,
  query,
}: {
  tab: MarketplaceTab
  registry: string | null
  query: string
}) {
  const { t } = useTranslation('marketplace')
  const src = useSources()
  const { useMarketplaceStore } = useHostScope()
  const catalogError = useMarketplaceStore((s) => s.catalogError)
  const skillsError = useMarketplaceStore((s) => s.skillsError)
  const store = useMarketplaceStore.getState
  const scope = useHostScope()
  const workflows = useWorkflows()
  const notes: ReactNode[] = []
  const skills = tab === 'all' || tab === 'skills'
  const mcp = tab === 'all' || tab === 'mcp'
  // A host that lists its repositories says which failed in their own sections.
  if (skills && ((skillsError && !src.skills) || (src.skills?.error && !src.skills.repositories))) {
    notes.push(
      <QuietNote key="skills" action={<Retry onRetry={() => store().loadSkills(true)} />}>
        {t('notes.skills', { error: skillsError ?? src.skills?.error })}
      </QuietNote>,
    )
  }
  if (mcp && (catalogError || src.catalog?.error)) {
    const fetchedAt = src.catalog?.fetchedAt ?? null
    notes.push(
      <QuietNote key="catalog" action={<Retry onRetry={() => store().loadCatalog(true)} />}>
        {!src.catalog?.sections.length
          ? t('notes.catalog', { error: catalogError ?? src.catalog?.error })
          : fetchedAt === null
            ? t('catalog.stale')
            : t('catalog.staleSince', { ago: mediumAgo(fetchedAt) })}
      </QuietNote>,
    )
  }
  if (tab === 'all' && workflows.error && workflows.entries.length === 0) {
    notes.push(
      <QuietNote key="workflows" action={<Retry onRetry={() => retryWorkflows(scope)} />}>
        {t('workflow.readFailed', { error: workflows.error })}
      </QuietNote>,
    )
  }
  const community = communityScope(tab, query)
  const communityFailure = src.communityPages[communityScopeKey(community)]?.error ?? null
  if (tab !== 'installed' && communityFailure) {
    notes.push(
      <QuietNote
        key="community"
        action={<Retry onRetry={() => store().loadCommunity(community, true)} />}
      >
        {t('notes.community', { error: communityFailure })}
      </QuietNote>,
    )
  }
  const search = registry !== null && src.search?.query === registry ? src.search : null
  const searchError = search?.error ?? search?.result?.error ?? null
  if (mcp && searchError) {
    notes.push(
      <QuietNote key="search" action={<Retry onRetry={() => store().find(registry!)} />}>
        {t('notes.search', { error: searchError })}
      </QuietNote>,
    )
  }
  return notes.length > 0 ? <div className="k-mkt-notes">{notes}</div> : null
}

/** When a tab has nothing to show and nothing on its way. */
function Empty({ tab, query }: { tab: MarketplaceTab; query: string }) {
  const { t } = useTranslation('marketplace')
  const [title, text] = query
    ? [t('search.noneTitle'), t('search.none', { query })]
    : tab === 'skills'
      ? [t('empty.skillsTitle'), t('empty.skills')]
      : tab === 'plugins'
        ? [t('empty.pluginsTitle'), t(isWeb ? 'empty.pluginsWeb' : 'empty.plugins')]
        : [t('catalog.emptyTitle'), t('catalog.emptyText')]
  return (
    <div className="ui-as-rise ui-as-int-empty">
      <EmptyState title={title} text={text} />
    </div>
  )
}

function Retry({ onRetry }: { onRetry: () => Promise<void> }) {
  const { t } = useTranslation('common')
  const [busy, setBusy] = useState(false)
  return (
    <Button
      size="md"
      variant="ghost"
      loading={busy}
      icon={<Icon icon={RefreshIcon} size={14} />}
      onClick={() => {
        setBusy(true)
        void onRetry().finally(() => setBusy(false))
      }}
    >
      {t('actions.retry')}
    </Button>
  )
}
