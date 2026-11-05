import { useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { SearchIcon } from 'lucide-react'
import { newSession, openProjectDialog } from '@renderer/app/actions'
import {
  Combobox,
  ComboboxCollection,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxLabel,
  ComboboxList,
} from '@renderer/components/ui/combobox'
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog'
import { Kbd } from '@renderer/components/ui/kbd'
import { Toggle } from '@renderer/components/ui/toggle'
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
  runSearch,
  SCOPES,
  type ResultGroup,
  type SearchAction,
  type SearchEntry,
  type SearchScope,
} from './search-model'
import { SearchRow } from './search-row'
import { useSearchEntries } from './use-search-entries'

/**
 * Base UI takes 'always' to keep the first row highlighted, on open and when the list changes with
 * the scope; its prop type only says boolean.
 */
const ALWAYS_HIGHLIGHT = 'always' as unknown as boolean

/** Keeps the focus in the field when a control beside it is pressed. */
const keepFocus = (event: MouseEvent) => event.preventDefault()

/**
 * Search over the window, from the sidebar or Mod+K: sessions, artifacts, routines, projects,
 * settings sections and actions. An empty field lists the recent ones; typing narrows them.
 */
export function SearchDialog() {
  const { t } = useTranslation('sidebar')
  const open = useViewStore((s) => s.searchOpen)
  return (
    <Dialog open={open} onOpenChange={showSearch}>
      <DialogContent
        showCloseButton={false}
        className="top-[12svh] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-[620px]"
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
    <Combobox<SearchEntry>
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
      <div className="flex items-center gap-2.5 px-4">
        <SearchIcon aria-hidden className="size-4.5 shrink-0 text-tertiary" />
        <ComboboxInput
          showTrigger={false}
          autoFocus
          placeholder={t('search.placeholder')}
          onKeyDown={onKeyDown}
          className="h-13 min-w-0 flex-1 border-0 bg-transparent px-0 shadow-none has-[[data-slot=input-group-control]:focus-visible]:shadow-none! **:data-[slot=input-group-control]:px-0 **:data-[slot=input-group-control]:text-label"
        />
        <Kbd>Esc</Kbd>
      </div>
      <div className="hairline-x bg-border-soft" />
      <div
        role="group"
        aria-label={t('search.scopes')}
        className="flex gap-1 overflow-x-auto px-3 py-2"
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
      <div className="hairline-x bg-border-soft" />
      <p role="status" className="sr-only">
        {t('search.results', { count: results.counts[scope] })}
      </p>
      <ComboboxEmpty className="flex flex-col items-center gap-1 px-4 py-10 text-center empty:hidden">
        <EmptyNote
          query={trimmed}
          scope={scope}
          loading={scope === 'artifacts' && !artifactsLoaded}
        />
      </ComboboxEmpty>
      <ComboboxList
        aria-label={t('nav.search')}
        className="max-h-[min(440px,58svh)] p-1.5 data-empty:hidden"
      >
        {(group: ResultGroup) => (
          <ComboboxGroup key={group.key} items={group.items}>
            {scope === 'all' && <GroupHeader group={group} onShowAll={setScope} />}
            <ComboboxCollection>
              {(entry: SearchEntry) => (
                <SearchRow key={entry.key} entry={entry} words={results.words} />
              )}
            </ComboboxCollection>
          </ComboboxGroup>
        )}
      </ComboboxList>
      <div className="hairline-x bg-border-soft" />
      <div className="flex h-10 items-center gap-4 px-4 text-hint text-tertiary">
        <Hint keys={['↑', '↓']} label={t('search.hint.navigate')} />
        <Hint keys={['↵']} label={t('search.hint.open')} />
        <Hint keys={['⇥']} label={t('search.hint.scope')} />
      </div>
    </Combobox>
  )
}

function Hint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="flex gap-1">
        {keys.map((key) => (
          <Kbd key={key}>{key}</Kbd>
        ))}
      </span>
      {label}
    </span>
  )
}

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
    <Toggle
      size="sm"
      pressed={active}
      onPressedChange={() => onSelect(scope)}
      // Tab steps through the scopes from the field, so the tabs themselves take no focus.
      tabIndex={-1}
      onMouseDown={keepFocus}
      className={cn('gap-1.5 text-secondary aria-pressed:font-medium aria-pressed:text-foreground')}
    >
      {t(`search.scope.${scope}`)}
      {count > 0 && <span className="font-normal text-tertiary tabular-nums">{count}</span>}
    </Toggle>
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
    <div className="flex items-center justify-between pr-2">
      <ComboboxLabel className="px-2.5">{t(`search.group.${group.key}`)}</ComboboxLabel>
      {more && scope && (
        <button
          type="button"
          tabIndex={-1}
          onMouseDown={keepFocus}
          onClick={() => onShowAll(scope)}
          className="rounded-md px-1.5 text-small text-tertiary transition-colors hover:text-foreground"
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
  if (loading) return <span className="text-tertiary">{t('search.loading')}</span>
  if (!query) return <span className="text-tertiary">{t(`search.none.${scope}`)}</span>
  return (
    <>
      <span className="text-secondary">{t('search.noMatch', { query })}</span>
      <span className="text-hint text-tertiary">
        {scope === 'all'
          ? t('search.searchedAll')
          : t('search.searchedScope', { scope: t(`search.scope.${scope}`) })}
      </span>
    </>
  )
}
