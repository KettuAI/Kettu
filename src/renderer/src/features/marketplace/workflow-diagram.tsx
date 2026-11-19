// A workflow drawn before any task runs through it: its steps in order, those that run side by
// side, where each outcome goes, what sends work back and how it ends, with who does each step.
// Read-only, on the task flowchart's layout and canvas, sized to the flow: a small one shows whole
// at full size, a large one is shrunk to fit and can be panned and zoomed.

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
import { useTranslation } from 'react-i18next'
import {
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
  layoutFlow,
  pathOf,
  type FlowEdge,
  type FlowMetrics,
} from '@renderer/features/tasks/flow-layout'

const METRICS: FlowMetrics = {
  nodeW: 212,
  nodeH: 58,
  endSize: 24,
  colGap: 20,
  rowGap: 52,
  laneStart: 26,
  laneGap: 18,
  labelRoom: 196,
  slot: 20,
  inset: 16,
  bend: 20,
  pad: 14,
}
/** The tallest the canvas grows; a longer flow is shrunk to fit, then panned. */
const MAX_HEIGHT = 640
/** A flow is shrunk no further than this to fit, so its names stay readable. */
const MIN_FIT = 0.6

type StepData = { step: WorkflowStep; name: string; reviews: string[]; pick: StepPick | null }
type EndData = { end: TaskEnd }
type ArrowData = { edge: FlowEdge; label: string | null }

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
  const layout = useMemo(() => layoutFlow(workflow, METRICS), [workflow])
  const nodes = useMemo<Node[]>(
    () => [
      ...layout.nodes.map((n) => {
        const step = workflow.steps.find((s) => s.id === n.id)!
        return {
          id: n.id,
          type: 'step',
          position: { x: n.x, y: n.y },
          width: METRICS.nodeW,
          height: METRICS.nodeH,
          data: {
            step,
            name: stepName(workflow, step.id, locale),
            reviews: step.reviewOf.map((id) => stepName(workflow, id, locale)),
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
    [layout, workflow, pins, locale],
  )
  const edges = useMemo<Edge[]>(
    () =>
      layout.edges.map((edge) => {
        const step = workflow.steps.find((s) => s.id === edge.from)!
        const name =
          edge.outcomes.length > 0 ? edge.outcomes.join(t('tasks:or')) : t('tasks:flow.youSendBack')
        const limit =
          step.outcomes.find((o) => o.name === edge.outcomes[0])?.limit ?? workflow.sendBackLimit
        // A step with one way on needs no word on its arrow.
        const label = edge.back
          ? `${name}${t('tasks:separator')}${t('tasks:flow.upTo', { limit })}`
          : step.outcomes.length > 1
            ? name
            : null
        return {
          id: edge.id,
          source: edge.from,
          target: edge.to,
          type: 'flow',
          data: { edge, label } satisfies ArrowData,
        }
      }),
    [layout, workflow, t],
  )

  const box = useRef<HTMLDivElement>(null)
  const flow = useReactFlow()
  const [width, setWidth] = useState(0)
  const fitZoom = width
    ? Math.max(MIN_FIT, Math.min(1, width / layout.width, MAX_HEIGHT / layout.height))
    : 1
  const height = Math.min(MAX_HEIGHT, Math.ceil(layout.height * fitZoom))
  const fit = useCallback(() => {
    const el = box.current
    if (!el || !el.clientWidth) return
    // The steps sit in the middle; the labels of arrows back, all at one side, do not pull them off it.
    const xs = layout.nodes.flatMap((n) => [n.x, n.x + METRICS.nodeW])
    const middle = (Math.min(...xs) + Math.max(...xs)) / 2
    const spare = el.clientWidth - layout.width * fitZoom
    const x = el.clientWidth / 2 - middle * fitZoom
    void flow.setViewport({
      x: spare > 0 ? Math.min(spare, Math.max(0, x)) : 0,
      y: 0,
      zoom: fitZoom,
    })
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
  // The whole flow shows at rest, so only a larger one needs its controls.
  const cut = layout.width * fitZoom > width + 1 || layout.height * fitZoom > MAX_HEIGHT + 1

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
  const { edge, label } = data as ArrowData
  const last = edge.points.at(-1)!
  // Into a join the arrow stops at its dot.
  const points = edge.join
    ? [...edge.points.slice(0, -1), [last[0], last[1] - 7] as [number, number]]
    : edge.points
  return (
    <>
      <BaseEdge
        path={pathOf(points, 12)}
        className="k-flow__line"
        data-back={edge.back || undefined}
      />
      {!edge.join && <path d={headOf(points)} className="k-flow__head" />}
      {edge.join && <circle cx={last[0]} cy={last[1] - 4} r={3.5} className="k-flow__join" />}
      {label && (
        <EdgeLabelRenderer>
          <span
            className="k-flow__label"
            data-back={edge.back || undefined}
            style={{
              transform: `translate(${edge.label[0]}px, ${edge.label[1]}px) translate(${
                edge.align === 'center' ? '-50%' : edge.align === 'start' ? '0' : '-100%'
              }, -50%)`,
            }}
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
      <Handle type="target" position={Position.Top} isConnectable={false} className="invisible!" />
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

function StepNode({ data }: NodeProps) {
  const { step, name, reviews, pick } = data as StepData
  const { t } = useTranslation(['marketplace', 'tasks'])
  const line =
    step.by === 'you'
      ? t('workflow.diagram.yourStep')
      : reviews.length > 0
        ? t('tasks:flow.reviews', { steps: reviews.join(t('tasks:and')) })
        : t('workflow.diagram.agentStep')
  return (
    <div className="k-flow__step" data-you={step.by === 'you' ? '' : undefined} title={name}>
      <Handle type="target" position={Position.Top} isConnectable={false} className="invisible!" />
      <Handle
        type="source"
        position={Position.Bottom}
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
  const back = workflow.steps.some(
    (step, at) =>
      step.youReview ||
      step.outcomes.some((o) =>
        o.to.some((to) => workflow.steps.findIndex((s) => s.id === to) <= at),
      ),
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
