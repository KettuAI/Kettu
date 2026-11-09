import {
  Analytics01Icon,
  BotIcon,
  DashboardSquare02Icon,
  PencilEdit02Icon,
  RepeatIcon,
  Settings01Icon,
  Store01Icon,
} from '@hugeicons/core-free-icons'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { useSessionsStore } from '@renderer/stores/sessions'
import type { HistoryPlace } from '@renderer/stores/view'
import { Glyph } from './glyph'
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
  if (!summary || summary.origin === 'subagent') return <Glyph icon={BotIcon} size={15} />
  return <AgentMark agent={summary.agentId} size={15} />
}

function PageIcon({ place }: { place: HistoryPlace }) {
  switch (place.kind) {
    case 'settings':
      return <Glyph icon={Settings01Icon} size={15} />
    case 'usage':
      return <Glyph icon={Analytics01Icon} size={15} />
    case 'routines':
    case 'routine':
      return <Glyph icon={RepeatIcon} size={15} />
    case 'artifacts':
    case 'artifact':
      return <Glyph icon={DashboardSquare02Icon} size={15} />
    case 'marketplace':
      return <Glyph icon={Store01Icon} size={15} />
    default:
      return <Glyph icon={PencilEdit02Icon} size={15} />
  }
}

export function PlaceTitle({ place, className }: { place: HistoryPlace; className?: string }) {
  return <span className={className}>{usePlaceTitle(place)}</span>
}
