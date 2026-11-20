import { useEffect, useRef, useState, type ReactNode } from 'react'
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
  UserIcon,
} from '@hugeicons/core-free-icons'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { keptTool, type StartItem, type StartProgress, type SuggestedTool } from '@shared/workflow'
import type { Workflow, WorkflowStep, WorkflowSuggestion } from '@shared/workflow'
import type { ToolEntry } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import { Icon } from '@renderer/components/affect/app-shell'
import { ApprovalCard } from '@renderer/components/affect/approval-card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { ConnectButton } from '@renderer/features/marketplace/connect'
import { useConnection } from '@renderer/features/marketplace/hooks'
import { InstallButton } from '@renderer/features/marketplace/listing'
import { Glyph } from '@renderer/features/shell/glyph'
import { chartShown, chartToTask, holdChart } from '@renderer/features/tasks/chart-morph'
import { WorkflowChart } from '@renderer/features/tasks/workflow-chart'
import { count, runningFor } from '@renderer/lib/format'
import { errorMessage, hostAt } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { HostScopeContext, hostScope, LOCAL_SCOPE, useHostScope } from '@renderer/stores/host-scope'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { useSuggestion, useSuggestionsStore } from '@renderer/stores/workflow-suggestions'
import { openTask, openWorkflowMarketplace } from '../new-session/open-task'
import { listOf, localStepName, WORKFLOW_ICON } from '../new-session/workflow-picks'
import { useSessionView } from '../use-thread'
import { revealWaiting } from './helpers'
import { cardIdOf } from './workflow-tools'

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
    chartToTask(card.id, taskId)
    openTask(taskId, { flow: true })
  }, [taskId, pressed, card.id])

  switch (answer.kind) {
    case 'started':
      return <StartedLine card={card} taskId={answer.taskId} agent={agent} />
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
      holdChart(card.id)
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
  const scope = useHostScope()
  return (
    <WorkflowChart
      workflow={card.workflow}
      agentId={card.agentId}
      agentName={agent}
      hostId={scope.hostId}
      tools={card.tools}
      chartRef={(el) => chartShown(card.id, el)}
    />
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

/** The card once its task started: folded into one row that opens the task. */
function StartedLine({
  card,
  taskId,
  agent,
}: {
  card: WorkflowSuggestion
  taskId: string
  agent: string
}) {
  const { t, i18n } = useTranslation('session')
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="px-0.5 text-hint text-(--thread-faint)">
        {t('workflow.card.label', { agent })}
      </span>
      <div className="flex min-w-0 items-center gap-2 rounded-xl border border-(--thread-line) px-3 py-2 text-small">
        <Glyph icon={CheckmarkCircle02Icon} size={15} className="shrink-0 text-success" />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium text-(--thread-ink)">{t('workflow.card.title')}</span>
          <span className="text-(--thread-muted)">
            {' · '}
            {card.source.kind === 'draft'
              ? t('workflow.card.startedWritten', { agent })
              : t('workflow.card.startedAs', { workflow: nameOf(card.workflow, i18n.language) })}
          </span>
        </span>
        <button
          type="button"
          onClick={() => openTask(taskId)}
          className="inline-flex shrink-0 items-center gap-0.5 text-link hover:underline"
        >
          {t('workflow.delivery.openTask')}
          <Glyph icon={ArrowRight01Icon} size={13} />
        </button>
      </div>
    </div>
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
