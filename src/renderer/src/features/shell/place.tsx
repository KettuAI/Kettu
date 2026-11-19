import {
  BotIcon,
  DashboardSquare02Icon,
  FlowIcon,
  KanbanIcon,
  PencilEdit02Icon,
  PieChartIcon,
  Settings01Icon,
  Store01Icon,
  TimeScheduleIcon,
} from '@hugeicons/core-free-icons'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { TaskRing } from '@renderer/features/tasks/task-ring'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { useTasksStore } from '@renderer/stores/tasks'
import type { HistoryPlace } from '@renderer/stores/view'
import { Glyph } from './glyph'
import { usePlaceTitle } from './place-title'

/** A place's mark in the history's lists: its session's agent, a task's ring, or the page's icon. */
export function PlaceIcon({ place }: { place: HistoryPlace }) {
  return (
    <span aria-hidden className="grid size-4 shrink-0 place-items-center text-icon">
      {place.kind === 'session' ? (
        <SessionMark sessionId={place.sessionId} />
      ) : place.kind === 'task' ? (
        <TaskMark taskId={place.taskId} />
      ) : (
        <PageIcon place={place} />
      )}
    </span>
  )
}

function SessionMark({ sessionId }: { sessionId: string }) {
  const summary = useSessionsStore((s) => s.byId[sessionId])
  if (!summary || summary.origin === 'subagent') return <Glyph icon={BotIcon} size={15} />
  return <AgentMark agent={summary.agentId} size={15} hostId={hostOfSession(summary)} />
}

function TaskMark({ taskId }: { taskId: string }) {
  const task = useTasksStore((s) => s.summaries[taskId])
  return task ? <TaskRing task={task} size={15} /> : <Glyph icon={FlowIcon} size={15} />
}

function PageIcon({ place }: { place: HistoryPlace }) {
  switch (place.kind) {
    case 'settings':
      return <Glyph icon={Settings01Icon} size={15} />
    case 'overview':
      return <Glyph icon={KanbanIcon} size={15} />
    case 'usage':
      return <Glyph icon={PieChartIcon} size={15} />
    case 'routines':
    case 'routine':
      return <Glyph icon={TimeScheduleIcon} size={15} />
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
