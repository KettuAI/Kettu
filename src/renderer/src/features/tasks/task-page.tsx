// A task's page: its bar with its state and actions, the SOP it runs and its branch, its
// flowchart, the node chosen in it with its runs, newest first, and its requirement.

import { useEffect, useState, type ReactNode } from 'react'
import {
  Alert02Icon,
  ArrowLeft01Icon,
  Cancel01Icon,
  Delete02Icon,
  GitBranchIcon,
  WorkflowSquare03Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { NOTE_CHARS, type NodeRunView, type TaskView } from '@shared/tasks'
import { back } from '@renderer/app/history'
import { Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Clamp } from '@renderer/features/session/clamp'
import { Markdown } from '@renderer/features/session/markdown'
import { TurnDots } from '@renderer/features/session/turn-dots'
import { Head, Notice, SettingsStyles } from '@renderer/features/routines/kit'
import { useCornered } from '@renderer/features/shell/corner'
import { CornerControlsSpace } from '@renderer/features/shell/top-bar'
import { shortAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import { useSessionsStore } from '@renderer/stores/sessions'
import { taskHost, useTasksStore } from '@renderer/stores/tasks'
import { openSession } from '@renderer/stores/view'
import {
  defaultNode,
  nodeName,
  nodeOf,
  outcomeName,
  taskActions,
  taskMark,
  type OutlineNode,
} from './model'
import { SopFlow } from './sop-flow'
import { CancelTaskDialog, RemoveTaskDialog } from './task-menu'
import { useAgentLine } from './use-model-name'
import './tasks.css'

const NO_RUNS: NodeRunView[] = []
const DOCUMENT_HEIGHT = 240
const REQUIREMENT_HEIGHT = 100

export default function TaskPage({ taskId }: { taskId: string }) {
  const { t } = useTranslation('tasks')
  const task = useTasksStore((s) => s.byId[taskId])
  const runs = useTasksStore((s) => s.runs[taskId])
  const read = useTasksStore((s) => s.reads[''])
  const updatedAt = task?.updatedAt

  useEffect(() => {
    void useTasksStore.getState().loadTask(taskId)
  }, [taskId])

  // Shown, the task's latest change counts as seen.
  useEffect(() => {
    if (updatedAt === undefined) return
    useTasksStore
      .getState()
      .markSeen(taskId)
      .catch((error: unknown) =>
        console.warn(`Could not mark the task seen: ${errorMessage(error)}`),
      )
  }, [taskId, updatedAt])

  if (!task) {
    const loading = !read?.loaded || !runs || runs.loading
    return (
      <TaskShell bar={null}>
        {loading ? (
          <PageSkeleton />
        ) : runs?.error ? (
          <div className="k-routine__body">
            <LoadFailed taskId={taskId} error={runs.error} />
          </div>
        ) : (
          <div className="k-routine__body">
            <div className="k-rempty">
              <b>{t('page.gone')}</b>
              <p>{t('page.goneDescription')}</p>
            </div>
          </div>
        )}
      </TaskShell>
    )
  }
  return <TaskBody task={task} />
}

function LoadFailed({ taskId, error }: { taskId: string; error: string }) {
  const { t } = useTranslation('tasks')
  return (
    <Notice
      tone="red"
      mark={<Icon icon={Alert02Icon} size={16} />}
      action={
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void useTasksStore.getState().loadTask(taskId)}
        >
          {t('page.retry')}
        </Button>
      }
    >
      {t('page.failed', { error })}
    </Notice>
  )
}

function TaskBody({ task }: { task: TaskView }) {
  const { t } = useTranslation('tasks')
  const runs = useTasksStore((s) => s.runs[task.id])
  const [cancelling, setCancelling] = useState(false)
  const [removing, setRemoving] = useState(false)
  // The node the person chose; until they choose, the one the task is at.
  const [picked, setPicked] = useState<string | null>(null)
  const can = taskActions(task)
  const mark = taskMark(task)
  const items = runs?.value ?? NO_RUNS
  const chosen = nodeOf(task.outline, picked) ?? nodeOf(task.outline, defaultNode(task, items))

  return (
    <TaskShell
      bar={
        <>
          <span className="k-routine__title">
            <Icon icon={WorkflowSquare03Icon} size={16} />
            <span className="truncate text-[13px] font-medium text-(--strong)" title={task.title}>
              {task.title}
            </span>
          </span>
          <span className="k-routine__state" data-tone={mark === 'needsYou' ? 'amber' : undefined}>
            {mark === 'needsYou' && <span aria-hidden className="k-rs__dot" />}
            {mark === 'running' && <TurnDots phase="working" />}
            <span>{t(`state.${mark}`)}</span>
          </span>
          <span className="k-routine__acts">
            {can.cancel && (
              <Button
                size="sm"
                variant="ghost"
                icon={<Icon icon={Cancel01Icon} size={14} />}
                onClick={() => setCancelling(true)}
              >
                {t('page.cancel')}
              </Button>
            )}
            {can.remove && (
              <Button
                size="sm"
                variant="ghost"
                icon={<Icon icon={Delete02Icon} size={14} />}
                onClick={() => setRemoving(true)}
              >
                {t('page.remove')}
              </Button>
            )}
          </span>
        </>
      }
    >
      <div className="k-routine__body">
        <div className="k-task__meta">
          <span>{t('page.sop', { name: task.sop.name })}</span>
          {task.worktree && (
            <span className="inline-flex items-center gap-1" title={task.worktree.path}>
              <Icon icon={GitBranchIcon} size={13} />
              {task.worktree.branch}
            </span>
          )}
        </div>
        {runs?.error && (
          <div className="mt-4">
            <LoadFailed taskId={task.id} error={runs.error} />
          </div>
        )}
        <div className="ui-sg-card k-flow-card mt-4">
          <SopFlow
            outline={task.outline}
            hostId={taskHost(task)}
            task={task}
            runs={items}
            selected={chosen?.id}
            onSelect={setPicked}
          />
        </div>
        {chosen && (
          <NodeDetail
            task={task}
            node={chosen}
            runs={items.filter((run) => run.nodeId === chosen.id)}
            loading={!runs?.value && !runs?.error}
          />
        )}
        <Head title={t('page.requirement')} />
        <div className="ui-sg-card">
          <Clamp maxHeight={REQUIREMENT_HEIGHT} more={t('page.showMore')} less={t('page.showLess')}>
            <div className="k-task__requirement" dir="auto">
              {task.requirement}
            </div>
          </Clamp>
        </div>
      </div>
      <CancelTaskDialog task={task} open={cancelling} onOpenChange={setCancelling} />
      <RemoveTaskDialog task={task} open={removing} onOpenChange={setRemoving} onRemoved={back} />
    </TaskShell>
  )
}

/** The page's bar, as a routine's: Back, then what the page puts on it. */
function TaskShell({ bar, children }: { bar: ReactNode; children: ReactNode }) {
  const { t } = useTranslation('tasks')
  const cornered = useCornered()
  return (
    <div className="k-scroll">
      <SettingsStyles />
      <div className="k-routine">
        <header className="k-routine__bar app-region-drag" data-cornered={cornered || undefined}>
          {cornered && <CornerControlsSpace />}
          <button type="button" className="k-back" onClick={back}>
            <Icon icon={ArrowLeft01Icon} size={15} />
            {t('page.back')}
          </button>
          {bar}
        </header>
        {children}
      </div>
    </div>
  )
}

function PageSkeleton() {
  return (
    <div className="k-routine__body" aria-busy>
      <div className="mt-4 flex flex-col gap-3">
        <Skeleton className="h-3 w-72" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    </div>
  )
}

/** The node chosen in the flowchart: what it hands in, and its runs, newest first. */
function NodeDetail({
  task,
  node,
  runs,
  loading,
}: {
  task: TaskView
  node: OutlineNode
  runs: NodeRunView[]
  loading: boolean
}) {
  const { t } = useTranslation('tasks')
  return (
    <>
      <Head
        title={node.name}
        note={node.by.kind === 'agent' ? t(`node.handIn.${node.handIn}`) : t('node.you')}
      />
      {loading ? (
        <div className="ui-sg-card" aria-busy>
          <div className="k-srun">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3 w-64" />
          </div>
        </div>
      ) : runs.length === 0 ? (
        <p className="k-runs__empty">{t('page.noRuns')}</p>
      ) : (
        <div className="ui-sg-card k-sruns">
          {runs.map((run) => (
            <NodeRun key={run.id} task={task} node={node} run={run} />
          ))}
        </div>
      )}
    </>
  )
}

function runTone(run: NodeRunView): 'ok' | 'wait' | 'fail' | undefined {
  if (run.state === 'done') return 'ok'
  if (run.state === 'waiting') return run.waiting === 'stuck' ? 'fail' : 'wait'
  return undefined
}

function NodeRun({ task, node, run }: { task: TaskView; node: OutlineNode; run: NodeRunView }) {
  const { t } = useTranslation('tasks')
  const now = useNow()
  const hostId = taskHost(task)
  const agent = useAgentLine(run.agentId, run.model, hostId)
  const sessionId = run.sessionId
  return (
    <div className="k-srun">
      <div className="k-srun__top">
        <b>{t('node.round', { round: run.round })}</b>
        <span className="k-srun__state" data-tone={runTone(run)}>
          {t(`run.state.${run.state}`)}
        </span>
        <span title={new Date(run.startedAt).toLocaleString()}>
          {shortAgo(run.endedAt ?? run.startedAt, now)}
        </span>
        {run.worktree && (
          <span className="inline-flex items-center gap-1" title={run.worktree.path}>
            <Icon icon={GitBranchIcon} size={13} />
            {run.worktree.branch}
          </span>
        )}
        {run.by === 'person' ? (
          <span className="ml-auto">{t('node.you')}</span>
        ) : (
          run.agentId && (
            <button
              type="button"
              className="k-srun__agent"
              disabled={!sessionId}
              title={t('run.openSession')}
              onClick={() => sessionId && openRunSession(task, sessionId)}
            >
              <AgentMark agent={run.agentId} size={13} hostId={hostId} />
              <span>{agent}</span>
            </button>
          )
        )}
      </div>
      {run.sentBack && (
        <div className="k-srun__note">
          <b>
            {t('run.sentBack', { node: nodeName(task, run.sentBack.from) ?? run.sentBack.from })}
          </b>
          {run.sentBack.note && `: ${run.sentBack.note}`}
        </div>
      )}
      {run.outcome !== null && (
        <div className="k-srun__summary">
          {t('run.outcome', { outcome: outcomeName(node, run.outcome) })}
        </div>
      )}
      {run.note && (
        <div className="k-srun__summary" dir="auto">
          {run.note}
        </div>
      )}
      {run.hasDocument && <RunDocument taskId={task.id} runId={run.id} />}
      {run.state === 'waiting' && run.waiting === 'person' && (
        <DecideBlock task={task} node={node} run={run} />
      )}
      {run.state === 'waiting' && run.waiting === 'stuck' && <StuckBlock task={task} run={run} />}
      {run.state === 'waiting' && run.waiting === 'request' && (
        <section className="k-decide">
          <div className="k-decide__head">
            <b>{t('run.request')}</b>
          </div>
          {sessionId && (
            <div className="k-decide__acts">
              <Button size="sm" variant="primary" onClick={() => openRunSession(task, sessionId)}>
                {t('run.openSession')}
              </Button>
            </div>
          )}
        </section>
      )}
      {sessionId && run.state !== 'waiting' && (
        <div>
          <Button size="sm" variant="secondary" onClick={() => openRunSession(task, sessionId)}>
            {t('run.openSession')}
          </Button>
        </div>
      )}
    </div>
  )
}

type DocumentRead =
  | { state: 'loading' }
  | { state: 'read'; markdown: string | null }
  | { state: 'failed'; error: string }

/** The Markdown a run handed in, read when its run shows and cut short while long. */
function RunDocument({ taskId, runId }: { taskId: string; runId: string }) {
  const { t } = useTranslation('tasks')
  const [read, setRead] = useState<DocumentRead>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    useTasksStore
      .getState()
      .document(taskId, runId)
      .then(
        (markdown) => live && setRead({ state: 'read', markdown }),
        (error: unknown) => live && setRead({ state: 'failed', error: errorMessage(error) }),
      )
    return () => {
      live = false
    }
  }, [taskId, runId, attempt])

  return (
    <div className="k-srun__document">
      <span className="k-srun__note">{t('run.document')}</span>
      {read.state === 'loading' && (
        <span className="k-srun__note" aria-busy>
          {t('run.documentLoading')}
        </span>
      )}
      {read.state === 'failed' && (
        <span role="alert" className="flex items-center gap-2 text-xs text-danger">
          {t('run.documentFailed', { error: read.error })}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setRead({ state: 'loading' })
              setAttempt((n) => n + 1)
            }}
          >
            {t('page.retry')}
          </Button>
        </span>
      )}
      {read.state === 'read' &&
        (read.markdown === null ? (
          <span className="k-srun__note">{t('run.documentNone')}</span>
        ) : (
          <Clamp maxHeight={DOCUMENT_HEIGHT} more={t('page.showMore')} less={t('page.showLess')}>
            <Markdown markdown={read.markdown} className="markdown-compact" />
          </Clamp>
        ))}
    </div>
  )
}

function NoteField({
  value,
  placeholder,
  onChange,
}: {
  value: string
  placeholder: string
  onChange: (value: string) => void
}) {
  const { t } = useTranslation('tasks')
  return (
    <textarea
      className="ui-sg-textarea k-decide__note"
      aria-label={t('run.note')}
      placeholder={placeholder}
      maxLength={NOTE_CHARS}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

/** Runs one of a block's requests, holding its buttons until it settles and showing why it failed. */
function useRequest(): {
  busy: boolean
  error: string | null
  run: (request: () => Promise<void>) => void
} {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = (request: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    request()
      .catch((failure: unknown) => setError(errorMessage(failure)))
      .finally(() => setBusy(false))
  }
  return { busy, error, run }
}

/** The person's own node: one button for each of its outcomes, with a note if they like. */
function DecideBlock({ task, node, run }: { task: TaskView; node: OutlineNode; run: NodeRunView }) {
  const { t } = useTranslation('tasks')
  const [note, setNote] = useState('')
  const request = useRequest()
  const decide = (outcome: string) => {
    const trimmed = note.trim()
    request.run(() =>
      useTasksStore.getState().decide({
        taskId: task.id,
        runId: run.id,
        outcome,
        ...(trimmed ? { note: trimmed } : {}),
      }),
    )
  }
  return (
    <section className="k-decide" aria-label={t('run.person', { node: node.name })}>
      <div className="k-decide__head">
        <b>{t('run.person', { node: node.name })}</b>
      </div>
      {node.question && <p className="k-decide__text">{node.question}</p>}
      <NoteField value={note} placeholder={t('run.notePlaceholder')} onChange={setNote} />
      <div className="k-decide__acts">
        {node.outcomes.map((outcome, i) => (
          <Button
            key={outcome.id}
            size="sm"
            variant={i === 0 ? 'primary' : 'secondary'}
            disabled={request.busy}
            onClick={() => decide(outcome.id)}
          >
            {outcome.name}
          </Button>
        ))}
        {request.error && (
          <span role="alert" className="text-xs text-danger">
            {request.error}
          </span>
        )}
      </div>
    </section>
  )
}

/** A stuck run: why, and another try with what the person wants it told. */
function StuckBlock({ task, run }: { task: TaskView; run: NodeRunView }) {
  const { t } = useTranslation('tasks')
  const [note, setNote] = useState('')
  const request = useRequest()
  const sessionId = run.sessionId
  const retry = () => {
    const trimmed = note.trim()
    request.run(() =>
      useTasksStore
        .getState()
        .retry({ taskId: task.id, runId: run.id, ...(trimmed ? { note: trimmed } : {}) }),
    )
  }
  return (
    <section className="k-decide" data-tone="red" aria-label={t('run.stuck')}>
      <div className="k-decide__head">
        <b>{t('run.stuck')}</b>
        {run.reason && <small>{run.reason}</small>}
      </div>
      <NoteField value={note} placeholder={t('run.retryPlaceholder')} onChange={setNote} />
      <div className="k-decide__acts">
        <Button size="sm" variant="primary" disabled={request.busy} onClick={retry}>
          {t('run.retry')}
        </Button>
        {sessionId && (
          <Button size="sm" variant="secondary" onClick={() => openRunSession(task, sessionId)}>
            {t('run.openSession')}
          </Button>
        )}
        {request.error && (
          <span role="alert" className="text-xs text-danger">
            {request.error}
          </span>
        )}
      </div>
    </section>
  )
}

function openRunSession(task: TaskView, sessionId: string): void {
  const summary = useSessionsStore.getState().byId[sessionId]
  openSession(sessionId, summary?.projectPath ?? task.projectPath)
}
