import { Fragment } from 'react'
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
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { ComboboxItem } from '@renderer/components/ui/combobox'
import { Kbd, KbdGroup } from '@renderer/components/ui/kbd'
import { KIND_LOOK } from '@renderer/features/artifacts/kinds'
import { keyCaps } from '@renderer/features/shell/shortcuts'
import { cn } from '@renderer/lib/utils'
import { markParts, type SearchAction, type SearchEntry } from './search-model'

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
    part.match ? (
      <mark key={i} className="rounded-sm bg-mark text-inherit">
        {part.text}
      </mark>
    ) : (
      <Fragment key={i}>{part.text}</Fragment>
    ),
  )
}

function RowIcon({ entry }: { entry: SearchEntry }) {
  switch (entry.kind) {
    case 'session':
      return <AgentMark agent={entry.agentId} size={18} hostId={entry.hostId} />
    case 'artifact': {
      const look = KIND_LOOK[entry.artifactKind]
      return (
        <span className={cn('grid size-5 place-items-center rounded-md', look.tint)}>
          <look.icon className={cn('size-3.5', look.color)} />
        </span>
      )
    }
    case 'routine':
      return <ClockIcon className="size-4 text-icon" />
    case 'project':
      return <FolderIcon className="size-4 text-icon" />
    case 'section':
      return <Settings2Icon className="size-4 text-icon" />
    case 'action': {
      const Icon = ACTION_ICON[entry.action]
      return <Icon className="size-4 text-icon" />
    }
  }
}

/** One result: what it is, its name, a line about it and, for an action, its keys. */
export function SearchRow({ entry, words }: { entry: SearchEntry; words: readonly string[] }) {
  return (
    <ComboboxItem value={entry} className="min-h-10 gap-3 rounded-lg px-2.5">
      <span aria-hidden className="grid size-5 shrink-0 place-items-center">
        <RowIcon entry={entry} />
      </span>
      <span className="min-w-0 flex-1 truncate">
        <Marked text={entry.title} words={words} />
      </span>
      {entry.meta && (
        <span className="max-w-[46%] shrink-0 truncate text-hint text-tertiary">
          <Marked text={entry.meta} words={words} />
        </span>
      )}
      {entry.trailing && (
        <span className="shrink-0 text-hint text-tertiary tabular-nums">{entry.trailing}</span>
      )}
      {entry.kind === 'action' && entry.shortcut && (
        <KbdGroup>
          {keyCaps(entry.shortcut).map((cap, i) => (
            <Kbd key={i}>{cap}</Kbd>
          ))}
        </KbdGroup>
      )}
    </ComboboxItem>
  )
}
