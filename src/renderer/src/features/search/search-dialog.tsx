import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import {
  Analytics01Icon,
  ArrowRight01Icon,
  Clock01Icon,
  DashboardSquare02Icon,
  File01Icon,
  FolderOpenIcon,
  Globe02Icon,
  KeyboardIcon,
  PaintBoardIcon,
  PencilEdit02Icon,
  Presentation01Icon,
  RepeatIcon,
  Settings02Icon,
  SidebarLeftIcon,
  Store01Icon,
} from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { newSession, openProjectDialog } from '@renderer/app/actions'
import { FolderClosedMark, Icon } from '@renderer/components/affect/app-shell'
import {
  CommandMenu,
  type Command,
  type CommandGroup,
} from '@renderer/components/affect/command-menu'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Dialog } from '@renderer/components/ui/dialog'
import type { ArtifactKind } from '@renderer/features/artifacts/model'
import { keyCaps } from '@renderer/features/shell/shortcuts'
import { artifactListShown, useArtifactsStore } from '@renderer/stores/artifacts'
import { useRoutinesStore } from '@renderer/stores/routines'
import {
  openArtifact,
  openArtifacts,
  openMarketplace,
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
  type SearchScope,
} from './search-model'
import { useSearchEntries } from './use-search-entries'

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
  }
}

function openEntry(entry: SearchEntry): void {
  switch (entry.kind) {
    case 'session':
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
  }
}

const SCOPE_OF_KIND: Partial<Record<ResultGroup['key'], Exclude<SearchScope, 'all'>>> = {
  session: 'sessions',
  artifact: 'artifacts',
  routine: 'routines',
  project: 'projects',
  section: 'settings',
}

// A row that switches to its group's scope, "Show all 12".
const SHOW_ALL = 'scope:'

function SearchPalette() {
  const { t } = useTranslation('sidebar')
  const entries = useSearchEntries()
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<SearchScope>('all')
  const results = useMemo(() => runSearch(entries, query, scope), [entries, query, scope])
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
    const label =
      scope === 'all'
        ? t(`search.group.${group.key}`)
        : trimmed
          ? t('search.results', { count: group.total })
          : t(`search.latest.${scope}`)
    const more: Command[] =
      scope === 'all' && scopeOf && group.total > group.items.length
        ? [
            {
              id: `${SHOW_ALL}${scopeOf}`,
              label: t('search.showAll', { count: group.total }),
              icon: <Icon icon={ArrowRight01Icon} size={16} />,
            },
          ]
        : []
    return { id: group.key, label, commands: [...group.items.map(commandOf), ...more] }
  })

  const scopes = SCOPES.map((id) => ({
    id,
    label: t(`search.scope.${id}`),
    count: id === 'all' ? undefined : results.counts[id],
  }))

  const empty: ReactNode =
    scope === 'artifacts' && !artifactsLoaded ? (
      <div className="kettu-search-empty">
        <span>{t('search.loading')}</span>
      </div>
    ) : (
      <div className="kettu-search-empty">
        <b>{trimmed ? t('search.noMatch', { query: trimmed }) : t(`search.none.${scope}`)}</b>
        {trimmed && (
          <span>
            {scope === 'all'
              ? t('search.searchedAll')
              : t('search.searchedScope', { scope: t(`search.scope.${scope}`) })}
          </span>
        )}
      </div>
    )

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
  openUsage: Analytics01Icon,
  openArtifacts: DashboardSquare02Icon,
  openRoutines: RepeatIcon,
  openMarketplace: Store01Icon,
  openSettings: Settings02Icon,
  showShortcuts: KeyboardIcon,
  toggleSidebar: SidebarLeftIcon,
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
  }
}
