// An SOP as a flowchart: its nodes in columns, arrows forward as solid curves, arrows back as
// dashed lines under the chart, and an end mark for each outcome that ends the task. With a
// task's runs, each node says where it stands and the arrows taken are darker.

import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { sopGraph } from '@shared/sop-graph'
import type { NodeRunView, SopOutline, TaskView } from '@shared/tasks'
import { runningFor } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/use-now'
import { hostKey, useTasksStore } from '@renderer/stores/tasks'
import {
  END_HEIGHT,
  END_WIDTH,
  flowLayout,
  NODE_HEIGHT,
  NODE_WIDTH,
  type FlowArrow,
} from './flow-geometry'
import {
  edgeTaken,
  nodeOf,
  nodeStatuses,
  outcomeName,
  takenOutcomes,
  type NodeStatus,
  type OutlineNode,
} from './model'
import { useAgentLine } from './use-model-name'
import './tasks.css'

const NONE_TAKEN: ReadonlySet<string> = new Set()
const TIP = 'M0 0L-7 -3.5L-7 3.5Z'

export function SopFlow({
  outline,
  hostId,
  task,
  runs,
  selected,
  onSelect,
}: {
  outline: SopOutline
  hostId: string | null
  /** With its runs, the chart shows where each node stands. */
  task?: TaskView
  /** Newest first. */
  runs?: readonly NodeRunView[]
  selected?: string
  onSelect?: (nodeId: string) => void
}) {
  const { t } = useTranslation('tasks')
  const graph = useMemo(() => sopGraph(outline), [outline])
  const layout = useMemo(() => flowLayout(outline, graph), [outline, graph])
  const statuses = useMemo(
    () => (task && runs ? nodeStatuses(task, runs, graph) : null),
    [task, runs, graph],
  )
  const taken = useMemo(() => (runs ? takenOutcomes(runs) : NONE_TAKEN), [runs])

  // Nodes that have not run name the agent their tier stands for.
  useEffect(() => {
    const shown = useTasksStore.getState().tiers[hostKey(hostId)]
    if (!shown?.value && !shown?.loading) void useTasksStore.getState().loadTiers(hostId)
  }, [hostId])

  return (
    <div className="k-flow" role="group" aria-label={t('flow.label')}>
      <div className="k-flow__canvas" style={{ width: layout.width, height: layout.height }}>
        <svg className="k-flow__arrows" width={layout.width} height={layout.height} aria-hidden>
          {layout.arrows.map((arrow) => (
            <Arrow
              key={`${arrow.from}/${arrow.outcome}/${arrow.to ?? ''}`}
              arrow={arrow}
              node={nodeOf(outline, arrow.from)}
              taken={edgeTaken(taken, arrow)}
            />
          ))}
        </svg>
        {layout.boxes.map((box) => {
          const node = nodeOf(outline, box.id)
          if (!node) return null
          return (
            <FlowNode
              key={box.id}
              node={node}
              hostId={hostId}
              status={statuses?.[box.id] ?? null}
              x={box.x}
              y={box.y}
              selected={selected === box.id}
              onSelect={onSelect}
            />
          )
        })}
        {layout.ends.map((end) => (
          <span
            key={`${end.from}/${end.outcome}`}
            className="k-flow__end"
            data-end={end.end}
            data-taken={edgeTaken(taken, end) || undefined}
            style={{ left: end.x, top: end.y, width: END_WIDTH, height: END_HEIGHT }}
          >
            {t(`flow.end.${end.end}`)}
          </span>
        ))}
      </div>
    </div>
  )
}

function Arrow({
  arrow,
  node,
  taken,
}: {
  arrow: FlowArrow
  node: OutlineNode | null
  taken: boolean
}) {
  // One outcome needs no name: it is the only way on.
  const label = node && node.outcomes.length > 1 ? outcomeName(node, arrow.outcome) : null
  return (
    <g
      className="k-flow__arrow"
      data-back={arrow.back || undefined}
      data-taken={taken || undefined}
    >
      <path className="k-flow__line" d={arrow.path} />
      <path
        className="k-flow__tip"
        d={TIP}
        transform={`translate(${arrow.tip.x} ${arrow.tip.y}) rotate(${arrow.tip.angle})`}
      />
      {label && (
        <text className="k-flow__label" x={arrow.label.x} y={arrow.label.y}>
          {label}
        </text>
      )}
    </g>
  )
}

function FlowNode({
  node,
  hostId,
  status,
  x,
  y,
  selected,
  onSelect,
}: {
  node: OutlineNode
  hostId: string | null
  status: NodeStatus | null
  x: number
  y: number
  selected: boolean
  onSelect?: (nodeId: string) => void
}) {
  const { t } = useTranslation('tasks')
  const who = useWho(node, status, hostId)
  const body = (
    <>
      <b className="k-flow__name" title={node.name}>
        {node.name}
      </b>
      <span className="k-flow__who" title={who}>
        {who}
      </span>
      {node.by.kind === 'agent' && (
        <span className="k-flow__hand">{t(`node.handIn.${node.handIn}`)}</span>
      )}
      {status && <NodeState node={node} status={status} />}
    </>
  )
  const style = { left: x, top: y, width: NODE_WIDTH, height: NODE_HEIGHT }
  if (!onSelect) {
    return (
      <div className="k-flow__node" data-mark={status?.mark} style={style}>
        {body}
      </div>
    )
  }
  return (
    <button
      type="button"
      className="k-flow__node"
      data-mark={status?.mark}
      aria-pressed={selected}
      style={style}
      onClick={() => onSelect(node.id)}
    >
      {body}
    </button>
  )
}

/** Who does the node: the person, the agent of its latest run, or the one its tier stands for. */
function useWho(node: OutlineNode, status: NodeStatus | null, hostId: string | null): string {
  const { t } = useTranslation('tasks')
  const tier = node.by.kind === 'agent' ? node.by.tier : null
  const pick = useTasksStore((s) =>
    tier ? (s.tiers[hostKey(hostId)]?.value?.agents[tier] ?? null) : null,
  )
  const run = status?.run?.agentId ? status.run : null
  const line = useAgentLine(
    run?.agentId ?? pick?.agentId ?? null,
    run ? run.model : (pick?.model ?? null),
    hostId,
  )
  if (!tier) return t('node.you')
  return line ?? t(`settings.tier.${tier}`)
}

function NodeState({ node, status }: { node: OutlineNode; status: NodeStatus }) {
  const { t } = useTranslation('tasks')
  const now = useNow()
  const { mark, run } = status
  const text =
    mark === 'working' && run
      ? t('node.state.working', { time: runningFor(now - run.startedAt) })
      : mark === 'done' && run?.outcome && node.outcomes.length > 1
        ? outcomeName(node, run.outcome)
        : t(`node.state.${mark}`)
  return (
    <span className="k-flow__state">
      {run && run.round > 1 ? `${t('node.round', { round: run.round })} · ${text}` : text}
    </span>
  )
}
