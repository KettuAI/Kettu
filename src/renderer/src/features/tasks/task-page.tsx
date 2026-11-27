import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Alert02Icon,
  ArrowUp02Icon,
  CheckmarkCircle02Icon,
  FlowIcon,
  GitBranchIcon,
  GitMergeIcon,
  MinusSignCircleIcon,
  MoreHorizontalIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { githubReferenceOf, type GitHubReference } from '@shared/git'
import type { TaskSummary, TaskView } from '@shared/workflow'
import { Icon } from '@renderer/components/affect/app-shell'
import { ChatComposer } from '@renderer/components/affect/chat-composer'
import { SegmentedControl } from '@renderer/components/affect/segmented-control'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@renderer/components/ui/empty'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { useReferenceData } from '@renderer/features/git/gh-reference-data'
import { TrayStyles } from '@renderer/features/session/composer/affect-styles'
import { ThreadSkeleton } from '@renderer/features/session/session-states'
import { Glyph } from '@renderer/features/shell/glyph'
import { NoDrag, TopBar } from '@renderer/features/shell/top-bar'
import { useRenaming } from '@renderer/features/sidebar/use-renaming'
import { errorMessage, host } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { cn } from '@renderer/lib/utils'
import { loadReference } from '@renderer/stores/git'
import { isAway, useOtherHost } from '@renderer/stores/hosts'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useTasksStore } from '@renderer/stores/tasks'
import { openNewSession, setTaskFlow } from '@renderer/stores/view'
import { Flowchart } from './flowchart'
import { progressText, workflowTitle } from './model'
import { CancelTaskDialog, DeleteTaskDialog, TaskMenuItems, TaskTitleField } from './task-menu'
import { updateTask } from './actions'
import { TaskRing } from './task-ring'
import { StartedFrom, Timeline } from './timeline'
import { useTaskSessions, useTaskView } from './use-task'

/**
 * A task's page: its name, workflow and progress in the top bar with Timeline and Flowchart beside
 * them, the view chosen under it, and a composer that adds notes for the steps at work and every
 * later one, which move nothing.
 */
export default function TaskPage({ taskId, flow }: { taskId: string; flow: boolean }) {
  const { t } = useTranslation('tasks')
  const task = useTasksStore((s) => s.summaries[taskId])
  const listLoaded = useTasksStore((s) => s.loaded)
  const away = isAway(useOtherHost(task ? hostOfPath(task.projectPath) : null)?.connection ?? null)
  const { view, error, retry } = useTaskView(taskId, !!task && !away)
  const sessionIds = (task?.steps ?? []).flatMap((step) => step.sessionId ?? [])
  const missing = useSessionsStore(useShallow((s) => sessionIds.filter((id) => !s.byId[id]))).join(
    ',',
  )
  useTaskSessions(taskId, missing, !!task && !away)

  // The timeline opens at its end, as a thread does, where what waits for you is.
  const scroller = useRef<HTMLDivElement>(null)
  const ready = !!view
  useLayoutEffect(() => {
    const element = scroller.current
    if (ready && element) element.scrollTop = element.scrollHeight
  }, [ready, flow])

  // Shown, it counts as read.
  const unread = task?.unread === true
  useEffect(() => {
    if (unread) void updateTask(taskId, { unread: false }).catch(() => {})
  }, [unread, taskId])

  if (!task) {
    return listLoaded ? (
      <Missing />
    ) : (
      <div className="flex h-full flex-col">
        <TopBar>
          <Skeleton className="h-4 w-48" />
        </TopBar>
        <div className="ks-thread__column mx-auto w-full px-8 pt-8">
          <ThreadSkeleton />
        </div>
      </div>
    )
  }

  let body
  if (view) body = flow ? <Flowchart view={view} /> : <Timeline view={view} />
  else if (error || away) {
    body = (
      <Empty className="mt-12">
        <EmptyHeader>
          <EmptyTitle>{t('page.unavailable')}</EmptyTitle>
          <EmptyDescription>{away ? t('page.hostAway') : error}</EmptyDescription>
        </EmptyHeader>
        {!away && (
          <Button size="sm" variant="outline" onClick={retry}>
            {t('page.retry')}
          </Button>
        )}
      </Empty>
    )
  } else body = <ThreadSkeleton />

  return (
    <div className="ks-session flex h-full min-h-0 flex-col">
      <TaskBar task={task} view={view} flow={flow} />
      {flow ? (
        // The flowchart's canvas fills the room and pans itself.
        <div className="flex min-h-0 flex-1 flex-col gap-2 px-8 pt-4 pb-4">
          {view && <StartedFrom view={view} className="mx-auto w-full max-w-(--thread-column)" />}
          {body}
        </div>
      ) : (
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
          <div className="ks-thread ks-thread__column mx-auto w-full px-8 pt-4 pb-6">{body}</div>
        </div>
      )}
      <div className="px-8 pb-6">
        <div className="mx-auto w-full max-w-(--thread-column)">
          {task.status === 'running' ? (
            <NotesComposer task={task} view={view} disabled={away} />
          ) : (
            <EndedLine task={task} view={view} />
          )}
        </div>
      </div>
    </div>
  )
}

/** The page of a task deleted since, or never on this host. */
function Missing() {
  const { t } = useTranslation('tasks')
  return (
    <div className="flex h-full flex-col">
      <TopBar>
        <span />
      </TopBar>
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Glyph icon={FlowIcon} size={18} />
          </EmptyMedia>
          <EmptyTitle>{t('page.missing')}</EmptyTitle>
          <EmptyDescription>{t('page.missingBody')}</EmptyDescription>
        </EmptyHeader>
        <Button size="sm" variant="outline" onClick={() => openNewSession(null, null)}>
          {t('page.newSession')}
        </Button>
      </Empty>
    </div>
  )
}

/**
 * The top bar: the ring and the task's name, which a click renames, its More menu, the workflow with
 * the step it is on, Needs you or how it ended; Timeline and Flowchart at the right.
 */
function TaskBar({
  task,
  view,
  flow,
}: {
  task: TaskSummary
  view: TaskView | undefined
  flow: boolean
}) {
  const { t } = useTranslation('tasks')
  const titleRef = useRef<HTMLButtonElement>(null)
  const rename = useRenaming(() => titleRef.current)
  const [width, setWidth] = useState(0)
  const [moreOpen, setMoreOpen] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const progress = progressText(task)
  return (
    <TopBar>
      <NoDrag className="min-w-0 gap-2 overflow-x-clip">
        <span className="grid w-4 shrink-0 place-items-center">
          <TaskRing task={task} size={16} />
        </span>
        {rename.renaming ? (
          <TaskTitleField
            task={task}
            onDone={rename.finish}
            style={{ minWidth: Math.max(width - 5, 0) }}
            className="ks-title mx-[2.5px] field-sizing-content h-[23px] rounded-sm bg-transparent px-[1.5px] py-0 font-sans text-label font-medium outline-[1.5px] outline-offset-1 outline-edit-ring outline-solid selection:bg-edit-selection aria-invalid:outline-danger"
          />
        ) : (
          <Button
            ref={titleRef}
            variant="ghost"
            title={task.title}
            className="ks-title -mx-1 h-7 min-w-16 shrink-10 rounded-md px-1 font-sans text-label font-medium focus-visible:outline-[1.5px] focus-visible:-outline-offset-[1.5px] focus-visible:outline-edit-ring focus-visible:outline-solid active:not-aria-[haspopup]:translate-y-0"
            onClick={() => {
              setWidth(titleRef.current?.offsetWidth ?? 0)
              rename.start()
            }}
          >
            <span className="truncate">{task.title}</span>
          </Button>
        )}
        <DropdownMenu
          open={moreOpen}
          onOpenChange={setMoreOpen}
          onOpenChangeComplete={rename.menu.onOpenChangeComplete}
        >
          <DropdownMenuTrigger
            render={
              <Button
                variant="quiet"
                size="icon-sm"
                aria-label={t('page.more')}
                title={t('page.more')}
                className="shrink-0"
              />
            }
          >
            <Icon icon={MoreHorizontalIcon} size={16} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" finalFocus={rename.menu.finalFocus}>
            <TaskMenuItems
              task={task}
              place="page"
              onRename={() => {
                setWidth(titleRef.current?.offsetWidth ?? 0)
                rename.menu.onRename()
              }}
              onCancel={() => setCancelling(true)}
              onDelete={() => setDeleting(true)}
            />
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="ks-chip shrink-1000" title={workflowTitle(task, view)}>
          <Glyph icon={FlowIcon} size={13} />
          <span className="ks-chip__text truncate @max-[44rem]/top-bar:hidden">
            {workflowTitle(task, view)}
          </span>
          {progress && <span className="ks-chip__dim tabular-nums">{progress}</span>}
        </span>
        <TaskState task={task} />
      </NoDrag>
      <span className="flex-1" />
      <NoDrag className="shrink-0">
        <SegmentedControl
          aria-label={t('page.view')}
          variant="tray"
          size="sm"
          value={flow ? 'flow' : 'timeline'}
          onChange={(value) => setTaskFlow(task.id, value === 'flow')}
          options={[
            { value: 'timeline', label: t('page.timeline') },
            { value: 'flow', label: t('page.flowchart') },
          ]}
        />
      </NoDrag>
      <CancelTaskDialog task={task} open={cancelling} onOpenChange={setCancelling} />
      <DeleteTaskDialog
        task={task}
        open={deleting}
        onOpenChange={setDeleting}
        onDeleted={() => openNewSession(null, null)}
      />
    </TopBar>
  )
}

/** Needs you while something waits for the person, Stuck for a stuck step, or how it ended. */
function TaskState({ task }: { task: TaskSummary }) {
  const { t } = useTranslation('tasks')
  if (task.status === 'running') {
    if (task.error) {
      return (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-hint font-medium text-danger">
          <Glyph icon={Alert02Icon} size={14} />
          {t('page.stuck')}
        </span>
      )
    }
    if (!task.needsYou) return null
    return (
      <span className="inline-flex shrink-0 items-center gap-2 text-hint font-medium text-attention">
        <span
          aria-hidden
          className="size-2 rounded-full bg-attention-dot shadow-[0_0_0_3px_var(--attention-halo)]"
        />
        {t('page.needsYou')}
      </span>
    )
  }
  return (
    <span
      className={cn(
        'shrink-0 text-hint',
        task.status === 'done' ? 'text-success' : 'text-(--shell-muted)',
      )}
    >
      {t(`ended.${task.status}`)}
    </span>
  )
}

/** In the composer's place once the task ended: how it ended, and its branch merged when it was. */
function EndedLine({ task, view }: { task: TaskSummary; view: TaskView | undefined }) {
  const pr = view?.deliverables?.find((d) => d.kind === 'pull_request')
  const reference = pr ? githubReferenceOf(pr.url) : null
  if (reference && task.status === 'done' && task.branch) {
    return <PullLine task={task} reference={reference} />
  }
  return <EndedText task={task} merged={false} />
}

function PullLine({ task, reference }: { task: TaskSummary; reference: GitHubReference }) {
  const hostId = hostOfPath(task.projectPath)
  const { data } = useReferenceData(reference, hostId)
  useEffect(() => loadReference(reference, false, hostId), [reference, hostId])
  return <EndedText task={task} merged={data?.kind === 'pull' && data.pr.state === 'merged'} />
}

function EndedText({ task, merged }: { task: TaskSummary; merged: boolean }) {
  const { t } = useTranslation('tasks')
  const done = task.status === 'done'
  const text = done
    ? task.branch
      ? t(merged ? 'composer.doneMerged' : 'composer.doneOn', { branch: task.branch })
      : t('composer.doneLine')
    : t(task.status === 'dropped' ? 'composer.droppedLine' : 'composer.cancelledLine')
  return (
    <p className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-(--thread-line) px-4 py-2.5 text-small text-(--thread-muted)">
      <Glyph
        icon={done ? (merged ? GitMergeIcon : CheckmarkCircle02Icon) : MinusSignCircleIcon}
        size={15}
        className={cn('shrink-0', done ? 'text-success' : 'text-tertiary')}
      />
      <span className="truncate">{text}</span>
    </p>
  )
}

/**
 * Adds a note to the task: Kettu hands it to the steps at work and to every step after them, and
 * it moves nothing. An ended task takes no more.
 */
function NotesComposer({
  task,
  view,
  disabled,
}: {
  task: TaskSummary
  view: TaskView | undefined
  disabled: boolean
}) {
  const { t } = useTranslation('tasks')
  const { t: tc } = useTranslation('composer')
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const ended = task.status !== 'running'
  const off = ended || disabled || !view
  const send = async () => {
    const note = text.trim()
    if (!note || sending || off) return
    setSending(true)
    setError(null)
    try {
      const next = await host('tasks.note', { taskId: task.id, text: note })
      useTasksStore.getState().receive(next, useTasksStore.getState().hosts[task.id] ?? null)
      setText('')
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setSending(false)
    }
  }
  return (
    <div className="flex flex-col gap-2">
      {error && (
        <p role="alert" className="px-1 text-xs text-danger">
          {error}
        </p>
      )}
      <div className="kettu-composer">
        <ChatComposer
          approvalModes={[]}
          addSections={[]}
          addDisabled={t('composer.textOnly')}
          models={[]}
          voice={false}
          onFieldFocus={() => field.current?.focus()}
          field={
            <textarea
              ref={field}
              value={text}
              disabled={off}
              rows={2}
              aria-label={t('composer.label')}
              placeholder={ended ? t('composer.ended') : t('composer.placeholder')}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void send()
                }
              }}
              className="ui-ccc__message field-sizing-content max-h-[40vh] min-h-[calc(2*var(--prose-size)+14px)] w-full resize-none bg-transparent outline-none disabled:cursor-default"
            />
          }
          send={
            <button
              type="button"
              className="ui-ccc__send kettu-send"
              aria-label={t('composer.send')}
              title={t('composer.send')}
              disabled={off || sending || !text.trim()}
              onClick={() => void send()}
            >
              <Glyph icon={ArrowUp02Icon} size={16} />
            </button>
          }
          labels={{
            composer: t('composer.label'),
            add: t('composer.textOnly'),
            voiceInput: tc('controls.voiceInput'),
            discardRecording: tc('controls.discardRecording'),
            useRecording: tc('controls.useRecording'),
          }}
          foot={
            <div className="ui-as-composer__tray kettu-tray">
              <TrayStyles />
              <span className="kettu-tray__group">
                {task.branch && (
                  <span className="ui-as-tray-link pointer-events-none">
                    <Glyph icon={GitBranchIcon} size={13} />
                    <span className="truncate font-mono">{task.branch}</span>
                  </span>
                )}
              </span>
              <span className="kettu-tray__group ml-auto">
                <span className="truncate px-1.5 text-hint text-(--shell-faint)">
                  {t('composer.noAdvance')}
                </span>
              </span>
            </div>
          }
        />
      </div>
    </div>
  )
}
