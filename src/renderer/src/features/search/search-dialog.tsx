import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChartPieIcon,
  ClockIcon,
  FolderIcon,
  FolderOpenIcon,
  KeyboardIcon,
  PanelLeftIcon,
  PlusIcon,
  Settings2Icon,
  ShapesIcon,
  type LucideIcon,
} from 'lucide-react'
import { newSession, openProjectDialog } from '@renderer/app/actions'
import {
  CommandMenu,
  type Command,
  type CommandGroup,
} from '@renderer/components/affect/command-menu'
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { KIND_LOOK } from '@renderer/features/artifacts/kinds'
import { keyCaps } from '@renderer/features/shell/shortcuts'
import { cn } from '@renderer/lib/utils'
import { artifactListShown } from '@renderer/stores/artifacts'
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
import { runSearch, type SearchAction, type SearchEntry, type SearchKind } from './search-model'
import { useSearchEntries } from './use-search-entries'

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
        className="top-[12svh] translate-y-0 gap-0 rounded-[20px] bg-transparent p-0 sm:max-w-[600px]"
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

/** The command menu's own glyph size and stroke, for Lucide's icons. */
const GLYPH = 'ui-cm__glyph'

/** A session's agent and an artifact's kind sit on a tile; the rest are plain glyphs. */
function mark(entry: SearchEntry): Pick<Command, 'logo' | 'icon'> {
  switch (entry.kind) {
    case 'session':
      return { logo: <AgentMark agent={entry.agentId} size={14} hostId={entry.hostId} /> }
    case 'artifact': {
      const look = KIND_LOOK[entry.artifactKind]
      return { logo: <look.icon className={cn('size-3.5', look.color)} /> }
    }
    case 'routine':
      return { icon: <ClockIcon className={GLYPH} /> }
    case 'project':
      return { icon: <FolderIcon className={GLYPH} /> }
    case 'section':
      return { icon: <Settings2Icon className={GLYPH} /> }
    case 'action': {
      const Icon = ACTION_ICON[entry.action]
      return { icon: <Icon className={GLYPH} /> }
    }
  }
}

/** One result as a command menu row: its mark, its name, a line about it and its keys. */
function commandOf(entry: SearchEntry): Command {
  // A settings section's line is a whole sentence: it is searched, not shown, so the name stays whole.
  const hint =
    entry.kind === 'section' ? '' : [entry.meta, entry.trailing].filter(Boolean).join(' · ')
  return {
    id: entry.key,
    label: entry.title,
    ...(hint && { hint }),
    ...mark(entry),
    keywords: entry.haystack,
    ...(entry.kind === 'action' && entry.shortcut && { keys: keyCaps(entry.shortcut) }),
  }
}

/** Kinds listed, most recent first, once something is typed. */
const SEARCHED: readonly SearchKind[] = ['session', 'artifact', 'routine', 'project']

/**
 * The palette is affectUI's command menu: an empty field lists Recent, whose first five take
 * Mod+1 to Mod+5, and the actions; typing searches every kind, and Tab jumps between the groups.
 */
function SearchPalette() {
  const { t } = useTranslation('sidebar')
  const entries = useSearchEntries()

  // The artifact list is read while the palette shows; routines load with the window.
  useEffect(() => {
    artifactListShown(true)
    const routines = useRoutinesStore.getState()
    if (!routines.loaded) void routines.load()
    return () => artifactListShown(false)
  }, [])

  const byKey = useMemo(() => new Map(entries.map((entry) => [entry.key, entry])), [entries])
  const groups = useMemo<CommandGroup[]>(() => {
    const recent = runSearch(entries, '', 'all').groups.find((g) => g.key === 'recent')
    const ofKind = (kind: SearchKind) =>
      entries
        .filter((entry) => entry.kind === kind)
        .sort((a, b) => b.at - a.at)
        .map(commandOf)
    return [
      {
        id: 'suggestions',
        label: t('search.group.recent'),
        when: 'empty',
        commands: (recent?.items ?? []).map(commandOf),
      },
      ...SEARCHED.map((kind): CommandGroup => ({
        id: kind,
        label: t(`search.group.${kind}`),
        when: 'query',
        commands: ofKind(kind),
      })),
      { id: 'action', label: t('search.group.action'), commands: ofKind('action') },
      {
        id: 'section',
        label: t('search.group.section'),
        when: 'query',
        commands: ofKind('section'),
      },
    ]
  }, [entries, t])

  return (
    <CommandMenu
      autoFocus
      ask={false}
      groups={groups}
      placeholder={t('search.placeholder')}
      labels={{
        field: t('nav.search'),
        list: t('nav.search'),
        enter: t('search.menu.enter'),
        tip: t('search.menu.tip'),
        open: t('search.menu.open'),
      }}
      onClose={() => showSearch(false)}
      onRun={(id) => {
        const entry = byKey.get(id)
        if (!entry) return
        showSearch(false)
        openEntry(entry)
      }}
    />
  )
}
