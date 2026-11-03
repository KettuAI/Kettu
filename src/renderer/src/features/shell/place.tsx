import {
  BotIcon,
  CalendarClockIcon,
  ChartPieIcon,
  PlusIcon,
  Settings2Icon,
  ShapesIcon,
} from 'lucide-react'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { useSessionsStore } from '@renderer/stores/sessions'
import type { HistoryPlace } from '@renderer/stores/view'
import { usePlaceTitle } from './place-title'

/** A place's mark in the history's lists: its session's agent, or the page's own icon. */
export function PlaceIcon({ place }: { place: HistoryPlace }) {
  return (
    <span aria-hidden className="grid size-4 shrink-0 place-items-center text-icon">
      {place.kind === 'session' ? (
        <SessionMark sessionId={place.sessionId} />
      ) : (
        <PageIcon place={place} />
      )}
    </span>
  )
}

function SessionMark({ sessionId }: { sessionId: string }) {
  const summary = useSessionsStore((s) => s.byId[sessionId])
  if (!summary || summary.origin === 'subagent') return <BotIcon className="size-3.75" />
  return <AgentMark agent={summary.agentId} size={15} />
}

function PageIcon({ place }: { place: HistoryPlace }) {
  switch (place.kind) {
    case 'settings':
      return <Settings2Icon className="size-3.5" />
    case 'usage':
      return <ChartPieIcon className="size-3.75" />
    case 'routines':
    case 'routine':
      return <CalendarClockIcon className="size-3.75" />
    case 'artifacts':
    case 'artifact':
      return <ShapesIcon className="size-3.75" />
    default:
      return <PlusIcon className="size-3.75" />
  }
}

export function PlaceTitle({ place, className }: { place: HistoryPlace; className?: string }) {
  return <span className={className}>{usePlaceTitle(place)}</span>
}
