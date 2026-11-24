import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import {
  ArrowRight01Icon,
  Clock01Icon,
  DashboardSquare02Icon,
  File01Icon,
  FlashIcon,
  FolderOpenIcon,
  Globe02Icon,
  KanbanIcon,
  KeyboardIcon,
  PaintBoardIcon,
  PencilEdit02Icon,
  PieChartIcon,
  Presentation01Icon,
  Settings02Icon,
  SidebarLeftIcon,
  StarIcon,
  Store01Icon,
  TimeScheduleIcon,
} from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { newSession, openProjectDialog } from '@renderer/app/actions'
import { starFromPalette } from '@renderer/features/github-star/palette'
import { FolderClosedMark, Icon } from '@renderer/components/affect/app-shell'
import {
  CommandMenu,
  type Command,
  type CommandGroup,
} from '@renderer/components/affect/command-menu'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { VIEW_ICONS } from '@renderer/features/plugin-views/icons'
import { PluginTile } from '@renderer/features/plugin-views/plugin-tile'
import { runPluginAction } from '@renderer/features/plugin-views/run-action'
import { Button } from '@renderer/components/ui/button'
import { Dialog } from '@renderer/components/ui/dialog'
import { Skeleton } from '@renderer/components/ui/skeleton'
import type { ArtifactKind } from '@renderer/features/artifacts/model'
import { keyCaps } from '@renderer/features/shell/shortcuts'
import { artifactListShown, useArtifactsStore } from '@renderer/stores/artifacts'
import { useOtherHosts } from '@renderer/stores/hosts'
import { revealMessage } from '@renderer/stores/reveal'
import { useRoutinesStore } from '@renderer/stores/routines'
import {
  openArtifact,
  openArtifacts,
  openMarketplace,
  openOverview,
  openRoutine,
  openRoutines,
  openSession,
  openSettings,
  openUsage,
  showSearch,
  showShortcuts,
  toggleSidebar,
  useViewStore,
} from '@renderer/stores/view'
import {
  markParts,
  runSearch,
  SCOPES,
  type ResultGroup,
  type SearchAction,
  type SearchEntry,
  type SearchKind,
  type SearchScope,
} from './search-model'
import { useConversationHits } from './use-conversation-hits'
import { useConversationEntries, useSearchEntries } from './use-search-entries'

/**
 * Search over the window, from the sidebar's field or Mod+K: sessions, artifacts, routines,
 * projects, settings sections and actions, in scopes, on affectUI's Command Menu over a soft scrim.
 */
export function SearchDialog() {
  const { t } = useTranslation('sidebar')
  const open = useViewStore((s) => s.searchOpen)
  return (
    <Dialog open={open} onOpenChange={showSearch}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="kettu-search-scrim" />
        <DialogPrimitive.Popup
          data-overlay-layer=""
          aria-label={t('nav.search')}
          className="kettu-search-popup"
        >
          <DialogPrimitive.Title className="sr-only">{t('nav.search')}</DialogPrimitive.Title>
          {open && <SearchPalette />}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </Dialog>
  )
}

function runAction(action: SearchAction): void {
  switch (action) {
    case 'newSession':
      newSession()
      break
    case 'openProject':
      void openProjectDialog()
      break
    case 'openOverview':
      openOverview()
      break
    case 'openUsage':
      openUsage()
      break
    case 'openArtifacts':
      openArtifacts()
      break
    case 'openRoutines':
      openRoutines()
      break
    case 'openMarketplace':
      openMarketplace()
      break
    case 'openSettings':
      openSettings()
      break
    case 'showShortcuts':
      showShortcuts(true)
      break
    case 'toggleSidebar':
      toggleSidebar()
      break
    case 'starKettu':
      starFromPalette()
      break
  }
}

function openEntry(entry: SearchEntry): void {
  switch (entry.kind) {
    case 'session':
      openSession(entry.sessionId, entry.projectPath)
      break
    case 'conversation':
      revealMessage({ sessionId: entry.sessionId, entryId: entry.entryId, pos: entry.pos })
      openSession(entry.sessionId, entry.projectPath)
      break
    case 'artifact':
      openArtifact(entry.artifactId)
      break
    case 'routine':
      openRoutine(entry.routineId)
      break
    case 'project':
      newSession(entry.path)
      break
    case 'section':
      openSettings(entry.section)
      break
    case 'action':
      runAction(entry.action)
      break
    case 'pluginAction':
      void runPluginAction({
        hostId: entry.hostId,
        pluginId: entry.pluginId,
        actionId: entry.actionId,
        label: entry.title,
      })
      break
  }
}

const SCOPE_OF_KIND: Partial<Record<ResultGroup['key'], Exclude<SearchScope, 'all'>>> = {
  session: 'sessions',
  conversation: 'conversations',
  artifact: 'artifacts',
  routine: 'routines',
  project: 'projects',
  section: 'settings',
}

// A row that switches to its group's scope, "Show all 12".
const SHOW_ALL = 'scope:'
// A row that lists the rest of a plugin's actions in place, "Show all 12".
const EXPAND = 'expand:'

function SearchPalette() {
  const { t } = useTranslation(['sidebar', 'common'])
  const found = useSearchEntries()
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<SearchScope>('all')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const conversations = useConversationHits(query)
  const others = useOtherHosts()
  const said = useConversationEntries(conversations.hits)
  const entries = useMemo(() => [...found, ...said], [found, said])
  const results = useMemo(
    () => runSearch(entries, query, scope, expanded),
    [entries, query, scope, expanded],
  )
  const byKey = useMemo(() => new Map(entries.map((entry) => [entry.key, entry])), [entries])
  const trimmed = query.trim()
  const { words } = results
  // Each word of the query is marked wherever it matches, as the matching reads them.
  const mark = useCallback(
    (text: string) =>
      markParts(text, words).map((part, i) =>
        part.match ? <mark key={i}>{part.text}</mark> : <Fragment key={i}>{part.text}</Fragment>,
      ),
    [words],
  )

  // The artifact list is read while the palette shows; routines load with the window.
  useEffect(() => {
    artifactListShown(true)
    const routines = useRoutinesStore.getState()
    if (!routines.loaded) void routines.load()
    return () => artifactListShown(false)
  }, [])
  const artifactsLoaded = useArtifactsStore((s) => s.list !== null)

  const groups: CommandGroup[] = results.groups.map((group) => {
    const scopeOf = SCOPE_OF_KIND[group.key]
    const label = group.plugin
      ? group.plugin.title
      : scope === 'all'
        ? t(`search.group.${group.key as Exclude<SearchKind, 'pluginAction'> | 'recent'}`)
        : trimmed
          ? t('search.results', { count: group.total })
          : t(`search.latest.${scope}`)
    const rest = group.total > group.items.length
    const showAll = (id: string): Command[] => [
      {
        id,
        label: t('search.showAll', { count: group.total }),
        icon: <Icon icon={ArrowRight01Icon} size={16} />,
      },
    ]
    const more: Command[] =
      scope !== 'all' || !rest
        ? []
        : group.plugin
          ? showAll(`${EXPAND}${group.key}`)
          : scopeOf
            ? showAll(`${SHOW_ALL}${scopeOf}`)
            : []
    const logo = group.plugin && (
      <PluginTile name={group.plugin.name} icon={group.plugin.icon} size={14} />
    )
    return { id: group.key, label, logo, commands: [...group.items.map(commandOf), ...more] }
  })

  const scopes = SCOPES.map((id) => ({
    id,
    label: t(`search.scope.${id}`),
    count: id === 'all' ? undefined : results.counts[id],
  }))

  const asksConversations = scope === 'conversations' || scope === 'all'
  const percent = conversations.indexing
    ? Math.min(99, Math.floor((conversations.indexing.done / conversations.indexing.total) * 100))
    : null
  const indexingNote = percent === null ? null : t('search.indexing', { percent })
  const empty: ReactNode =
    scope === 'artifacts' && !artifactsLoaded ? (
      <div className="kettu-search-empty">
        <span>{t('search.loading')}</span>
      </div>
    ) : asksConversations && conversations.searching ? (
      // A quick answer shows nothing in between; a slow one shows rows where the results will be.
      <div className="kettu-search-empty" role="status">
        {conversations.slow &&
          (scope === 'conversations' ? (
            <ConversationSkeleton />
          ) : (
            <span>{t('search.searching')}</span>
          ))}
      </div>
    ) : asksConversations && conversations.failures.length > 0 ? (
      <div className="kettu-search-empty" role="alert">
        <b>{t('search.failed')}</b>
        <span title={conversations.failures[0]}>{conversations.failures[0]}</span>
        <Button size="xs" variant="outline" className="mx-auto" onClick={conversations.retry}>
          {t('common:actions.retry')}
        </Button>
      </div>
    ) : scope === 'conversations' && (!trimmed || conversations.short) ? (
      <div className="kettu-search-empty">
        <b>{t(trimmed ? 'search.minChars' : 'search.none.conversations')}</b>
      </div>
    ) : (
      <div className="kettu-search-empty">
        <b>
          {trimmed
            ? t(scope === 'conversations' ? 'search.noConversation' : 'search.noMatch', {
                query: trimmed,
              })
            : t(`search.none.${scope}`)}
        </b>
        {trimmed && (
          <span>
            {scope === 'all'
              ? t('search.searchedAll')
              : t('search.searchedScope', { scope: t(`search.scope.${scope}`) })}
          </span>
        )}
        {indexingNote && asksConversations && <span>{indexingNote}</span>}
      </div>
    )

  // What the conversation search could not reach or has not finished, under the results.
  const hostName = (hostId: string | null): string =>
    hostId === null
      ? t('hosts.thisComputer')
      : (others.find((host) => host.id === hostId)?.name ?? t('hosts.unknown'))
  const notes = [
    // The empty state says it already, in its own words.
    results.groups.length === 0 && asksConversations ? null : indexingNote,
    conversations.away.length > 0 &&
      t('search.hostsAway', { hosts: conversations.away.join(', ') }),
    conversations.waiting.length > 0 &&
      t('search.hostsSlow', { hosts: conversations.waiting.map(hostName).join(', ') }),
    conversations.failures.length > 0 &&
      conversations.hits.length > 0 &&
      t('search.hostsFailed', { count: conversations.failures.length }),
  ].filter(Boolean)

  // The count of what was found, for those who cannot see the list change.
  const foundCount = results.counts.conversations
  const announcement =
    conversations.short || conversations.searching || !trimmed
      ? ''
      : t('search.announce', { count: foundCount })

  return (
    <CommandMenu
      className="kettu-search"
      groups={groups}
      autoFocus
      filter={false}
      ask={false}
      placeholder={t('search.placeholder')}
      scopes={scopes}
      scope={scope}
      onScopeChange={(id) => setScope(id as SearchScope)}
      onQueryChange={setQuery}
      empty={empty}
      labels={{ input: t('nav.search'), scopes: t('search.scopes'), list: t('nav.search') }}
      mark={mark}
      hints={
        <>
          <span className="sr-only" role="status">
            {announcement}
          </span>
          {notes.map((note) => (
            <span key={String(note)} className="kettu-search-note">
              {note}
            </span>
          ))}
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> {t('search.hint.navigate')}
          </span>
          <span>
            <kbd>↵</kbd> {t('search.hint.open')}
          </span>
          <span>
            <kbd>⇥</kbd> {t('search.hint.scope')}
          </span>
        </>
      }
      onClose={() => showSearch(false)}
      onRun={(id) => {
        if (id.startsWith(SHOW_ALL)) return setScope(id.slice(SHOW_ALL.length) as SearchScope)
        if (id.startsWith(EXPAND)) {
          return setExpanded((open) => new Set(open).add(id.slice(EXPAND.length)))
        }
        const entry = byKey.get(id)
        if (!entry) return
        showSearch(false)
        openEntry(entry)
      }}
    />
  )
}

const ACTION_ICON: Record<SearchAction, IconSvgElement> = {
  newSession: PencilEdit02Icon,
  openProject: FolderOpenIcon,
  openOverview: KanbanIcon,
  openUsage: PieChartIcon,
  openArtifacts: DashboardSquare02Icon,
  openRoutines: TimeScheduleIcon,
  openMarketplace: Store01Icon,
  openSettings: Settings02Icon,
  showShortcuts: KeyboardIcon,
  toggleSidebar: SidebarLeftIcon,
  starKettu: StarIcon,
}

const KIND_ICON: Record<ArtifactKind, IconSvgElement> = {
  document: File01Icon,
  slides: Presentation01Icon,
  web: Globe02Icon,
  canvas: PaintBoardIcon,
}

/** One result as the menu's row: its mark, its name, a line about it and when, and its keys. */
function commandOf(entry: SearchEntry): Command {
  const base = {
    id: entry.key,
    label: entry.title,
    hint: entry.meta ?? undefined,
    trail: entry.trailing ?? undefined,
  }
  switch (entry.kind) {
    case 'session':
      return {
        ...base,
        logo: <AgentMark agent={entry.agentId} size={16} hostId={entry.hostId} />,
      }
    case 'conversation':
      return {
        ...base,
        logo: <AgentMark agent={entry.agentId} size={16} hostId={entry.hostId} />,
        detail: entry.snippet,
      }
    case 'project':
      return { ...base, logo: <FolderClosedMark /> }
    case 'artifact':
      return { ...base, icon: <Icon icon={KIND_ICON[entry.artifactKind]} size={16} /> }
    case 'routine':
      return { ...base, icon: <Icon icon={Clock01Icon} size={16} /> }
    case 'section':
      return { ...base, icon: <Icon icon={Settings02Icon} size={16} /> }
    case 'action':
      return {
        ...base,
        icon: <Icon icon={ACTION_ICON[entry.action]} size={16} />,
        keys: entry.shortcut ? keyCaps(entry.shortcut) : undefined,
      }
    case 'pluginAction':
      return {
        ...base,
        icon: <Icon icon={entry.icon ? VIEW_ICONS[entry.icon] : FlashIcon} size={16} />,
      }
  }
}

/** Rows where the sessions found by what was said will be, while the hosts search. */
function ConversationSkeleton() {
  return (
    <div className="kettu-search-skeleton" aria-hidden>
      {[0, 1, 2].map((row) => (
        <div key={row} className="kettu-search-skeleton__row">
          <Skeleton className="size-4 rounded-full" />
          <div className="grid min-w-0 flex-1 gap-1.5">
            <Skeleton className="h-3 w-2/5" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        </div>
      ))}
    </div>
  )
}
