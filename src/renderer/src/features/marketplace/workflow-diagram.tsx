// A workflow drawn before any task runs through it: its steps in order from the left, those that
// run side by side stacked, what sends work back and how it ends, with who does each step. The
// chart the suggestion card and the task page draw, read-only and smaller, sized to the flow: a
// small one shows whole at full size, a large one is shrunk to fit and can be panned and zoomed.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/base.css'
import {
  Add01Icon,
  ArrowExpand01Icon,
  MinusSignIcon,
  SparklesIcon,
  Tick02Icon,
  UserIcon,
} from '@hugeicons/core-free-icons'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import {
  isBackArrow,
  outcomeName,
  stepName,
  type StepPick,
  type TaskEnd,
  type Workflow,
  type WorkflowStep,
} from '@shared/workflow'
import { Icon } from '@renderer/components/affect/app-shell'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import {
  headOf,
  intoJoin,
  laneMiddle,
  layoutFlow,
  pathOf,
  sideways,
  type FlowEdge,
  type FlowMetrics,
} from '@renderer/features/tasks/flow-layout'
import { textWidth } from '@renderer/features/tasks/wrapped-lines'

/**
 * On the task flowchart's layout turned to run from the left: `nodeH` is a step's width once
 * turned, `nodeW` its height, `rowGap` the room between columns and `colGap` between steps stacked
 * in one.
 */
const METRICS: FlowMetrics = {
  nodeW: 52,
  nodeH: 168,
  endSize: 24,
  colGap: 14,
  rowGap: 30,
  laneStart: 22,
  laneGap: 16,
  labelRoom: 0,
  slot: 12,
  inset: 16,
  bend: 14,
  pad: 14,
}
// A step's width: its padding, who does it and the gaps, around its widest line, within bounds.
const NODE_X = 10 + 28 + 10 + 10
const NODE_MIN_W = 108
const NODE_MAX_W = 248
/** The tallest the canvas grows; a longer flow is shrunk to fit, then panned. */
const MAX_HEIGHT = 640
/** A flow is shrunk no further than this to fit, so its names stay readable. */
const MIN_FIT = 0.6
/** Under a flow that needs its zoom controls at rest, room for them, so they cover none of it. */
const CONTROLS_ROOM = 36

type StepData = { step: WorkflowStep; name: string; line: string; pick: StepPick | null }
type EndData = { end: TaskEnd }
type ArrowData = { edge: FlowEdge; label: string | null; dashed: boolean }

const NODE_TYPES = { step: StepNode, end: EndNode }
const EDGE_TYPES = { flow: FlowArrow }

/**
 * The flow of `workflow` as a chart. `pins` are the agents the user fixed for its steps, which
 * show in place of Auto's mark.
 */
export default function WorkflowDiagram({
  workflow,
  pins,
}: {
  workflow: Workflow
  pins?: Record<string, StepPick>
}) {
  return (
    <ReactFlowProvider>
      <Canvas workflow={workflow} pins={pins} />
      <Legend workflow={workflow} />
    </ReactFlowProvider>
  )
}

function Canvas({ workflow, pins }: { workflow: Workflow; pins?: Record<string, StepPick> }) {
  const { t, i18n } = useTranslation(['marketplace', 'tasks'])
  const locale = i18n.language
  // A step you review says so on its node, so its send-back is not drawn as a loop.
  const drawn = useMemo(
    () => ({ ...workflow, steps: workflow.steps.map((step) => ({ ...step, youReview: false })) }),
    [workflow],
  )
  // Each step as wide as its words need, a column as its widest; longer words are cut, and whole
  // in its title.
  const lengths = useMemo(() => {
    const badge = textWidth(t('workflow.youReview'), 10.5, 500) + 10 + 10
    return new Map(
      workflow.steps.map((step) => {
        const words = Math.max(
          textWidth(stepName(workflow, step.id, locale), 13, 500),
          textWidth(stepLine(step, workflow, locale, t), 11.5, 400),
        )
        const extra = step.by === 'agent' && step.youReview ? badge : 0
        const width = Math.ceil(words + extra) + NODE_X
        return [step.id, Math.min(NODE_MAX_W, Math.max(NODE_MIN_W, width))]
      }),
    )
  }, [workflow, locale, t])
  const layout = useMemo(
    () => sideways(layoutFlow(drawn, METRICS, (id) => lengths.get(id) ?? METRICS.nodeH)),
    [drawn, lengths],
  )
  const nodes = useMemo<Node[]>(
    () => [
      ...layout.nodes.map((n) => {
        const step = workflow.steps.find((s) => s.id === n.id)!
        return {
          id: n.id,
          type: 'step',
          position: { x: n.x, y: n.y },
          width: n.length,
          height: METRICS.nodeW,
          data: {
            step,
            name: stepName(workflow, step.id, locale),
            line: stepLine(step, workflow, locale, t),
            pick: pins?.[step.id] ?? null,
          } satisfies StepData,
        }
      }),
      ...layout.ends.map((e) => ({
        id: `end:${e.end}`,
        type: 'end',
        position: { x: e.x - METRICS.endSize / 2, y: e.y - METRICS.endSize / 2 },
        width: METRICS.endSize,
        height: METRICS.endSize,
        data: { end: e.end } satisfies EndData,
      })),
    ],
    [layout, workflow, pins, locale, t],
  )
  const edges = useMemo<Edge[]>(
    () =>
      layout.edges.map((edge) => {
        const step = workflow.steps.find((s) => s.id === edge.from)!
        const name = edge.outcomes
          .map((o) => outcomeName(workflow, edge.from, o, locale))
          .join(t('tasks:or'))
        const limit =
          step.outcomes.find((o) => o.name === edge.outcomes[0])?.limit ?? workflow.sendBackLimit
        // An arrow to the early end runs above the steps like one back, so it is dashed as they are.
        const dashed = edge.back || edge.to === 'end:dropped'
        // Only the lanes are named, as on the task's chart; a forward arrow's gap is too short.
        const lane = edge.back || (edge.to === 'end:dropped' && edge.points.length > 4)
        const label = !lane
          ? null
          : edge.back
            ? `${name}${t('tasks:separator')}${t('tasks:flow.upTo', { limit })}`
            : name
        return {
          id: edge.id,
          source: edge.from,
          target: edge.to,
          type: 'flow',
          data: { edge, label, dashed } satisfies ArrowData,
        }
      }),
    [layout, workflow, locale, t],
  )

  const box = useRef<HTMLDivElement>(null)
  const flow = useReactFlow()
  const [width, setWidth] = useState(0)
  const fitZoom = width
    ? Math.max(MIN_FIT, Math.min(1, width / layout.width, MAX_HEIGHT / layout.height))
    : 1
  // The whole flow shows at rest, so only a larger one needs its controls.
  const cut = layout.width * fitZoom > width + 1 || layout.height * fitZoom > MAX_HEIGHT + 1
  const height =
    Math.min(MAX_HEIGHT, Math.ceil(layout.height * fitZoom)) + (cut ? CONTROLS_ROOM : 0)
  const fit = useCallback(() => {
    const el = box.current
    if (!el || !el.clientWidth) return
    // Centred when it fits; a wider one starts at its first step.
    const spare = el.clientWidth - layout.width * fitZoom
    void flow.setViewport({ x: Math.max(0, spare / 2), y: 0, zoom: fitZoom })
  }, [flow, layout, fitZoom])
  useEffect(() => {
    const el = box.current
    if (!el) return
    setWidth(el.clientWidth)
    const observer = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  // Placed again when the chart or its room changes; a pan or zoom stays until then.
  useEffect(fit, [fit])
  return (
    <div
      ref={box}
      role="group"
      aria-label={t('workflow.diagram.label', { name: workflow.name })}
      className="k-flow"
      style={{ height }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        minZoom={0.4}
        maxZoom={1.5}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        zoomOnScroll={false}
        zoomOnDoubleClick={false}
        // The page scrolls under the pointer; the chart moves only when dragged.
        panOnScroll={false}
        preventScrolling={false}
        proOptions={{ hideAttribution: true }}
      >
        <ZoomControls onFit={fit} quiet={!cut} />
      </ReactFlow>
    </div>
  )
}

function ZoomControls({ onFit, quiet }: { onFit: () => void; quiet: boolean }) {
  const { t } = useTranslation('tasks')
  const flow = useReactFlow()
  const actions = [
    { label: t('flow.zoomOut'), icon: MinusSignIcon, run: () => void flow.zoomOut() },
    { label: t('flow.zoomIn'), icon: Add01Icon, run: () => void flow.zoomIn() },
    { label: t('flow.fit'), icon: ArrowExpand01Icon, run: onFit },
  ]
  return (
    <Panel position="bottom-right" className="k-flow__zoom" data-quiet={quiet ? '' : undefined}>
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          aria-label={action.label}
          title={action.label}
          onClick={action.run}
        >
          <Icon icon={action.icon} size={14} />
        </button>
      ))}
    </Panel>
  )
}

function FlowArrow({ data }: EdgeProps) {
  const { edge, label, dashed } = data as ArrowData
  // Into a join the arrow stops at its dot.
  const { points, dot } = edge.join ? intoJoin(edge.points) : { points: edge.points, dot: null }
  const [x, y] = laneMiddle(edge.points)
  return (
    <>
      <BaseEdge
        path={pathOf(points, 10)}
        className="k-flow__line"
        data-dashed={dashed || undefined}
      />
      {!edge.join && <path d={headOf(points)} className="k-flow__head" />}
      {dot && <circle cx={dot[0]} cy={dot[1]} r={3.5} className="k-flow__join" />}
      {label && (
        <EdgeLabelRenderer>
          <span
            className="k-flow__label"
            style={{ transform: `translate(${x}px, ${y}px) translate(-50%, -50%)` }}
          >
            {label}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

function EndNode({ data }: NodeProps) {
  const { end } = data as EndData
  const { t } = useTranslation('marketplace')
  return (
    <div className="k-flow__end" data-end={end}>
      <Handle type="target" position={Position.Left} isConnectable={false} className="invisible!" />
      <span>{end === 'done' ? <Icon icon={Tick02Icon} size={12} /> : <i />}</span>
      <small>{t(`workflow.end.${end}`)}</small>
    </div>
  )
}

/** Who does a step: the person, the agent pinned for it, or Auto's spark. */
function Who({ step, pick }: { step: WorkflowStep; pick: StepPick | null }) {
  return (
    <span className="k-flow__who" data-you={step.by === 'you' ? '' : undefined}>
      {step.by === 'you' ? (
        <Icon icon={UserIcon} size={14} />
      ) : pick ? (
        <AgentMark agent={pick.agentId} size={14} dot={null} />
      ) : (
        <Icon icon={SparklesIcon} size={14} />
      )}
    </span>
  )
}

/** The line under a step's name: yours, the steps it reviews, or an agent's. */
function stepLine(
  step: WorkflowStep,
  workflow: Workflow,
  locale: string,
  t: TFunction<['marketplace', 'tasks']>,
): string {
  if (step.by === 'you') return t('workflow.diagram.yourStep')
  if (step.reviewOf.length > 0) {
    return t('tasks:flow.reviews', {
      steps: step.reviewOf.map((id) => stepName(workflow, id, locale)).join(t('tasks:and')),
    })
  }
  return t('workflow.diagram.agentStep')
}

function StepNode({ data }: NodeProps) {
  const { step, name, line, pick } = data as StepData
  const { t } = useTranslation('marketplace')
  return (
    <div
      className="k-flow__step"
      data-you={step.by === 'you' ? '' : undefined}
      title={`${name}\n${line}`}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} className="invisible!" />
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        className="invisible!"
      />
      <Who step={step} pick={pick} />
      <span className="k-flow__text">
        <b>{name}</b>
        <small>{line}</small>
      </span>
      {step.by === 'agent' && step.youReview && (
        <span className="k-workflow-you">{t('workflow.youReview')}</span>
      )}
    </div>
  )
}

/** What the marks and lines mean, only those this flow has. */
function Legend({ workflow }: { workflow: Workflow }) {
  const { t } = useTranslation('marketplace')
  const you = workflow.steps.some((step) => step.by === 'you' || step.youReview)
  // A step you review sends back with no line of its own, so only the arrows back are dashed.
  const back = workflow.steps.some((step) =>
    step.outcomes.some((o) => isBackArrow(workflow, step.id, o)),
  )
  const agents = workflow.steps.some((step) => step.by === 'agent')
  return (
    <ul className="k-flow-legend">
      {agents && (
        <li>
          <span className="k-flow__who">
            <Icon icon={SparklesIcon} size={12} />
          </span>
          {t('workflow.diagram.legendAgent')}
        </li>
      )}
      {you && (
        <li>
          <span className="k-flow__who" data-you="">
            <Icon icon={UserIcon} size={12} />
          </span>
          {t('workflow.diagram.legendYou')}
        </li>
      )}
      {back && (
        <li>
          <i className="k-flow-legend__dash" aria-hidden />
          {t('workflow.diagram.legendBack')}
        </li>
      )}
    </ul>
  )
}
