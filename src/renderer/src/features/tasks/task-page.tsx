// A task's page: its bar with its state and actions, where it runs and what it cost, its stage
// track, its requirement, what it needs from the person, and its stage runs, newest first.

import { useEffect, useState, type ReactNode } from 'react'
import {
  Alert02Icon,
  ArrowLeft01Icon,
  Cancel01Icon,
  GitBranchIcon,
  PauseIcon,
  PlayIcon,
  WorkflowSquare03Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { NOTE_CHARS, type StageRunView, type TaskView } from '@shared/tasks'
import { back } from '@renderer/app/history'
import { Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Clamp } from '@renderer/features/session/clamp'
import { TurnDots } from '@renderer/features/session/turn-dots'
import { Head, Notice, Select, SettingsStyles } from '@renderer/features/routines/kit'
import { useCornered } from '@renderer/features/shell/corner'
import { CornerControlsSpace } from '@renderer/features/shell/top-bar'
import { shortAgo, usd } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import { optionsOn, useAgentOptionsStore } from '@renderer/stores/agent-options'
import { agentName } from '@renderer/stores/agents'
import { useSessionsStore } from '@renderer/stores/sessions'
import { taskHost, useTasksStore } from '@renderer/stores/tasks'
import { openSession } from '@renderer/stores/view'
import { awaitsDecision, sendBackTargets, stageMarks, stageName, taskActions } from './model'
import { CancelTaskDialog } from './task-menu'
import './tasks.css'

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
              {t('page.failed', { error: runs.error })}
            </Notice>
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

function TaskBody({ task }: { task: TaskView }) {
  const { t } = useTranslation('tasks')
  const runs = useTasksStore((s) => s.runs[task.id])
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const can = taskActions(task)
  const store = useTasksStore.getState()
  const act = (action: () => Promise<void>) => {
    setError(null)
    action().catch((failure: unknown) => setError(errorMessage(failure)))
  }
  const stage = stageName(task, task.stageId)
  const items = runs?.value ?? []
  const waitingRun = items.find((run) => run.state === 'waiting' && run.sessionId)

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
          <span
            className="k-routine__state"
            data-tone={task.state === 'waiting' || task.state === 'blocked' ? 'amber' : undefined}
          >
            {task.state === 'waiting' && <span aria-hidden className="k-rs__dot" />}
            {task.state === 'running' && <TurnDots phase="working" />}
            <span>
              {task.state === 'running' && stage
                ? `${t('state.running')} · ${stage}`
                : t(`state.${task.state}`)}
            </span>
          </span>
          <span className="k-routine__acts">
            {can.start && (
              <Button
                size="sm"
                variant="secondary"
                icon={<Icon icon={PlayIcon} size={14} />}
                onClick={() => act(() => store.start(task.id))}
              >
                {t('page.start')}
              </Button>
            )}
            {can.pause && (
              <Button
                size="sm"
                variant="secondary"
                icon={<Icon icon={PauseIcon} size={14} />}
                onClick={() => act(() => store.pause(task.id))}
              >
                {t('page.pause')}
              </Button>
            )}
            {can.resume && (
              <Button
                size="sm"
                variant="secondary"
                icon={<Icon icon={PlayIcon} size={14} />}
                onClick={() => act(() => store.resume(task.id))}
              >
                {t('page.resume')}
              </Button>
            )}
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
          </span>
        </>
      }
    >
      <div className="k-routine__body">
        {error && (
          <Notice tone="red" mark={<Icon icon={Alert02Icon} size={16} />}>
            {error}
          </Notice>
        )}
        <Meta task={task} />
        <StageTrack task={task} runs={items} />
        {awaitsDecision(task) ? (
          <DecideCard key={`${task.stageId ?? ''}:${task.state}`} task={task} />
        ) : (
          task.state === 'waiting' && (
            <div className="mt-4">
              <Notice
                tone="amber"
                mark={<span className="k-rs__dot" />}
                title={t('page.needsYou')}
                action={
                  waitingRun?.sessionId && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => openRunSession(task, waitingRun.sessionId!)}
                    >
                      {t('page.openSession', {
                        agent: waitingRun.agentId
                          ? agentName(waitingRun.agentId, taskHost(task))
                          : '',
                      })}
                    </Button>
                  )
                }
              >
                {task.reason ?? undefined}
              </Notice>
            </div>
          )
        )}
        {task.state === 'paused' && task.reason && (
          <div className="mt-4">
            <Notice tone="amber" mark={<Icon icon={PauseIcon} size={16} />}>
              {task.reason}
            </Notice>
          </div>
        )}
        <Head title={t('page.requirement')} />
        <div className="ui-sg-card">
          <Clamp maxHeight={100} more={t('page.showMore')} less={t('page.showLess')}>
            <div className="k-task__requirement" dir="auto">
              {task.requirement}
            </div>
          </Clamp>
        </div>
        <Head title={t('page.runs')} />
        <StageRuns task={task} runs={runs} />
      </div>
      <CancelTaskDialog task={task} open={cancelling} onOpenChange={setCancelling} />
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
        <Skeleton className="h-1.5 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    </div>
  )
}

/** Where the task runs and what it cost: its workflow, its branch, its pull request. */
function Meta({ task }: { task: TaskView }) {
  const { t } = useTranslation('tasks')
  return (
    <div className="k-task__meta">
      <span>
        {t('page.workflow', { name: task.workflow.name, version: task.workflow.version })}
      </span>
      {task.worktree && (
        <span className="inline-flex items-center gap-1" title={task.worktree.path}>
          <Icon icon={GitBranchIcon} size={13} />
          {task.worktree.branch}
        </span>
      )}
      <span>{usd(task.costUsd)}</span>
      {task.pullRequest && (
        <a href={task.pullRequest} target="_blank" rel="noreferrer">
          {t('page.pullRequest')}
        </a>
      )}
    </div>
  )
}

/** One segment per stage: done, current, skipped hatched, upcoming. */
function StageTrack({ task, runs }: { task: TaskView; runs: readonly StageRunView[] }) {
  const { t } = useTranslation('tasks')
  const marks = stageMarks(task, runs)
  return (
    <ol className="k-track" aria-label={t('page.stages')}>
      {task.stages.map((stage, i) => {
        const mark = marks[i]!
        return (
          <li
            key={stage.id}
            className="k-track__stage"
            data-mark={mark}
            aria-current={mark === 'current' ? 'step' : undefined}
          >
            <span aria-hidden className="k-track__bar" />
            <span className="k-track__name" title={stage.name}>
              <span className="sr-only">{t(`page.stage.${mark}`, { stage: stage.name })}</span>
              <span aria-hidden>{stage.name}</span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** The person's decision on a human stage or a blocked task: approve, or send it back. */
function DecideCard({ task }: { task: TaskView }) {
  const { t } = useTranslation('tasks')
  const targets = sendBackTargets(task)
  const [to, setTo] = useState<string>(targets[0] ?? '')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const blocked = task.state === 'blocked'
  const stage = stageName(task, task.stageId) ?? ''

  const decide = (decision: 'approve' | 'send-back') => {
    setBusy(true)
    setError(null)
    const trimmed = note.trim()
    useTasksStore
      .getState()
      .decide({
        taskId: task.id,
        decision,
        ...(decision === 'send-back' ? { to } : {}),
        ...(trimmed ? { note: trimmed } : {}),
      })
      .catch((failure: unknown) => setError(errorMessage(failure)))
      .finally(() => setBusy(false))
  }

  return (
    <section
      className="k-decide"
      data-tone={blocked ? 'red' : undefined}
      aria-label={t('page.needsYou')}
    >
      <div className="k-decide__head">
        <b>{blocked ? t('page.blocked') : t('page.waitingOn', { stage })}</b>
        {task.reason && <small>{task.reason}</small>}
      </div>
      <textarea
        className="ui-sg-textarea k-decide__note"
        aria-label={t('page.note')}
        placeholder={t('page.notePlaceholder')}
        maxLength={NOTE_CHARS}
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      <div className="k-decide__acts">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => decide('approve')}>
          {t('page.approve')}
        </Button>
        {targets.length > 0 && (
          <span className="k-decide__back">
            <Select
              label={t('page.sendBackTo')}
              value={to}
              options={targets.map((id) => ({ value: id, label: stageName(task, id) ?? id }))}
              onChange={setTo}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || !to}
              onClick={() => decide('send-back')}
            >
              {t('page.sendBack')}
            </Button>
          </span>
        )}
        {error && (
          <span role="alert" className="text-xs text-danger">
            {error}
          </span>
        )}
      </div>
    </section>
  )
}

function StageRuns({
  task,
  runs,
}: {
  task: TaskView
  runs: ReturnType<typeof useTasksStore.getState>['runs'][string] | undefined
}) {
  const { t } = useTranslation('tasks')
  if (!runs?.value) {
    if (runs?.error) {
      return (
        <Notice
          tone="red"
          mark={<Icon icon={Alert02Icon} size={16} />}
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void useTasksStore.getState().loadTask(task.id)}
            >
              {t('page.retry')}
            </Button>
          }
        >
          {t('page.failed', { error: runs.error })}
        </Notice>
      )
    }
    return (
      <div className="ui-sg-card" aria-busy>
        {[0, 1].map((i) => (
          <div key={i} className="k-srun">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3 w-64" />
          </div>
        ))}
      </div>
    )
  }
  if (runs.value.length === 0) {
    return <p className="k-runs__empty">{t('page.noRuns')}</p>
  }
  return (
    <div className="ui-sg-card k-sruns">
      {runs.value.map((run) => (
        <StageRun key={run.id} task={task} run={run} />
      ))}
    </div>
  )
}

function runTone(state: StageRunView['state']): 'ok' | 'wait' | 'fail' | undefined {
  if (state === 'passed') return 'ok'
  if (state === 'waiting' || state === 'changes') return 'wait'
  if (state === 'blocked' || state === 'interrupted') return 'fail'
  return undefined
}

function StageRun({ task, run }: { task: TaskView; run: StageRunView }) {
  const { t } = useTranslation('tasks')
  const now = useNow()
  const hostId = taskHost(task)
  const model = useModelName(run, hostId)
  const agent = run.agentId ? agentName(run.agentId, hostId) : null
  return (
    <div className="k-srun">
      <div className="k-srun__top">
        <b>{stageName(task, run.stageId) ?? run.stageId}</b>
        {run.round > 1 && <span>{t('page.round', { round: run.round })}</span>}
        <span className="k-srun__state" data-tone={runTone(run.state)}>
          {t(`runState.${run.state}`)}
        </span>
        <span title={new Date(run.startedAt).toLocaleString()}>
          {shortAgo(run.endedAt ?? run.startedAt, now)}
        </span>
        {run.costUsd > 0 && <span>{usd(run.costUsd)}</span>}
        {run.agentId && (
          <button
            type="button"
            className="k-srun__agent"
            disabled={!run.sessionId}
            title={agent ? t('page.openSession', { agent }) : undefined}
            onClick={() => run.sessionId && openRunSession(task, run.sessionId)}
          >
            <AgentMark agent={run.agentId} size={13} hostId={hostId} />
            <span>{model ? `${agent} · ${model}` : agent}</span>
          </button>
        )}
      </div>
      {run.summary && <div className="k-srun__summary">{run.summary}</div>}
      {run.evidence && run.evidence.commands.length > 0 && (
        <>
          <span className="k-srun__label">{t('page.commands')}</span>
          <pre className="k-srun__commands">
            {run.evidence.commands.map((command, i) => (
              <code key={i} title={command}>
                {command}
              </code>
            ))}
          </pre>
        </>
      )}
      {run.evidence && run.evidence.changedFiles.length > 0 && (
        <span className="k-srun__label" title={run.evidence.changedFiles.join('\n')}>
          {t('page.changedFiles', { count: run.evidence.changedFiles.length })}
        </span>
      )}
      {run.note && <div className="k-srun__note">{run.note}</div>}
    </div>
  )
}

/** The model a run used, by the name its agent's menu shows it under when known. */
function useModelName(run: StageRunView, hostId: string | null): string | null {
  const choices = useAgentOptionsStore((s) =>
    run.agentId
      ? optionsOn(s, hostId)[run.agentId]?.config.find((option) => option.category === 'model')
          ?.choices
      : undefined,
  )
  if (!run.model) return null
  return choices?.find((choice) => choice.value === run.model)?.name ?? run.model
}

function openRunSession(task: TaskView, sessionId: string): void {
  const summary = useSessionsStore.getState().byId[sessionId]
  openSession(sessionId, summary?.projectPath ?? task.projectPath)
}
