import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowRight01Icon,
  BookOpen01Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  DashboardSpeed01Icon,
  File01Icon,
  Folder01Icon,
  GitBranchIcon,
  PlugSocketIcon,
  SparklesIcon,
  Tick02Icon,
  UserIcon,
} from '@hugeicons/core-free-icons'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { keptTool, type StartItem, type StartProgress, type SuggestedTool } from '@shared/workflow'
import type { Workflow, WorkflowStep, WorkflowSuggestion } from '@shared/workflow'
import type { AgentId, ToolEntry } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import { Icon } from '@renderer/components/affect/app-shell'
import { ApprovalCard } from '@renderer/components/affect/approval-card'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import { ConnectButton } from '@renderer/features/marketplace/connect'
import { useConnection } from '@renderer/features/marketplace/hooks'
import { InstallButton } from '@renderer/features/marketplace/listing'
import { Glyph } from '@renderer/features/shell/glyph'
import {
  layoutFlow,
  sideways,
  type FlowEdge,
  type FlowMetrics,
} from '@renderer/features/tasks/flow-layout'
import { whoPicksText } from '@renderer/features/tasks/model'
import { SidewaysFlow } from '@renderer/features/tasks/sideways-flow'
import { count, runningFor } from '@renderer/lib/format'
import { errorMessage, hostAt } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { HostScopeContext, hostScope, LOCAL_SCOPE, useHostScope } from '@renderer/stores/host-scope'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { useTasksStore } from '@renderer/stores/tasks'
import { useSuggestion, useSuggestionsStore } from '@renderer/stores/workflow-suggestions'
import { openTask, openWorkflowMarketplace } from '../new-session/open-task'
import { listOf, localStepName, WORKFLOW_ICON } from '../new-session/workflow-picks'
import { useSessionView } from '../use-thread'
import { revealWaiting } from './helpers'
import { cardIdOf } from './workflow-tools'

/** Steps from the left, each a tile with who does it, its name and one line under it. */
const METRICS: FlowMetrics = {
  nodeW: 44,
  nodeH: 136,
  endSize: 18,
  colGap: 10,
  rowGap: 26,
  laneStart: 20,
  laneGap: 16,
  labelRoom: 0,
  slot: 10,
  inset: 12,
  bend: 8,
  pad: 14,
}
/** Narrower steps for a long chart, so it shrinks less to fit. */
const NARROW: FlowMetrics = { ...METRICS, nodeH: 112, rowGap: 22 }
/** A chart is shrunk to fit the card, but no further than this, so its names stay readable. */
const MIN_FIT = 0.66

/**
 * The host's card for a suggestion or a workflow to keep, in the session's host's scope, so the
 * tools it names connect and install on that host.
 */
export function SuggestionCard({
  sessionId,
  entry,
  agent,
}: {
  sessionId: string
  entry: ToolEntry
  agent: string
}) {
  const projectPath = useSessionsStore((s) => s.byId[sessionId]?.projectPath)
  const hostId = projectPath ? hostOfSession({ projectPath }) : null
  const card = useSuggestion(cardIdOf(entry), sessionId, hostId)
  if (!card) return null
  return (
    <HostScopeContext.Provider value={hostId === null ? LOCAL_SCOPE : hostScope(hostId)}>
      <Card card={card} agent={agent} />
    </HostScopeContext.Provider>
  )
}

function Card({ card, agent }: { card: WorkflowSuggestion; agent: string }) {
  const answer = card.answer
  const pressed = useSuggestionsStore((s) => s.pressed[card.id] === true)
  const taskId = answer.kind === 'started' ? answer.taskId : null
  // The window that pressed Start opens the task once it started.
  useEffect(() => {
    if (!taskId || !pressed) return
    useSuggestionsStore.setState((s) => {
      const rest = { ...s.pressed }
      delete rest[card.id]
      return { pressed: rest }
    })
    openTask(taskId)
  }, [taskId, pressed, card.id])

  switch (answer.kind) {
    case 'started':
      return <StartedLine card={card} taskId={answer.taskId} />
    case 'declined':
      return <DeclinedLine card={card} />
    case 'saved':
      return <SavedLine card={card} workflowId={answer.workflowId} />
    case 'not_saved':
      return <NotSavedLine card={card} />
    default:
      return <Pending card={card} agent={agent} />
  }
}

function nameOf(workflow: Workflow, language: string): string {
  return workflow.locales[language]?.name ?? workflow.name
}

/** The ways a tool stands on this host: kept and on, connected when it signs in. */
function useToolState(tool: SuggestedTool) {
  const { useSettingsStore } = useHostScope()
  const kept = useSettingsStore((s) =>
    tool.kind === 'mcp'
      ? (keptTool(s.settings.marketplace.mcp, tool.ref) ?? null)
      : (keptTool(s.settings.marketplace.skills, tool.ref) ?? null),
  )
  const server = tool.kind === 'mcp' && kept && 'spec' in kept ? kept : null
  const connection = useConnection(server?.id ?? '')
  const on = kept?.on === true
  const ready =
    tool.setup === 'none' ||
    (tool.setup === 'keys' && on) ||
    (tool.setup === 'sign-in' && on && connection?.state === 'connected')
  return { kept, server, on, ready }
}

// The card while it waits, starts or stopped on a failure.

function Pending({ card, agent }: { card: WorkflowSuggestion; agent: string }) {
  const { t, i18n } = useTranslation('session')
  const root = useRef<HTMLDivElement>(null)
  const scope = useHostScope()
  const config = useSessionView(card.sessionId)?.config
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState(false)
  const [blocked, setBlocked] = useState<string[]>([])
  const answer = card.answer
  const save = card.purpose === 'save'
  const starting = answer.kind === 'starting'
  const failed = answer.kind === 'failed'
  const waiting = answer.kind === 'waiting'
  const name = nameOf(card.workflow, i18n.language)

  useEffect(() => revealWaiting(root.current), [])
  // Sign-in states are read once a tool needs one.
  const signs = card.tools.some((tool) => tool.setup === 'sign-in')
  useEffect(() => {
    if (!signs) return
    const store = scope.useMarketplaceStore.getState()
    if (store.connections === null) void store.loadConnections()
  }, [signs, scope])

  const answerWith = async (kind: 'start' | 'decline' | 'another' | 'save' | 'not_save') => {
    setError(null)
    // The first step goes on as this session does: its agent and its values but the mode, which
    // Kettu sets for every step.
    const options =
      kind === 'start'
        ? Object.fromEntries(
            (config ?? []).filter((o) => o.category !== 'mode').map((o) => [o.id, o.value]),
          )
        : undefined
    if (kind === 'start') {
      useSuggestionsStore.setState((s) => ({ pressed: { ...s.pressed, [card.id]: true } }))
    }
    try {
      const view = await hostAt(scope.hostId, 'workflows.answerSuggestion', {
        id: card.id,
        answer: kind,
        ...(options ? { options } : {}),
      })
      useSuggestionsStore.getState().receive(view)
    } catch (caught) {
      setError(errorMessage(caught))
      throw caught
    }
  }

  const label = save
    ? t('workflow.card.labelSave', { agent })
    : starting
      ? t('workflow.card.label', { agent })
      : t('workflow.card.labelWaiting', { agent })
  const addsIt = card.source.kind === 'marketplace' && card.approves
  const note = starting
    ? t('workflow.card.starting')
    : failed
      ? t('workflow.card.retryNote')
      : blocked.length > 0
        ? t('workflow.card.connectFirst', { names: listOf(blocked) })
        : save
          ? t('workflow.card.saveNote')
          : card.approves
            ? card.source.kind === 'draft'
              ? t('workflow.card.approvesWritten')
              : t('workflow.card.approvesVersion')
            : null

  return (
    <div ref={root} className="min-w-0">
      <ApprovalCard
        className="ks-suggest"
        title={save ? t('workflow.card.saveTitle', { name }) : t('workflow.card.title')}
        description={<Summary card={card} />}
        icon={<Icon icon={WORKFLOW_ICON} size={15} />}
        label={label}
        approveLabel={
          save
            ? t('workflow.card.save')
            : failed
              ? t('workflow.card.retry')
              : addsIt
                ? t('workflow.card.addAndStart')
                : t('workflow.card.start')
        }
        denyLabel={save ? t('workflow.card.notNow') : t('workflow.card.doItHere')}
        editLabel={t('workflow.card.edit')}
        onEdit={waiting ? () => emitAppEvent({ kind: 'focus-composer' }) : undefined}
        allowAlways={false}
        shortcuts
        status="pending"
        note={note && <span className={cn(blocked.length > 0 && 'text-warning')}>{note}</span>}
        approveDisabled={waiting && blocked.length > 0}
        hideActions={starting}
        onApprove={() => answerWith(save ? 'save' : 'start')}
        onDeny={() => void answerWith(save ? 'not_save' : 'decline').catch(() => undefined)}
        preview={
          <div className="flex min-w-0 flex-col gap-3">
            <Chart card={card} agent={agent} />
            {save ? <SaveFacts card={card} /> : !failed && !starting && <Facts card={card} />}
            {waiting && card.tools.length > 0 && !save && (
              <Tools tools={card.tools} onBlocked={setBlocked} />
            )}
            {(starting || failed) && <Progress items={answer.items} />}
            {waiting && (
              <Details
                card={card}
                agent={agent}
                onFile={() => setFile(true)}
                onAnother={
                  save ? undefined : () => void answerWith('another').catch(() => undefined)
                }
              />
            )}
          </div>
        }
      />
      {error && (
        <p role="alert" className="ks-card-error">
          {error}
        </p>
      )}
      <FileDialog card={card} open={file} onClose={() => setFile(false)} />
    </div>
  )
}

/** The line under the title: how many steps, what the user sees and what another agent does. */
function Summary({ card }: { card: WorkflowSuggestion }) {
  const { t } = useTranslation('session')
  const steps = card.workflow.steps
  const named = (list: WorkflowStep[]) =>
    listOf(list.map((s) => localStepName(card.workflow, s.id)))
  if (card.purpose === 'save') {
    return <>{t('workflow.card.saveSummary', { count: steps.length })}</>
  }
  const seen = steps.filter((s) => s.by === 'agent' && s.youReview)
  const yours = steps.filter((s) => s.by === 'you')
  const reviews = steps.filter((s) => s.reviewOf.length > 0)
  const parts = [
    t('workflow.card.steps', { count: steps.length }),
    seen.length > 0 ? t('workflow.card.youSee', { steps: named(seen) }) : null,
    yours.length > 0 ? t('workflow.card.youDo', { steps: named(yours) }) : null,
    reviews.length > 0 ? t('workflow.card.otherAgent', { steps: named(reviews) }) : null,
  ]
  return <>{parts.filter(Boolean).join(t('workflow.card.comma'))}</>
}

// The flowchart.

function Chart({ card, agent }: { card: WorkflowSuggestion; agent: string }) {
  const { t } = useTranslation(['session', 'tasks'])
  const box = useRef<HTMLDivElement>(null)
  const [room, setRoom] = useState(0)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    setRoom(el.clientWidth)
    const observer = new ResizeObserver(() => setRoom(el.clientWidth))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  // A step the user sees says so on its tile, so its send-back is not drawn as a loop.
  const drawn = useMemo(
    () => ({
      ...card.workflow,
      steps: card.workflow.steps.map((step) => ({ ...step, youReview: false })),
    }),
    [card.workflow],
  )
  const metrics = useMemo(
    () => (room > 0 && sideways(layoutFlow(drawn, METRICS)).width * 0.85 > room ? NARROW : METRICS),
    [drawn, room],
  )
  // Only the lanes are named, where there is room; a forward arrow's gap is too short.
  const label = (edge: FlowEdge): string | null =>
    (edge.back || (edge.to === 'end:dropped' && edge.points.length > 4)) && edge.outcomes.length > 0
      ? edge.outcomes.join(t('tasks:or'))
      : null
  return (
    <div
      ref={box}
      className="flex min-w-0 overflow-x-auto rounded-xl bg-(--bg-code-block) bg-[radial-gradient(var(--thread-line-strong)_0.8px,transparent_1px)] bg-size-[14px_14px] px-2 py-1"
    >
      {room > 0 && (
        <SidewaysFlow
          workflow={drawn}
          metrics={metrics}
          scale={(width) => Math.max(MIN_FIT, (room - 20) / width)}
          labelOf={label}
          labelClassName="bg-(--bg-code-block)"
          // Centred by its margins, so a chart wider than the card scrolls from its start.
          className="mx-auto shrink-0"
          step={(_, index) => (
            <StepTile card={card} step={card.workflow.steps[index]!} index={index} agent={agent} />
          )}
          end={(end) => (
            <span className="relative grid size-full place-items-center rounded-full bg-card text-(--thread-faint) shadow-(--thread-card-shadow)">
              {end === 'done' ? (
                <Glyph icon={Tick02Icon} size={11} className="text-(--thread-done)" />
              ) : (
                <span className="size-1.5 rounded-[2px] bg-current" />
              )}
              {end === 'done' && (
                <span className="absolute top-[calc(100%+3px)] text-[10px] whitespace-nowrap text-(--thread-muted)">
                  {t('tasks:flow.end.done')}
                </span>
              )}
            </span>
          )}
        />
      )}
    </div>
  )
}

/** The line under a step's name: what the user does there, a second agent, or its tools. */
function stepLine(
  card: WorkflowSuggestion,
  step: WorkflowStep,
  index: number,
  t: TFunction<'session'>,
): { text: string; you: boolean } | null {
  if (step.by === 'you') return { text: t('workflow.card.node.yours'), you: true }
  if (step.youReview) {
    return {
      text: t(index === 0 ? 'workflow.card.node.firstSee' : 'workflow.card.node.see'),
      you: true,
    }
  }
  if (step.reviewOf.length > 0) return { text: t('workflow.card.node.other'), you: false }
  const tools = toolTitles(card, step)
  if (tools.length > 0)
    return { text: t('workflow.card.node.uses', { tools: listOf(tools) }), you: false }
  return null
}

function toolTitles(card: WorkflowSuggestion, step: WorkflowStep): string[] {
  const named = [
    ...step.tools.skills.map((ref) => ({ kind: 'skill' as const, ref })),
    ...step.tools.mcp.map((ref) => ({ kind: 'mcp' as const, ref })),
  ]
  return named.map(
    (n) => card.tools.find((tool) => tool.kind === n.kind && tool.ref === n.ref)?.title ?? n.ref,
  )
}

function StepTile({
  card,
  step,
  index,
  agent,
}: {
  card: WorkflowSuggestion
  step: WorkflowStep
  index: number
  agent: string
}) {
  const { t } = useTranslation('session')
  const scope = useHostScope()
  const name = localStepName(card.workflow, step.id)
  const line = stepLine(card, step, index, t)
  const tools = toolTitles(card, step)
  const who =
    step.by === 'you'
      ? t('workflow.card.tip.yours')
      : index === 0
        ? t('workflow.card.tip.first', { agent })
        : t('workflow.card.tip.picks', {
            who: whoPicksText({ workflow: card.workflow, pins: {} }, step.id),
          })
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={250}
        closeDelay={0}
        render={
          <span
            tabIndex={0}
            className="flex size-full min-w-0 cursor-default items-center gap-2 rounded-[9px] bg-card px-2 shadow-(--thread-card-shadow) outline-none focus-visible:ring-[1.5px] focus-visible:ring-(--focus)"
          />
        }
      >
        <WhoMark step={step} index={index} agentId={card.agentId} hostId={scope.hostId} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-small leading-4 font-medium text-(--thread-ink)">
            {name}
          </span>
          {line && (
            <span
              className={cn(
                'truncate text-[11px] leading-3.5',
                line.you ? 'text-warning' : 'text-(--thread-muted)',
              )}
            >
              {line.text}
            </span>
          )}
        </span>
      </HoverCardTrigger>
      <HoverCardContent side="bottom" align="start" sideOffset={6} className="w-72 p-3">
        <div className="flex flex-col gap-1.5 text-meta leading-relaxed">
          <span className="text-ui font-medium text-primary">{name}</span>
          {step.prompt && (
            <span className="line-clamp-5 whitespace-pre-line text-secondary">{step.prompt}</span>
          )}
          {step.youReview && step.by === 'agent' && (
            <span className="text-secondary">{t('workflow.card.tip.see')}</span>
          )}
          {tools.length > 0 && (
            <span className="text-secondary">
              {t('workflow.card.node.uses', { tools: listOf(tools) })}
            </span>
          )}
          <span className="text-tertiary">{who}</span>
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}

/** Who does a step: the user, this session's agent for the first, or the spark of a pick to come. */
function WhoMark({
  step,
  index,
  agentId,
  hostId,
}: {
  step: WorkflowStep
  index: number
  agentId: AgentId
  hostId: string | null
}) {
  return (
    <span
      className={cn(
        'grid size-6 shrink-0 place-items-center rounded-[7px]',
        step.by === 'you' ? 'bg-warning-tint text-warning' : 'bg-(--thread-chip)',
      )}
    >
      {step.by === 'you' ? (
        <Glyph icon={UserIcon} size={12} />
      ) : index === 0 ? (
        <AgentMark agent={agentId} size={12} hostId={hostId} />
      ) : (
        <Glyph icon={SparklesIcon} size={12} className="text-(--agent-violet)" />
      )}
    </span>
  )
}

// What it costs and where it works.

function Fact({ icon, children }: { icon: typeof Clock01Icon; children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Glyph icon={icon} size={13} className="shrink-0 text-tertiary" />
      <span className="truncate">{children}</span>
    </span>
  )
}

/** "About 40 m": five minutes under an hour, a quarter of one above. */
function rough(ms: number): string {
  const minutes = ms / 60_000
  const step = minutes < 60 ? 5 : 15
  return runningFor(Math.max(step, Math.round(minutes / step) * step) * 60_000)
}

function Facts({ card }: { card: WorkflowSuggestion }) {
  const { t } = useTranslation('session')
  const steps = card.workflow.steps
  const agents = steps.filter((s) => s.by === 'agent').length
  const branches = steps.some((s) => s.outcomes.some((o) => o.to.length > 1))
  const { pastMs, worktree } = card.facts
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-meta text-secondary">
      <Fact icon={Clock01Icon}>
        {pastMs === null
          ? t('workflow.card.firstRun')
          : t('workflow.card.about', { time: rough(pastMs) })}
      </Fact>
      <Fact icon={DashboardSpeed01Icon}>
        {agents > 6 || branches ? t('workflow.card.usesMuchMore') : t('workflow.card.usesMore')}
      </Fact>
      {worktree !== null && (
        <Fact icon={worktree ? GitBranchIcon : Folder01Icon}>
          {worktree ? t('workflow.card.worktree') : t('workflow.card.projectFolder')}
        </Fact>
      )}
    </div>
  )
}

function SaveFacts({ card }: { card: WorkflowSuggestion }) {
  const { t } = useTranslation('session')
  const steps = card.workflow.steps
  const waits = steps.filter((s) => s.by === 'you' || s.youReview).length
  const agents = steps.filter((s) => s.by === 'agent').length
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-meta text-secondary">
      <Fact icon={SparklesIcon}>{t('workflow.card.agentSteps', { count: agents })}</Fact>
      {waits > 0 && <Fact icon={UserIcon}>{t('workflow.card.waits', { count: waits })}</Fact>}
      {card.tools.length > 0 && (
        <Fact icon={PlugSocketIcon}>
          {t('workflow.card.node.uses', { tools: listOf(card.tools.map((tool) => tool.title)) })}
        </Fact>
      )}
    </div>
  )
}

// The tools it needs.

function Tools({
  tools,
  onBlocked,
}: {
  tools: SuggestedTool[]
  onBlocked: (names: string[]) => void
}) {
  const [blocked, setBlocked] = useState<Record<string, boolean>>({})
  const names = tools.filter((tool) => blocked[tool.ref]).map((tool) => tool.title)
  const key = names.join('\n')
  useEffect(() => onBlocked(key ? key.split('\n') : []), [key, onBlocked])
  return (
    <div className="flex flex-col gap-1.5 border-t border-(--thread-line) pt-3 empty:hidden">
      {tools.map((tool) => (
        <ToolRow
          key={`${tool.kind}:${tool.ref}`}
          tool={tool}
          onReady={(ready) =>
            setBlocked((current) =>
              current[tool.ref] === !ready ? current : { ...current, [tool.ref]: !ready },
            )
          }
        />
      ))}
    </div>
  )
}

function ToolRow({ tool, onReady }: { tool: SuggestedTool; onReady: (ready: boolean) => void }) {
  const { t } = useTranslation('session')
  const { kept, server, on, ready } = useToolState(tool)
  useEffect(() => onReady(ready), [ready, onReady])
  let end: ReactNode
  if (tool.setup === 'sign-in' && !ready) {
    const target = server ?? tool.server
    end = (
      <>
        <span className="text-warning">{t('workflow.card.tool.signIn')}</span>
        {target && <ConnectButton server={target} kept={server} />}
      </>
    )
  } else if (tool.setup === 'keys' && !ready) {
    end = (
      <>
        <span className="text-warning">{t('workflow.card.tool.keys')}</span>
        {tool.server && <InstallButton server={tool.server} />}
      </>
    )
  } else if (tool.setup === 'sign-in') {
    end = <span className="text-success">{t('workflow.card.tool.connected')}</span>
  } else if (kept && on) {
    // Installed and on: nothing to do about it.
    return null
  } else {
    end = <span className="text-tertiary">{t('workflow.card.tool.atStart')}</span>
  }
  return (
    <div className="flex min-h-8 min-w-0 items-center gap-2.5 text-ui">
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-card text-secondary shadow-outline">
        <Glyph icon={tool.kind === 'mcp' ? PlugSocketIcon : BookOpen01Icon} size={14} />
      </span>
      <span className="shrink-0 font-medium text-primary">{tool.title}</span>
      <span className="min-w-0 truncate text-meta text-tertiary">
        {[t(`workflow.card.tool.${tool.kind}`), tool.description].filter(Boolean).join(' · ')}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-2 text-meta">{end}</span>
    </div>
  )
}

// Start's progress.

function itemText(item: StartItem, t: TFunction<'session'>): string {
  switch (item.kind) {
    case 'connected':
      return t('workflow.card.item.connected', { name: item.title })
    case 'add':
      return t('workflow.card.item.add', { name: item.name })
    case 'install':
      return t(`workflow.card.item.install.${item.tool}`, { name: item.title })
    case 'start':
      return t('workflow.card.item.start', { step: item.step })
  }
}

function Progress({ items }: { items: StartProgress[] }) {
  const { t } = useTranslation('session')
  const stopped = items.findIndex((p) => p.state === 'failed')
  return (
    <ul className="flex flex-col gap-2.5 rounded-xl bg-(--bg-code-block) px-3.5 py-3 text-ui">
      {items.map((progress, i) => (
        <li
          key={i}
          className={cn(
            'flex min-w-0 items-center gap-2.5',
            stopped >= 0 && i > stopped ? 'text-tertiary' : 'text-primary',
          )}
        >
          <span className="grid size-4 shrink-0 place-items-center">
            {progress.state === 'done' ? (
              <Glyph icon={CheckmarkCircle02Icon} size={15} className="text-success" />
            ) : progress.state === 'failed' ? (
              <Glyph icon={CancelCircleIcon} size={15} className="text-danger" />
            ) : progress.state === 'running' ? (
              <span className="ui-as-spinner" aria-hidden />
            ) : (
              <span className="size-3 rounded-full border border-(--thread-line-strong)" />
            )}
          </span>
          <span className="max-w-full shrink-0 truncate">{itemText(progress.item, t)}</span>
          {progress.item.kind === 'add' && (
            <span className="shrink-0 text-meta text-tertiary">
              {t('workflow.card.version', { version: progress.item.version })}
            </span>
          )}
          {progress.state === 'failed' && progress.error && (
            <span className="min-w-0 flex-1 truncate text-meta text-danger" title={progress.error}>
              {progress.error}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

// The folded details.

function Details({
  card,
  agent,
  onFile,
  onAnother,
}: {
  card: WorkflowSuggestion
  agent: string
  onFile: () => void
  onAnother: (() => void) | undefined
}) {
  const { t, i18n } = useTranslation('session')
  const [open, setOpen] = useState(false)
  const name = nameOf(card.workflow, i18n.language)
  const source = card.source
  const summary =
    card.purpose === 'save'
      ? t('workflow.card.source.save', { name })
      : source.kind === 'library'
        ? t('workflow.card.source.library', { name })
        : source.kind === 'marketplace'
          ? card.approves
            ? t('workflow.card.source.marketplaceAdd', { name, handle: source.handle })
            : t('workflow.card.source.marketplace', { name, handle: source.handle })
          : t('workflow.card.source.draft', { agent })
  const tools = card.tools.map((tool) => tool.title)
  const where =
    card.facts.worktree === false ? t('workflow.card.may.folder') : t('workflow.card.may.worktree')
  return (
    <div className="flex flex-col gap-2 border-t border-(--thread-line) pt-3 text-meta">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-fit min-w-0 items-center gap-1.5 text-tertiary hover:text-secondary"
      >
        <Glyph
          icon={ArrowRight01Icon}
          size={12}
          className={cn(
            'shrink-0 transition-transform duration-(--duration-fast)',
            open && 'rotate-90',
          )}
        />
        <span className="shrink-0">{t('workflow.card.details')}</span>
        <span aria-hidden>·</span>
        <span className="truncate font-medium text-primary">{summary}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 pl-4.5">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
            {source.kind === 'marketplace' && (
              <>
                <dt className="text-tertiary">{t('workflow.card.publisher')}</dt>
                <dd className="min-w-0 text-primary">
                  @{source.handle}
                  <span className="text-tertiary">
                    {[
                      source.official ? t('workflow.card.official') : null,
                      source.installs !== null
                        ? t('workflow.card.installs', {
                            count: source.installs,
                            value: count(source.installs),
                          })
                        : null,
                      t('workflow.card.version', { version: source.version }),
                    ]
                      .filter(Boolean)
                      .map((part) => ` · ${part}`)
                      .join('')}
                  </span>
                </dd>
              </>
            )}
            <dt className="text-tertiary">{t('workflow.card.mayLabel')}</dt>
            <dd className="min-w-0 text-primary">
              {tools.length > 0
                ? t('workflow.card.may.withTools', { where, tools: listOf(tools) })
                : where}
            </dd>
          </dl>
          <div className="flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={onFile}
              className="inline-flex items-center gap-1 text-link hover:underline"
            >
              <Glyph icon={File01Icon} size={12} />
              {t('workflow.card.viewFile')}
            </button>
            {onAnother && (
              <button
                type="button"
                onClick={onAnother}
                className="inline-flex items-center gap-1 text-link hover:underline"
              >
                <Glyph icon={WORKFLOW_ICON} size={12} />
                {t('workflow.card.another')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** The workflow's file as the card drew it, read from the host when opened. */
function FileDialog({
  card,
  open,
  onClose,
}: {
  card: WorkflowSuggestion
  open: boolean
  onClose: () => void
}) {
  const { t, i18n } = useTranslation('session')
  const { hostId } = useHostScope()
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open || text !== null) return
    let live = true
    hostAt(hostId, 'workflows.suggestionFile', { id: card.id }).then(
      (file) => live && setText(file.text),
      (caught: unknown) => live && setError(errorMessage(caught)),
    )
    return () => {
      live = false
    }
  }, [open, text, hostId, card.id])
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{nameOf(card.workflow, i18n.language)}</DialogTitle>
        </DialogHeader>
        {error ? (
          <p className="text-meta text-danger">{error}</p>
        ) : (
          <pre
            data-selectable=""
            aria-busy={text === null}
            className="max-h-[60vh] min-h-24 overflow-auto rounded-lg bg-raised p-3 font-mono text-code whitespace-pre-wrap text-secondary"
          >
            {text ?? t('workflow.card.reading')}
          </pre>
        )}
      </DialogContent>
    </Dialog>
  )
}

// The card once answered: one line.

function AnsweredLine({
  icon,
  tone,
  children,
  action,
}: {
  icon: typeof Clock01Icon
  tone: 'done' | 'quiet'
  children: ReactNode
  action?: { label: string; run: () => void }
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 py-0.5 text-meta text-tertiary">
      <Glyph
        icon={icon}
        size={14}
        className={cn('shrink-0', tone === 'done' ? 'text-success' : 'text-tertiary')}
      />
      <span className="min-w-0 truncate">{children}</span>
      {action && (
        <button type="button" onClick={action.run} className="shrink-0 text-link hover:underline">
          {action.label}
        </button>
      )}
    </div>
  )
}

function StartedLine({ card, taskId }: { card: WorkflowSuggestion; taskId: string }) {
  const { t } = useTranslation('session')
  const title = useTasksStore((s) => s.summaries[taskId]?.title ?? null)
  return (
    <AnsweredLine
      icon={CheckmarkCircle02Icon}
      tone="done"
      action={{ label: t('workflow.card.openTask'), run: () => openTask(taskId) }}
    >
      {t('workflow.card.started', { title: title ?? card.title ?? card.task })}
    </AnsweredLine>
  )
}

function DeclinedLine({ card }: { card: WorkflowSuggestion }) {
  const { t } = useTranslation('session')
  const scope = useHostScope()
  const [error, setError] = useState<string | null>(null)
  const reconsider = () => {
    setError(null)
    hostAt(scope.hostId, 'workflows.answerSuggestion', { id: card.id, answer: 'reconsider' }).then(
      (view) => useSuggestionsStore.getState().receive(view),
      (caught: unknown) => setError(errorMessage(caught)),
    )
  }
  return (
    <>
      <AnsweredLine
        icon={WORKFLOW_ICON}
        tone="quiet"
        action={{ label: t('workflow.card.useInstead'), run: reconsider }}
      >
        {t('workflow.card.declined')}
      </AnsweredLine>
      {error && (
        <p role="alert" className="ks-card-error">
          {error}
        </p>
      )}
    </>
  )
}

function SavedLine({ card, workflowId }: { card: WorkflowSuggestion; workflowId: string }) {
  const { t, i18n } = useTranslation('session')
  return (
    <AnsweredLine
      icon={CheckmarkCircle02Icon}
      tone="done"
      action={{ label: t('workflow.card.open'), run: () => openWorkflowMarketplace(workflowId) }}
    >
      {t('workflow.card.saved', { name: nameOf(card.workflow, i18n.language) })}
    </AnsweredLine>
  )
}

function NotSavedLine({ card }: { card: WorkflowSuggestion }) {
  const { t, i18n } = useTranslation('session')
  return (
    <AnsweredLine icon={WORKFLOW_ICON} tone="quiet">
      {t('workflow.card.notSaved', { name: nameOf(card.workflow, i18n.language) })}
    </AnsweredLine>
  )
}
