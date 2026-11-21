// A workflow as a still chart that runs from the left, on the task flowchart's layout: forward
// arrows solid, arrows back and early ends dashed, with the steps and ends drawn by the caller.

import { useMemo, type ReactNode } from 'react'
import type { TaskEnd, Workflow, WorkflowStep } from '@shared/workflow'
import { cn } from '@renderer/lib/utils'
import {
  headOf,
  intoJoin,
  laneMiddle,
  layoutFlow,
  pathOf,
  sideways,
  type FlowEdge,
  type FlowMetrics,
} from './flow-layout'

export function SidewaysFlow({
  workflow,
  metrics,
  scale,
  labelOf,
  step,
  end,
  className,
  labelClassName,
}: {
  workflow: Workflow
  /** The layout's sizes; `nodeH` is a step's width once turned, `nodeW` its height. */
  metrics: FlowMetrics
  /** At most 1; the chart is drawn this much smaller. */
  scale: (width: number) => number
  /** An arrow's words, or null for none. */
  labelOf: (edge: FlowEdge) => string | null
  step: (step: WorkflowStep, index: number) => ReactNode
  end: (end: TaskEnd) => ReactNode
  className?: string
  labelClassName?: string
}) {
  const layout = useMemo(() => sideways(layoutFlow(workflow, metrics)), [workflow, metrics])
  const by = Math.min(1, scale(layout.width))
  // An arrow to the early end runs above the steps like one back, so it is dashed as they are.
  const dashed = (edge: FlowEdge) => edge.back || edge.to === 'end:dropped'
  return (
    <div
      className={cn('relative', className)}
      style={{ width: layout.width * by, height: layout.height * by }}
    >
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{ width: layout.width, height: layout.height, transform: `scale(${by})` }}
      >
        <svg
          width={layout.width}
          height={layout.height}
          className="absolute inset-0 overflow-visible"
          aria-hidden
        >
          {layout.edges.map((edge) => {
            const { points, dot } = edge.join
              ? intoJoin(edge.points)
              : { points: edge.points, dot: null }
            return (
              <g key={edge.id} className="fill-none stroke-(--thread-line-strong)">
                <path
                  d={pathOf(points, 8)}
                  strokeWidth={1.2}
                  strokeLinejoin="round"
                  strokeDasharray={dashed(edge) ? '3 3' : undefined}
                />
                {!edge.join && <path d={headOf(points)} strokeWidth={1.2} strokeLinecap="round" />}
                {dot && (
                  <circle
                    cx={dot[0]}
                    cy={dot[1]}
                    r={3}
                    className="fill-(--thread-line-strong) stroke-none"
                  />
                )}
              </g>
            )
          })}
        </svg>
        {layout.edges.map((edge) => {
          const label = labelOf(edge)
          if (!label) return null
          const [x, y] = laneMiddle(edge.points)
          return (
            <span
              key={edge.id}
              className={cn(
                'absolute max-w-48 -translate-1/2 truncate rounded-[4px] bg-(--thread-card) px-1 text-[10px] leading-3.5 font-medium whitespace-nowrap text-(--thread-muted)',
                labelClassName,
              )}
              style={{ left: x, top: y }}
            >
              {label}
            </span>
          )
        })}
        {layout.nodes.map((node) => {
          const index = workflow.steps.findIndex((s) => s.id === node.id)
          return (
            <div
              key={node.id}
              className="absolute flex"
              style={{ left: node.x, top: node.y, width: metrics.nodeH, height: metrics.nodeW }}
            >
              {step(workflow.steps[index]!, index)}
            </div>
          )
        })}
        {layout.ends.map((each) => (
          <div
            key={each.end}
            className="absolute -translate-1/2"
            style={{ left: each.x, top: each.y, width: metrics.endSize, height: metrics.endSize }}
          >
            {end(each.end)}
          </div>
        ))}
      </div>
    </div>
  )
}
