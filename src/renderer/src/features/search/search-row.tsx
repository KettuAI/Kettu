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
      return <AgentMark agent={entry.agentId} size={12} hostId={entry.hostId} />
    case 'artifact': {
      const look = KIND_LOOK[entry.artifactKind]
      return <look.icon className={cn('size-3', look.color)} />
    }
    case 'routine':
      return <ClockIcon className="size-3 text-icon" />
    case 'project':
      return <FolderIcon className="size-3 text-icon" />
    case 'section':
      return <Settings2Icon className="size-3 text-icon" />
    case 'action': {
      const Icon = ACTION_ICON[entry.action]
      return <Icon className="size-3 text-icon" />
    }
  }
}

/** One result: its mark in a raised tile, its name with a line about it, and its keys. */
export function SearchRow({ entry, words }: { entry: SearchEntry; words: readonly string[] }) {
  return (
    <ComboboxItem value={entry} className="h-9 min-h-0 gap-2.5 rounded-lg px-2 py-0 text-menu">
      <span
        aria-hidden
        className="grid size-5 shrink-0 place-items-center rounded-lg bg-raised shadow-raised"
      >
        <RowIcon entry={entry} />
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="max-w-full shrink-0 truncate text-foreground">
          <Marked text={entry.title} words={words} />
        </span>
        {entry.meta && (
          <span className="min-w-0 truncate text-tertiary">
            <Marked text={entry.meta} words={words} />
          </span>
        )}
      </span>
      {entry.trailing && (
        <span className="shrink-0 text-small text-tertiary tabular-nums">{entry.trailing}</span>
      )}
      {entry.kind === 'action' && entry.shortcut && (
        <KbdGroup>
          {keyCaps(entry.shortcut).map((cap, i) => (
            <Kbd key={i} className={PALETTE_KEY}>
              {cap}
            </Kbd>
          ))}
        </KbdGroup>
      )}
    </ComboboxItem>
  )
}

/** A key cap in the palette: smaller and quieter than a button's. */
export const PALETTE_KEY = 'h-5 min-w-5 rounded-lg px-1 font-normal text-tertiary'
