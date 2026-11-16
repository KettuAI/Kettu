import { useMemo } from 'react'
import { SparklesIcon, Tick02Icon, UserIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { Pace, Workflow, WireWorkflowEntry } from '@shared/workflow'
import type { AgentId } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import {
  headOf,
  layoutFlow,
  pathOf,
  sideways,
  type FlowEdge,
  type FlowMetrics,
  type Point,
} from '@renderer/features/tasks/flow-layout'
import { Glyph } from '@renderer/features/shell/glyph'
import { openWorkflowMarketplace } from './open-task'
import { localStepName, stepSource, WORKFLOW_ICON, workflowName } from './workflow-picks'

/** Small steps for a chart that runs from the left: `nodeH` is a step's width once turned. */
const MINI: FlowMetrics = {
  nodeW: 32,
  nodeH: 116,
  endSize: 18,
  colGap: 12,
  rowGap: 30,
  laneStart: 16,
  laneGap: 16,
  labelRoom: 0,
  slot: 14,
  inset: 16,
  bend: 8,
  pad: 10,
}
/** The widest a chart is drawn before it is shrunk to fit the card. */
const MAX_W = 600
const NO_PINS = {}

/** Where a lane's label sits: the middle of the arrow's longest run, along its lane. */
function laneMiddle(points: Point[]): Point {
  let best: [Point, Point] = [points[0]!, points[1]!]
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i]!
    const b = points[i + 1]!
    const length = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (length > Math.hypot(best[1][0] - best[0][0], best[1][1] - best[0][1])) best = [a, b]
  }
  return [(best[0][0] + best[1][0]) / 2, (best[0][1] + best[1][1]) / 2]
}

/** An arrow into a join stops short of its dot, which sits where the arrows meet. */
function intoJoin(points: Point[]): { points: Point[]; dot: Point } {
  const last = points.at(-1)!
  const before = points.at(-2)!
  const dx = Math.sign(last[0] - before[0])
  const dy = Math.sign(last[1] - before[1])
  return {
    points: [...points.slice(0, -1), [last[0] - dx * 7, last[1] - dy * 7]],
    dot: [last[0] - dx * 4, last[1] - dy * 4],
  }
}

/**
 * A workflow at a glance, in the hover card of New session's workflow: its name, steps and
 * description over a small chart from the left with who does each step, the first on the tray's
 * agent, then the pace the task starts with.
 */
export function WorkflowPreview({
  entry,
  hostId,
  firstAgentId,
  pace,
}: {
  entry: WireWorkflowEntry & { workflow: Workflow }
  hostId: string | null
  firstAgentId: AgentId | null
  pace: Pace
}) {
  const { t, i18n } = useTranslation(['session', 'tasks'])
  const workflow = entry.workflow
  const layout = useMemo(() => sideways(layoutFlow(workflow, MINI)), [workflow])
  const scale = Math.min(1, MAX_W / layout.width)
  const description = workflow.locales[i18n.language]?.description ?? workflow.description
  const label = (edge: FlowEdge) =>
    edge.outcomes.length > 0 ? edge.outcomes.join(t('tasks:or')) : t('tasks:flow.youSendBack')

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-0.5 px-0.5">
        <span className="flex min-w-0 items-center gap-1.5 text-ui font-medium text-primary">
          <Glyph icon={WORKFLOW_ICON} size={13} className="shrink-0 text-icon" />
          <span className="truncate">{workflowName(entry)}</span>
          <span className="shrink-0 text-meta font-normal text-tertiary">
            {t('workflow.suggest.steps', { count: workflow.steps.length })}
          </span>
        </span>
        {description && <span className="text-meta text-secondary">{description}</span>}
      </div>
      <div
        className="relative overflow-hidden rounded-lg bg-(--thread-card) shadow-[inset_0_0_0_0.5px_var(--color-border-soft)]"
        style={{ width: layout.width * scale, height: layout.height * scale }}
      >
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{ width: layout.width, height: layout.height, transform: `scale(${scale})` }}
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
                    strokeDasharray={edge.back ? '3 3' : undefined}
                  />
                  {!edge.join && (
                    <path d={headOf(points)} strokeWidth={1.2} strokeLinecap="round" />
                  )}
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
          {layout.edges
            .filter((edge) => edge.back || edge.points.length > 4)
            .map((edge) => {
              const [x, y] = laneMiddle(edge.points)
              return (
                <span
                  key={edge.id}
                  className="absolute -translate-1/2 rounded-[4px] bg-(--thread-card) px-1 text-[9.5px] leading-3.5 font-medium tracking-[0.3px] whitespace-nowrap text-(--thread-muted) uppercase"
                  style={{ left: x, top: y }}
                >
                  {label(edge)}
                </span>
              )
            })}
          {layout.nodes.map((node) => {
            const index = workflow.steps.findIndex((s) => s.id === node.id)
            const step = workflow.steps[index]!
            const source = stepSource(step, index, entry.pins, NO_PINS)
            const agent =
              source === 'first'
                ? firstAgentId
                : source === 'pinned'
                  ? entry.pins[step.id]!.agentId
                  : null
            const name = localStepName(workflow, step.id)
            return (
              <span
                key={node.id}
                title={name}
                className="absolute flex items-center gap-1.5 rounded-[8px] bg-card pr-2 pl-1 text-small font-medium text-(--thread-ink) shadow-(--thread-card-shadow)"
                style={{ left: node.x, top: node.y, width: MINI.nodeH, height: MINI.nodeW }}
              >
                <span className="grid size-5.5 shrink-0 place-items-center rounded-[6px] bg-(--thread-chip)">
                  {source === 'you' ? (
                    <Glyph icon={UserIcon} size={12} />
                  ) : agent ? (
                    <AgentMark agent={agent} size={12} hostId={hostId} />
                  ) : (
                    <Glyph icon={SparklesIcon} size={12} className="text-(--agent-violet)" />
                  )}
                </span>
                <span className="truncate">{name}</span>
              </span>
            )
          })}
          {layout.ends.map((end) => (
            <span
              key={end.end}
              title={t(`tasks:flow.end.${end.end}`)}
              className="absolute grid -translate-1/2 place-items-center rounded-full bg-card text-(--thread-faint) shadow-(--thread-card-shadow)"
              style={{ left: end.x, top: end.y, width: MINI.endSize, height: MINI.endSize }}
            >
              {end.end === 'done' ? (
                <Glyph icon={Tick02Icon} size={11} className="text-(--thread-done)" />
              ) : (
                <span className="size-1.5 rounded-[2px] bg-current" />
              )}
            </span>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-3 px-0.5 text-meta text-tertiary">
        <span className="min-w-0 truncate">
          {t('newSession.workflow.previewFoot', { pace: t(`workflow.paces.${pace}`) })}
        </span>
        <button
          type="button"
          className="ml-auto shrink-0 text-meta text-link hover:underline"
          onClick={() => openWorkflowMarketplace(entry.id)}
        >
          {t('workflow.pinEveryTask')}
        </button>
      </div>
    </div>
  )
}
