import type { StepState, TaskSummary } from '@shared/sop'
import { cn } from '@renderer/lib/utils'

/** A segment's look: a step's state, or `off` for a step an ended task never reached. */
type Segment = StepState | 'off'

const STROKE: Record<Segment, string> = {
  done: 'stroke-(--thread-done)',
  running: 'stroke-(--thread-fox)',
  needs_you: 'stroke-warning',
  error: 'stroke-danger',
  waiting: 'stroke-(--shell-line-strong)',
  not_reached: 'stroke-(--shell-line-strong)',
  off: 'stroke-(--shell-faint)',
}

/** The segments of a task's ring, one per step of its SOP in order. */
function taskSegments(task: Pick<TaskSummary, 'steps' | 'status'>): Segment[] {
  const ended = task.status === 'dropped' || task.status === 'cancelled'
  return task.steps.map((step) =>
    ended && step.state !== 'done' && step.state !== 'error' ? 'off' : step.state,
  )
}

/**
 * A task's progress as the plan chip's ring draws a plan: a segment per step, clockwise from the
 * top, green done, fox orange running, amber waiting for you, red stuck, gray not reached. Past
 * twelve steps the segments join.
 */
export function TaskRing({
  task,
  size = 14,
  className,
}: {
  task: Pick<TaskSummary, 'steps' | 'status'>
  size?: number
  className?: string
}) {
  const segments = taskSegments(task)
  const count = segments.length
  const gap = count > 12 ? 0 : 0.2
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={cn('shrink-0 fill-none', className)}
    >
      {segments.map((segment, i) => {
        const stroke = cn(STROKE[segment], '[stroke-linecap:round] [stroke-width:2.4]')
        if (count === 1) return <circle key={i} cx="8" cy="8" r="6" className={stroke} />
        const a0 = (i / count) * 2 * Math.PI - Math.PI / 2 + gap
        const a1 = ((i + 1) / count) * 2 * Math.PI - Math.PI / 2 - gap
        const p = (a: number) =>
          `${(8 + 6 * Math.cos(a)).toFixed(2)} ${(8 + 6 * Math.sin(a)).toFixed(2)}`
        return (
          <path
            key={i}
            d={`M${p(a0)} A6 6 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${p(a1)}`}
            className={stroke}
          />
        )
      })}
    </svg>
  )
}
