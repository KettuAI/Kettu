// The Marketplace's directory: its tabs, search and Add over sections of plugins, skills and MCP
// servers. Each source fills its sections as it answers; the rest show at once.

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import {
  Add01Icon,
  Folder01Icon,
  GithubIcon,
  PlugSocketIcon,
  RefreshIcon,
  Store01Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type {
  CatalogPlugin,
  CatalogServer,
  CatalogSkill,
  MarketCatalog,
  MarketPlugins,
  MarketSkills,
} from '@shared/marketplace'
import { displayTitle } from '@shared/marketplace'
import {
  Dropdown,
  EmptyState,
  Icon,
  SearchField,
  Tabs,
} from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { mediumAgo } from '@renderer/lib/format'
import { isMac, isWeb } from '@renderer/lib/platform'
import { useHostScope } from '@renderer/stores/host-scope'
import { SEARCH_MAX, SEARCH_MIN, type MarketSearchState } from '@renderer/stores/marketplace'
import { openMarketplace, setMarketplaceTab, type MarketplaceTab } from '@renderer/stores/view'
import { useHostName, useNamesHosts, useWindowHost } from '@renderer/stores/window-host'
import { installSkill } from './actions'
import { AddMarketplaceDialog, AddServerDialog, AddSkillDialog } from './dialogs'
import { useAgentName } from './hooks'
import { MarketAway } from './parts'
import { InstalledView } from './installed'
import {
  byInstalls,
  categoryTitle,
  catalogServers,
  fromAnthropic,
  fromCatalog,
  itemKey,
  matchesQuery,
  pluginMatches,
  skillFromAnthropic,
  skillMatches,
} from './model'
import { PluginRow } from './plugins'
import {
  AddButton,
  ItemRow,
  KindTag,
  MoreButton,
  QuietNote,
  SkeletonRow,
  SkeletonSection,
} from './rows'
import { SkillRow } from './skills'
import { pluginSubject, serverSubject, skillSubject, type TileSubject } from './tile-art'

const TABS: readonly MarketplaceTab[] = ['all', 'plugins', 'skills', 'mcp', 'installed']

/** Rows a section shows before it folds the rest into "… and N more", and how many more a click shows. */
const SECTION_ROWS = 6
const MORE_STEP = 60

/** How long the search field rests before the lists are filtered and the registry asked. */
const SEARCH_DELAY_MS = 300

/** How many featured plugins and official skills the All tab's Featured section mixes in. */
const FEATURED_PLUGINS = 6
const FEATURED_SKILLS = 3
/** The official skills most people reach for, in the order Featured shows them. */
const FEATURED_SKILL_NAMES = ['pdf', 'docx', 'xlsx', 'pptx', 'skill-creator', 'webapp-testing']
const featuredRank = (name: string): number => {
  const rank = FEATURED_SKILL_NAMES.indexOf(name)
  return rank < 0 ? FEATURED_SKILL_NAMES.length : rank
}

type Entry =
  | { kind: 'mcp'; key: string; title: string; subject: TileSubject; server: CatalogServer }
  | { kind: 'plugin'; key: string; title: string; subject: TileSubject; plugin: CatalogPlugin }
  | { kind: 'skill'; key: string; title: string; subject: TileSubject; skill: CatalogSkill }

interface Section {
  id: string
  /** Null while it is not known yet: a title's room. */
  title: string | null
  entries: Entry[]
  /** Skeleton rows after the entries, for a source still on its way. */
  pending: number
}

const mcpEntry = (server: CatalogServer): Entry => ({
  kind: 'mcp',
  key: itemKey({ kind: 'mcp', id: server.id }),
  title: server.title,
  subject: serverSubject(server),
  server,
})
const pluginEntry = (plugin: CatalogPlugin): Entry => ({
  kind: 'plugin',
  key: itemKey({ kind: 'plugin', harness: plugin.harness, id: plugin.id }),
  title: plugin.title,
  subject: pluginSubject(plugin),
  plugin,
})
const skillEntry = (skill: CatalogSkill): Entry => ({
  kind: 'skill',
  key: itemKey({ kind: 'skill', id: skill.id }),
  title: displayTitle(skill.name),
  subject: skillSubject(skill.name),
  skill,
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
  plugins: MarketPlugins | null
  pluginsPending: boolean
  skills: MarketSkills | null
  skillsPending: boolean
  search: MarketSearchState | null
}

function useSources(): Sources {
  const { useMarketplaceStore } = useHostScope()
  const catalog = useMarketplaceStore((s) => s.catalog)
  const catalogPending = useMarketplaceStore((s) => !s.catalog && !s.catalogError)
  const plugins = useMarketplaceStore((s) => s.plugins)
  const pluginsPending = useMarketplaceStore((s) => !s.plugins && !s.pluginsError)
  const skills = useMarketplaceStore((s) => s.skills)
  const skillsPending = useMarketplaceStore((s) => !s.skills && !s.skillsError)
  const search = useMarketplaceStore((s) => s.search)
  return useMemo(
    () => ({ catalog, catalogPending, plugins, pluginsPending, skills, skillsPending, search }),
    [catalog, catalogPending, plugins, pluginsPending, skills, skillsPending, search],
  )
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

/** All without a query: Featured, From Anthropic and For Codex, then the MCP categories. */
function allSections(src: Sources, t: TFunction<'marketplace'>): Section[] {
  const plugins = [...(src.plugins?.catalog ?? [])].sort(byInstalls)
  const skills = src.skills?.catalog ?? []
  const featuredMcp = src.catalog?.sections.find((s) => s.id === 'featured')?.items ?? []
  const featured = interleave(
    featuredMcp.map(mcpEntry),
    plugins
      .filter((p) => p.featured)
      .slice(0, FEATURED_PLUGINS)
      .map(pluginEntry),
    skills
      .filter((s) => s.official)
      .sort((a, b) => featuredRank(a.name) - featuredRank(b.name))
      .slice(0, FEATURED_SKILLS)
      .map(skillEntry),
  )
  const pendingRows = (src.pluginsPending ? 2 : 0) + (src.skillsPending ? 1 : 0)
  return [
    {
      id: 'featured',
      title: t('sections.featured'),
      entries: featured,
      pending: pendingRows + (src.catalogPending ? 2 : 0),
    },
    {
      id: 'anthropic',
      title: t('sections.anthropic'),
      entries: [
        ...plugins.filter(fromAnthropic).map(pluginEntry),
        ...skills.filter(skillFromAnthropic).map(skillEntry),
      ],
      pending: pendingRows,
    },
    {
      id: 'codex',
      title: t('sections.codex'),
      entries: plugins.filter((p) => p.harness === 'codex').map(pluginEntry),
      pending: src.pluginsPending ? 4 : 0,
    },
    ...mcpSections(src, t, 'featured'),
  ]
}

/** Plugins without a query: the featured, then each category, the largest first. */
function pluginSections(src: Sources, t: TFunction<'marketplace'>): Section[] {
  if (!src.plugins) {
    return src.pluginsPending
      ? [
          { id: 'plugins-pending-1', title: null, entries: [], pending: 6 },
          { id: 'plugins-pending-2', title: null, entries: [], pending: 4 },
        ]
      : []
  }
  const plugins = [...src.plugins.catalog].sort(byInstalls)
  const groups = new Map<string, CatalogPlugin[]>()
  for (const plugin of plugins) {
    const category = plugin.category?.trim().toLocaleLowerCase() ?? ''
    groups.set(category, [...(groups.get(category) ?? []), plugin])
  }
  const categories = [...groups]
    .sort(([a, x], [b, y]) => (a === '' ? 1 : b === '' ? -1 : y.length - x.length))
    .map(([category, list]) => ({
      id: `category-${category}`,
      title: category ? categoryTitle(category) : t('sections.otherPlugins'),
      entries: list.map(pluginEntry),
      pending: 0,
    }))
  return [
    {
      id: 'featured-plugins',
      title: t('sections.featured'),
      entries: plugins.filter((p) => p.featured).map(pluginEntry),
      pending: 0,
    },
    ...categories,
  ]
}

/** Skills without a query: one section per publisher, the official ones first. */
function skillSections(src: Sources, t: TFunction<'marketplace'>): Section[] {
  if (!src.skills) {
    return src.skillsPending ? [{ id: 'skills-pending', title: null, entries: [], pending: 6 }] : []
  }
  const groups = new Map<string, CatalogSkill[]>()
  for (const skill of src.skills.catalog) {
    groups.set(skill.publisher, [...(groups.get(skill.publisher) ?? []), skill])
  }
  return [...groups]
    .sort(([, a], [, b]) => Number(b.some((s) => s.official)) - Number(a.some((s) => s.official)))
    .map(([publisher, list]) => ({
      id: `publisher-${publisher}`,
      title: t('sections.from', { publisher }),
      entries: list.map(skillEntry),
      pending: 0,
    }))
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
  if (tab === 'all' || tab === 'plugins') {
    sections.push({
      id: 'found-plugins',
      title: t('sections.plugins'),
      entries: (src.plugins?.catalog ?? [])
        .filter((p) => pluginMatches(p, query))
        .sort(byInstalls)
        .map(pluginEntry),
      pending: src.pluginsPending ? 2 : 0,
    })
  }
  if (tab === 'all' || tab === 'skills') {
    sections.push({
      id: 'found-skills',
      title: t('sections.skills'),
      entries: (src.skills?.catalog ?? []).filter((s) => skillMatches(s, query)).map(skillEntry),
      pending: src.skillsPending ? 2 : 0,
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
  return sections
}

export function Directory({ tab }: { tab: MarketplaceTab }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const { useMarketplaceStore } = scope
  const query = useMarketplaceStore((s) => s.query)
  const [dialog, setDialog] = useState<'mcp' | 'marketplace' | 'skill' | null>(null)
  const namesHosts = useNamesHosts()
  const windowHost = useWindowHost()
  const hostName = useHostName()
  const labels: Record<MarketplaceTab, string> = {
    all: t('page.tabs.all'),
    plugins: t('page.tabs.plugins'),
    skills: t('page.tabs.skills'),
    mcp: t('page.tabs.mcp'),
    installed: t('page.tabs.installed'),
  }
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

  const addFolder = async () => {
    const path = await scope.api.dialogs.openProject()
    if (path) void installSkill(scope, { kind: 'local', path }, 'all', `local:${path}`)
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
            items={TABS.map((id) => labels[id])}
            value={labels[tab]}
            onChange={(label) =>
              setMarketplaceTab(TABS.find((id) => labels[id] === label) ?? 'all')
            }
          />
          <div className="ui-as-toolbar__right">
            <SearchField
              placeholder={t('page.search')}
              width={230}
              value={query}
              onChange={(next) => useMarketplaceStore.setState({ query: next })}
            />
            <Dropdown
              align="end"
              className="k-mkt-add"
              items={[
                { label: t('add.heading'), heading: true },
                {
                  label: t('add.marketplace'),
                  description: t('add.marketplaceLine'),
                  icon: Store01Icon,
                  onSelect: () => setDialog('marketplace'),
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
                  label: t('add.mcp'),
                  description: t('add.mcpLine'),
                  icon: PlugSocketIcon,
                  onSelect: () => setDialog('mcp'),
                },
              ]}
              trigger={({ open, toggle }) => (
                <Button
                  size="sm"
                  icon={<Icon icon={Add01Icon} size={15} />}
                  aria-expanded={open}
                  aria-haspopup="menu"
                  onClick={toggle}
                >
                  {t('add.button')}
                </Button>
              )}
            />
          </div>
        </div>
        {tab === 'installed' ? (
          <div key="installed">
            <InstalledView query={filter} />
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
        <AddMarketplaceDialog
          open={dialog === 'marketplace'}
          onOpenChange={(open) => setDialog(open ? 'marketplace' : null)}
        />
        <AddSkillDialog
          open={dialog === 'skill'}
          onOpenChange={(open) => setDialog(open ? 'skill' : null)}
        />
      </MarketAway>
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
        : tab === 'plugins'
          ? pluginSections(src, t)
          : tab === 'skills'
            ? skillSections(src, t)
            : mcpSections(src, t, null)
    return built.filter((section) => section.entries.length > 0 || section.pending > 0)
  }, [src, t, tab, query, registry])

  return (
    <>
      <Notes tab={tab} registry={registry} />
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
  const key = `${tab}:${section.id}`
  const { useMarketplaceStore } = useHostScope()
  const extra = useMarketplaceStore((s) => s.more[key] ?? 0)
  if (section.title === null) return <SkeletonSection rows={section.pending} />
  const visible = SECTION_ROWS + extra
  const shown = section.entries.slice(0, visible)
  const rest = section.entries.slice(visible)
  return (
    <section className="ui-as-int-section ui-as-rise" style={{ '--i': index } as CSSProperties}>
      <h2 className="ui-as-int-section__title">{section.title}</h2>
      <div className="ui-as-int-grid">
        {shown.map((entry, i) => (
          <EntryRow key={entry.key} entry={entry} tab={tab} fresh={i >= SECTION_ROWS} />
        ))}
        {rest.length === 0 &&
          Array.from({ length: section.pending }, (_, i) => <SkeletonRow key={`pending-${i}`} />)}
      </div>
      {rest.length > 0 && (
        <MoreButton
          items={rest}
          onClick={() =>
            useMarketplaceStore.setState((s) => ({
              more: { ...s.more, [key]: (s.more[key] ?? 0) + MORE_STEP },
            }))
          }
        />
      )}
    </section>
  )
}

function EntryRow({ entry, tab, fresh }: { entry: Entry; tab: MarketplaceTab; fresh: boolean }) {
  const showKind = tab === 'all'
  if (entry.kind === 'plugin') {
    return <PluginRow plugin={entry.plugin} tab={tab} showKind={showKind} fresh={fresh} />
  }
  if (entry.kind === 'skill') {
    return <SkillRow skill={entry.skill} tab={tab} showKind={showKind} fresh={fresh} />
  }
  const server = entry.server
  const open = () => openMarketplace({ item: entry.key, tab })
  return (
    <ItemRow
      title={server.title}
      subject={serverSubject(server)}
      official={server.official}
      tag={showKind ? <KindTag kind="mcp" /> : undefined}
      line={server.description || null}
      fresh={fresh}
      onOpen={open}
      end={<AddButton server={server} onOpen={open} />}
    />
  )
}

/** What could not be read, quietly over the sections of the tab it concerns, with Retry. */
function Notes({ tab, registry }: { tab: MarketplaceTab; registry: string | null }) {
  const { t } = useTranslation('marketplace')
  const src = useSources()
  const { useMarketplaceStore } = useHostScope()
  const agentName = useAgentName()
  const catalogError = useMarketplaceStore((s) => s.catalogError)
  const pluginsError = useMarketplaceStore((s) => s.pluginsError)
  const skillsError = useMarketplaceStore((s) => s.skillsError)
  const store = useMarketplaceStore.getState
  const notes: ReactNode[] = []
  const plugins = tab === 'all' || tab === 'plugins'
  const skills = tab === 'all' || tab === 'skills'
  const mcp = tab === 'all' || tab === 'mcp'
  if (plugins && pluginsError && !src.plugins) {
    notes.push(
      <QuietNote key="plugins" action={<Retry onRetry={() => store().loadPlugins(true)} />}>
        {t('notes.plugins', { error: pluginsError })}
      </QuietNote>,
    )
  }
  if (plugins) {
    for (const error of src.plugins?.errors ?? []) {
      notes.push(
        <QuietNote key={`plugins-${error.agentId}`}>
          {t('notes.agentPlugins', { agent: agentName(error.agentId), error: error.message })}
        </QuietNote>,
      )
    }
  }
  if (skills && ((skillsError && !src.skills) || src.skills?.error)) {
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
    : tab === 'plugins'
      ? [t('empty.pluginsTitle'), t('empty.plugins')]
      : tab === 'skills'
        ? [t('empty.skillsTitle'), t('empty.skills')]
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
      size="sm"
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
