import { useMemo } from 'react'
import { SparklesIcon, Tick02Icon, UserIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { Pace, Workflow, WireWorkflowEntry } from '@shared/workflow'
import type { AgentId } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import type { FlowEdge, FlowMetrics } from '@renderer/features/tasks/flow-layout'
import { outcomeTitle } from '@renderer/features/tasks/model'
import { SidewaysFlow } from '@renderer/features/tasks/sideways-flow'
import { Phrase } from '@renderer/features/tasks/phrase'
import { wrappedLines } from '@renderer/features/tasks/wrapped-lines'
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
// A tile's room beside its name (padding, mark and gap), and its name's type: 12 px at 500 on a
// 16 px line, on at most two lines.
const TILE_X = 4 + 22 + 6 + 8
const TILE_Y = 8
const NAME = { size: 12, weight: 500, line: 16 }
/** The widest a chart is drawn before it is shrunk to fit the card. */
const MAX_W = 600
const NO_PINS = {}

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
  const description = workflow.locales[i18n.language]?.description ?? workflow.description
  const label = (edge: FlowEdge) =>
    edge.outcomes.length > 0
      ? edge.outcomes.map((o) => outcomeTitle(workflow, edge.from, o)).join(t('tasks:or'))
      : t('tasks:flow.youSendBack')
  // As tall as the longest name needs, so no name is cut off.
  const metrics = useMemo(() => {
    const lines = Math.max(
      1,
      ...workflow.steps.map((step) =>
        Math.min(
          2,
          wrappedLines(
            localStepName(workflow, step.id),
            NAME.size,
            NAME.weight,
            MINI.nodeH - TILE_X,
          ),
        ),
      ),
    )
    return { ...MINI, nodeW: Math.max(MINI.nodeW, TILE_Y + lines * NAME.line) }
  }, [workflow])

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
      <SidewaysFlow
        workflow={workflow}
        metrics={metrics}
        scale={(width) => MAX_W / width}
        labelOf={(edge) => (edge.back || edge.points.length > 4 ? label(edge) : null)}
        labelClassName="text-[9.5px] tracking-[0.3px] uppercase"
        className="overflow-hidden rounded-lg bg-(--thread-card) shadow-[inset_0_0_0_0.5px_var(--color-border-soft)]"
        step={(step, index) => {
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
              title={name}
              className="flex size-full items-center gap-1.5 rounded-[8px] bg-card pr-2 pl-1 text-small font-medium text-(--thread-ink) shadow-(--thread-card-shadow)"
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
              <span className="line-clamp-2 leading-4 break-keep break-words">
                <Phrase text={name} />
              </span>
            </span>
          )
        }}
        end={(end) => (
          <span
            title={t(`tasks:flow.end.${end}`)}
            className="grid size-full place-items-center rounded-full bg-card text-(--thread-faint) shadow-(--thread-card-shadow)"
          >
            {end === 'done' ? (
              <Glyph icon={Tick02Icon} size={11} className="text-(--thread-done)" />
            ) : (
              <span className="size-1.5 rounded-[2px] bg-current" />
            )}
          </span>
        )}
      />
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
