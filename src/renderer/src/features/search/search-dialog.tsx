import { Fragment, useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { Combobox as ComboboxPrimitive } from '@base-ui/react/combobox'
import {
  ChartPieIcon,
  ClockIcon,
  FolderIcon,
  FolderOpenIcon,
  KeyboardIcon,
  PanelLeftIcon,
  PlusIcon,
  SearchIcon,
  Settings2Icon,
  ShapesIcon,
  type LucideIcon,
} from 'lucide-react'
import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { newSession, openProjectDialog } from '@renderer/app/actions'
import { commandMenuStyles } from '@renderer/components/affect/command-menu'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { ComboboxList } from '@renderer/components/ui/combobox'
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog'
import { KIND_LOOK } from '@renderer/features/artifacts/kinds'
import { keyCaps } from '@renderer/features/shell/shortcuts'
import { glide } from '@renderer/lib/motion'
import { cn } from '@renderer/lib/utils'
import { artifactListShown, useArtifactsStore } from '@renderer/stores/artifacts'
import { useRoutinesStore } from '@renderer/stores/routines'
import {
  openArtifact,
  openArtifacts,
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
 * Base UI takes 'always' to keep the first row highlighted, on open and when the list changes with
 * the scope; its prop type only says boolean.
 */
const ALWAYS_HIGHLIGHT = 'always' as unknown as boolean

/** Keeps the focus in the field when a control beside it is pressed. */
const keepFocus = (event: MouseEvent) => event.preventDefault()

/** The list keeps one height, so the centered palette does not move as results change. */
const LIST_HEIGHT = { height: 'min(400px, 52svh)', maxHeight: 'none' }

/** The command menu's own glyph size and stroke, for Lucide's icons. */
const GLYPH = 'ui-cm__glyph'

/**
 * Search over the window, from the sidebar or Mod+K: sessions, artifacts, routines, projects,
 * settings sections and actions, in scopes. It wears affectUI's command menu: its stylesheet and
 * class names on Kettu's own list.
 */
export function SearchDialog() {
  const { t } = useTranslation('sidebar')
  const open = useViewStore((s) => s.searchOpen)
  return (
    <Dialog open={open} onOpenChange={showSearch}>
      <DialogContent
        showCloseButton={false}
        className="gap-0 rounded-[20px] bg-transparent p-0 sm:max-w-[600px]"
      >
        <DialogTitle className="sr-only">{t('nav.search')}</DialogTitle>
        {open && <SearchPalette />}
      </DialogContent>
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

function SearchPalette() {
  const { t } = useTranslation('sidebar')
  const entries = useSearchEntries()
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<SearchScope>('all')
  const results = useMemo(() => runSearch(entries, query, scope), [entries, query, scope])
  const trimmed = query.trim()

  // The artifact list is read while the palette shows; routines load with the window.
  useEffect(() => {
    artifactListShown(true)
    const routines = useRoutinesStore.getState()
    if (!routines.loaded) void routines.load()
    return () => artifactListShown(false)
  }, [])
  const artifactsLoaded = useArtifactsStore((s) => s.list !== null)

  const choose = (entry: SearchEntry | null) => {
    if (!entry) return
    showSearch(false)
    openEntry(entry)
  }

  const step = (by: 1 | -1) => {
    const at = SCOPES.indexOf(scope)
    setScope(SCOPES[(at + by + SCOPES.length) % SCOPES.length]!)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Tab' || event.nativeEvent.isComposing) return
    event.preventDefault()
    step(event.shiftKey ? -1 : 1)
  }

  return (
    <div className="ui-cm">
      <style href="ui-command-menu" precedence="default">
        {commandMenuStyles}
      </style>
      <ComboboxPrimitive.Root<SearchEntry>
        inline
        open
        autoHighlight={ALWAYS_HIGHLIGHT}
        items={results.groups}
        filter={null}
        value={null}
        onValueChange={choose}
        inputValue={query}
        onInputValueChange={setQuery}
        itemToStringLabel={(entry) => entry.title}
      >
        <div className="ui-cm__card">
          <label className="ui-cm__search">
            <SearchIcon aria-hidden />
            <ComboboxPrimitive.Input
              autoFocus
              placeholder={t('search.placeholder')}
              onKeyDown={onKeyDown}
            />
            <span aria-hidden className="ui-cm__keys">
              <kbd>Esc</kbd>
            </span>
          </label>
          <div
            role="group"
            aria-label={t('search.scopes')}
            className="flex gap-0.5 overflow-x-auto border-b border-(--ui-cm-line) px-1.5 py-1.5"
          >
            {SCOPES.map((item) => (
              <ScopeTab
                key={item}
                scope={item}
                active={item === scope}
                count={item === 'all' && !trimmed ? 0 : results.counts[item]}
                onSelect={setScope}
              />
            ))}
          </div>
          <p role="status" className="sr-only">
            {t('search.results', { count: results.counts[scope] })}
          </p>
          <ComboboxPrimitive.Empty
            style={LIST_HEIGHT}
            className="flex flex-col items-center justify-center gap-1 px-4 text-center empty:hidden"
          >
            <EmptyNote
              query={trimmed}
              scope={scope}
              loading={scope === 'artifacts' && !artifactsLoaded}
            />
          </ComboboxPrimitive.Empty>
          <ComboboxList
            aria-label={t('nav.search')}
            style={LIST_HEIGHT}
            highlight="rounded-[10px] bg-(--ui-cm-active)"
            className="ui-cm__list data-empty:hidden"
          >
            {(group: ResultGroup) => (
              <ComboboxPrimitive.Group key={group.key} items={group.items}>
                {scope === 'all' && <GroupHeader group={group} onShowAll={setScope} />}
                <ComboboxPrimitive.Collection>
                  {(entry: SearchEntry) => (
                    <SearchRow key={entry.key} entry={entry} words={results.words} />
                  )}
                </ComboboxPrimitive.Collection>
              </ComboboxPrimitive.Group>
            )}
          </ComboboxList>
        </div>
        <footer className="ui-cm__foot">
          <span className="flex items-center gap-4">
            <Hint keys={['↑', '↓']} label={t('search.hint.navigate')} />
            <Hint keys={['↵']} label={t('search.hint.open')} />
            <Hint keys={['⇥']} label={t('search.hint.scope')} />
          </span>
        </footer>
      </ComboboxPrimitive.Root>
    </div>
  )
}

function Hint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden className="ui-cm__keys">
        {keys.map((key) => (
          <kbd key={key}>{key}</kbd>
        ))}
      </span>
      {label}
    </span>
  )
}

/** The command menu resets a button's padding, color and weight, so the tab sets them inside. */
const TAB_PADDING = { padding: '0 10px' }

function ScopeTab({
  scope,
  active,
  count,
  onSelect,
}: {
  scope: SearchScope
  active: boolean
  count: number
  onSelect: (scope: SearchScope) => void
}) {
  const { t } = useTranslation('sidebar')
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => onSelect(scope)}
      // Tab steps through the scopes from the field, so the tabs themselves take no focus.
      tabIndex={-1}
      onMouseDown={keepFocus}
      style={TAB_PADDING}
      className="group/tab relative isolate flex h-7 shrink-0 items-center gap-1.5 rounded-tile"
    >
      {active && (
        <motion.span
          aria-hidden
          layoutId="search-scope"
          transition={glide}
          className="absolute inset-0 -z-10 rounded-tile bg-(--ui-cm-active)"
        />
      )}
      <span
        className={cn(
          'text-control transition-colors duration-(--duration-fast)',
          active
            ? 'font-medium text-(--ui-cm-ink)'
            : 'text-(--ui-cm-muted) group-hover/tab:text-(--ui-cm-ink)',
        )}
      >
        {t(`search.scope.${scope}`)}
      </span>
      {count > 0 && <span className="text-control text-(--ui-cm-faint) tabular-nums">{count}</span>}
    </button>
  )
}

function GroupHeader({
  group,
  onShowAll,
}: {
  group: ResultGroup
  onShowAll: (scope: SearchScope) => void
}) {
  const { t } = useTranslation('sidebar')
  const more = group.total > group.items.length
  const scope = SCOPE_OF_KIND[group.key]
  return (
    <div className="flex items-center justify-between">
      <ComboboxPrimitive.GroupLabel className="ui-cm__label">
        {t(`search.group.${group.key}`)}
      </ComboboxPrimitive.GroupLabel>
      {more && scope && (
        <button
          type="button"
          tabIndex={-1}
          onMouseDown={keepFocus}
          onClick={() => onShowAll(scope)}
          className="ui-cm__label transition-colors hover:text-(--ui-cm-ink)"
        >
          {t('search.showAll', { count: group.total })}
        </button>
      )}
    </div>
  )
}

const SCOPE_OF_KIND: Partial<Record<ResultGroup['key'], SearchScope>> = {
  session: 'sessions',
  artifact: 'artifacts',
  routine: 'routines',
  project: 'projects',
  section: 'settings',
}

function EmptyNote({
  query,
  scope,
  loading,
}: {
  query: string
  scope: SearchScope
  loading: boolean
}) {
  const { t } = useTranslation('sidebar')
  if (loading) return <span className="text-(--ui-cm-muted)">{t('search.loading')}</span>
  if (!query) return <span className="text-(--ui-cm-muted)">{t(`search.none.${scope}`)}</span>
  return (
    <>
      <span className="text-(--ui-cm-text)">{t('search.noMatch', { query })}</span>
      <span className="text-hint text-(--ui-cm-muted)">
        {scope === 'all'
          ? t('search.searchedAll')
          : t('search.searchedScope', { scope: t(`search.scope.${scope}`) })}
      </span>
    </>
  )
}

const ACTION_ICON: Record<SearchAction, LucideIcon> = {
  newSession: PlusIcon,
  openProject: FolderOpenIcon,
  openUsage: ChartPieIcon,
  openArtifacts: ShapesIcon,
  openRoutines: ClockIcon,
  openSettings: Settings2Icon,
  showShortcuts: KeyboardIcon,
  toggleSidebar: PanelLeftIcon,
}

/** The text with the query's words marked. */
function Marked({ text, words }: { text: string; words: readonly string[] }) {
  return markParts(text, words).map((part, i) =>
    part.match ? <mark key={i}>{part.text}</mark> : <Fragment key={i}>{part.text}</Fragment>,
  )
}

/** A session's agent and an artifact's kind sit on the menu's tile; the rest are plain glyphs. */
function RowMark({ entry }: { entry: SearchEntry }) {
  switch (entry.kind) {
    case 'session':
      return (
        <span aria-hidden className="ui-cm__logo">
          <AgentMark agent={entry.agentId} size={14} hostId={entry.hostId} />
        </span>
      )
    case 'artifact': {
      const look = KIND_LOOK[entry.artifactKind]
      return (
        <span aria-hidden className="ui-cm__logo">
          <look.icon className={cn('size-3.5', look.color)} />
        </span>
      )
    }
    case 'action': {
      const Icon = ACTION_ICON[entry.action]
      return (
        <span aria-hidden className="ui-cm__icon">
          <Icon className={GLYPH} />
        </span>
      )
    }
    default: {
      const Icon =
        entry.kind === 'routine' ? ClockIcon : entry.kind === 'project' ? FolderIcon : Settings2Icon
      return (
        <span aria-hidden className="ui-cm__icon">
          <Icon className={GLYPH} />
        </span>
      )
    }
  }
}

/** One result: what it is, its name, a line about it and when, and for an action its keys. */
function SearchRow({ entry, words }: { entry: SearchEntry; words: readonly string[] }) {
  return (
    <ComboboxPrimitive.Item value={entry} className="ui-cm__item">
      <RowMark entry={entry} />
      <span className="ui-cm__text">
        <span className="ui-cm__name">
          <Marked text={entry.title} words={words} />
        </span>
      </span>
      {entry.meta && (
        <span className="max-w-[46%] shrink-0 truncate text-hint text-(--ui-cm-muted)">
          <Marked text={entry.meta} words={words} />
        </span>
      )}
      {entry.trailing && (
        <span className="shrink-0 text-hint text-(--ui-cm-muted) tabular-nums">
          {entry.trailing}
        </span>
      )}
      {entry.kind === 'action' && entry.shortcut && (
        <span aria-hidden className="ui-cm__keys">
          {keyCaps(entry.shortcut).map((cap, i) => (
            <kbd key={i}>{cap}</kbd>
          ))}
        </span>
      )}
    </ComboboxPrimitive.Item>
  )
}
