// Tracks agy's background work in a session:
// - shell commands (`run_command`), including daemon processes (`IsDaemon`) and timeout-monitored
//   long commands (`NotificationTimeoutSeconds`),
// - scheduled one-shot timers (`schedule` with `DurationSeconds` + optional `TimerCondition`) and
//   recurring cron jobs (`schedule` with `CronExpression` + optional `IsDaemon` / `MaxIterations`),
// - lifecycle synchronization with `manage_task` (`kill`, `list`, `status`), timer expiration, and
//   early cancellation when a matching wakeup arrives.

import type * as acp from '@agentclientprotocol/sdk/unstable'
import type { BackgroundTaskSchedule, BackgroundTaskView } from '@shared/thread'
import { commandEnding, fromAgy } from './agy-tools'

/** Maximum characters kept for a schedule prompt used as a task title. */
const SCHEDULE_TITLE_LIMIT = 80

/** Registration window (ms) in which an immediate `completed` on `schedule` means the task was armed. */
const SCHEDULE_REGISTER_WINDOW_MS = 2_000

/** Grace window (ms) past `fireAt` before sweeping an unnotified one-shot timer as expired. */
const TIMER_EXPIRY_GRACE_MS = 1_500

const TASK_ID_IN_TEXT = /task id:\s*([^\s"'`]+)/i
const TASK_CANCELLED_IN_TEXT = /Task\s+"([^"]+)"\s+(?:cancelled|canceled|killed|stopped)/i
const ENDED_TEXT = /\b(?:cancel+ed|killed|stopped|fired|expired|not running)\b/i
const BG_RUNNING_TEXT = /running as a background task/i
const NO_BG_TASKS_TEXT = /No background tasks are currently running/i

type EntryKind = 'command' | 'schedule'

interface TrackedTask {
  toolCallId: string
  entryKind: EntryKind
  kind: BackgroundTaskView['kind']
  title: string
  command: string
  /** Whether started with `IsDaemon: true` so it survives turn end/abort. */
  daemon: boolean
  /** Logical task status exposed on the board and stillRunning summary. */
  status: BackgroundTaskView['status']
  /** Last raw ACP tool call status seen for this call. */
  call: acp.ToolCallStatus
  startedAt: number
  endedAt: number | null
  summary: string | null
  /** It outlived the turn that started it. */
  carried: boolean
  /** Surfaced on the board while the open prompt idles waiting on background work. */
  shownInWait: boolean
  /** Optional timer, cron, or timeout-watch metadata. */
  schedule?: BackgroundTaskSchedule
  /** agy background task id (e.g. `<conversationId>/task-169`), once observed. */
  taskId: string | null
  /** Expiration timer for one-shot `schedule` timers so expired countdowns never linger. */
  expiryTimer: ReturnType<typeof setTimeout> | null
}

interface ManageTaskCall {
  action: 'list' | 'status' | 'kill' | 'send_input'
  taskId: string | null
}

export interface AgyCommandsOptions {
  /** Called when an internal timer expiry changes the board list outside a tool update. */
  onChange?: () => void
  /** Clock provider, injectable for deterministic tests. */
  now?: () => number
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function toolName(update: acp.ToolCallUpdate): string | null {
  const name = (update as { name?: unknown }).name
  return typeof name === 'string' ? name : null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function finitePositive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function oneLine(text: string, limit: number): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact
}

/** Compact human-readable duration for schedule summaries (e.g. `45s`, `5m`, `1h 30m`). */
export function formatScheduleDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  if (total < 60) return `${total}s`
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const remSeconds = total % 60
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  return remSeconds > 0 ? `${minutes}m ${remSeconds}s` : `${minutes}m`
}

/** Collects text from a tool update's content blocks and rawOutput for task metadata parsing. */
function updateTexts(update: acp.ToolCallUpdate): string {
  const parts: string[] = []
  for (const item of update.content ?? []) {
    if (item.type === 'content' && item.content.type === 'text' && item.content.text) {
      parts.push(item.content.text)
    }
  }
  const raw = update.rawOutput
  if (typeof raw === 'string') {
    parts.push(raw)
  } else {
    const obj = record(raw)
    if (obj) {
      if (typeof obj.output === 'string') parts.push(obj.output)
      if (typeof obj.text === 'string') parts.push(obj.text)
      if (typeof obj.message === 'string') parts.push(obj.message)
      if (typeof obj.taskId === 'string') parts.push(`task id: ${obj.taskId}`)
      if (typeof obj.task_id === 'string') parts.push(`task id: ${obj.task_id}`)
    }
  }
  return parts.join('\n')
}

function extractTaskId(update: acp.ToolCallUpdate): string | null {
  const obj = record(update.rawOutput)
  const direct = nonEmptyString(obj?.taskId) ?? nonEmptyString(obj?.task_id)
  if (direct) return direct
  const text = updateTexts(update)
  const match = TASK_ID_IN_TEXT.exec(text) ?? TASK_CANCELLED_IN_TEXT.exec(text)
  return match?.[1] ? match[1].trim() : null
}

function shortTaskId(taskId: string): string {
  const slash = taskId.lastIndexOf('/')
  return slash >= 0 ? taskId.slice(slash + 1) : taskId
}

interface ParsedCommand {
  line: string
  title: string
  daemon: boolean
  notifyTimeoutSeconds: number | null
}

function parseCommand(update: acp.ToolCallUpdate): ParsedCommand | null {
  const input = record(update.rawInput)
  if (!input) return null
  const line = input.CommandLine
  if (typeof line !== 'string') return null
  const summary = nonEmptyString(input.toolSummary)
  return {
    line,
    title: summary ?? line,
    daemon: input.IsDaemon === true,
    notifyTimeoutSeconds: finitePositive(input.NotificationTimeoutSeconds),
  }
}

interface ParsedSchedule {
  title: string
  command: string
  daemon: boolean
  schedule: BackgroundTaskSchedule
}

function parseSchedule(update: acp.ToolCallUpdate, now: number): ParsedSchedule | null {
  const name = toolName(update)
  const isNamed = name === 'schedule' || update.title === 'Run schedule'
  const input = record(update.rawInput)
  if (!input) return null

  const durationSeconds = finiteNonNegative(input.DurationSeconds)
  const cron = nonEmptyString(input.CronExpression)
  if (durationSeconds === null && cron === null) return null
  if (!isNamed && name !== null) return null

  const prompt = nonEmptyString(input.Prompt)
  const promptTitle = prompt ? oneLine(prompt, SCHEDULE_TITLE_LIMIT) : null

  if (cron !== null) {
    const daemon = input.IsDaemon === true
    const maxIterations = finitePositive(input.MaxIterations)
    const command =
      maxIterations !== null ? `Cron: ${cron} (max ${Math.floor(maxIterations)})` : `Cron: ${cron}`
    return {
      title: promptTitle ?? `Cron (${cron})`,
      command,
      daemon,
      schedule: {
        mode: 'cron',
        cron,
        ...(daemon ? { daemon: true } : {}),
        ...(maxIterations !== null ? { maxIterations: Math.floor(maxIterations) } : {}),
      },
    }
  }

  const secs = durationSeconds!
  const formatted = formatScheduleDuration(secs)
  const condition = nonEmptyString(input.TimerCondition) ?? undefined
  const fireAt = now + Math.round(secs * 1000)
  const command =
    condition && condition !== 'never'
      ? `Timer: ${formatted} (cancel on ${condition})`
      : `Timer: ${formatted}`
  return {
    title: promptTitle ?? `Timer (${formatted})`,
    command,
    daemon: false,
    schedule: {
      mode: 'timer',
      durationSeconds: secs,
      fireAt,
      ...(condition ? { condition } : {}),
    },
  }
}

function parseManageTask(update: acp.ToolCallUpdate): ManageTaskCall | null {
  const name = toolName(update)
  if (name !== 'manage_task' && update.title !== 'Run manage_task') return null
  const input = record(update.rawInput)
  if (!input) return null
  const action = nonEmptyString(input.Action)
  if (action !== 'list' && action !== 'status' && action !== 'kill' && action !== 'send_input') {
    return null
  }
  return {
    action,
    taskId: nonEmptyString(input.TaskId),
  }
}

interface ListedAgyTask {
  taskId: string
  toolName?: string
  toolSummary?: string
  description?: string
}

function parseListedTasks(text: string): ListedAgyTask[] | null {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
    if (!Array.isArray(parsed)) return null
    const items: ListedAgyTask[] = []
    for (const raw of parsed) {
      const obj = record(raw)
      const taskId = nonEmptyString(obj?.taskId)
      if (!taskId) continue
      items.push({
        taskId,
        toolName: nonEmptyString(obj?.toolName) ?? undefined,
        toolSummary: nonEmptyString(obj?.toolSummary) ?? undefined,
        description: nonEmptyString(obj?.description) ?? undefined,
      })
    }
    return items
  } catch {
    return null
  }
}

function callStatusToTaskStatus(call: acp.ToolCallStatus): BackgroundTaskView['status'] {
  return call === 'completed' ? 'completed' : call === 'failed' ? 'failed' : 'running'
}

/** One session's background commands, timeout monitors, and scheduled timers/crons. */
export class AgyCommands {
  private readonly calls = new Map<string, TrackedTask>()
  private readonly manageCalls = new Map<string, ManageTaskCall>()
  private readonly onChange: (() => void) | null
  private readonly now: () => number
  private waiting = false

  constructor(options: AgyCommandsOptions = {}) {
    this.onChange = options.onChange ?? null
    this.now = options.now ?? Date.now
  }

  /**
   * Follows one of agy's tool call updates: in a turn every command/schedule/manage_task call,
   * between turns updates for tasks that outlived their turn. True when the board list changed.
   */
  follow(update: acp.ToolCallUpdate, inTurn: boolean, now = this.now()): boolean {
    const prevScheduled = this.scheduledCount
    const changed = this.followInner(update, inTurn, now)
    return changed || this.scheduledCount !== prevScheduled
  }

  private followInner(update: acp.ToolCallUpdate, inTurn: boolean, now: number): boolean {
    const managed = this.followManageTask(update, now)
    if (managed !== null) return managed

    let known = this.calls.get(update.toolCallId)
    let created = false
    if (!known) {
      if (!inTurn) return false
      const parsedSchedule = parseSchedule(update, now)
      if (parsedSchedule) {
        known = {
          toolCallId: update.toolCallId,
          entryKind: 'schedule',
          kind: 'monitor',
          title: parsedSchedule.title,
          command: parsedSchedule.command,
          daemon: parsedSchedule.daemon,
          status: 'running',
          call: 'pending',
          startedAt: now,
          endedAt: null,
          summary: null,
          carried: false,
          shownInWait: this.waiting,
          schedule: parsedSchedule.schedule,
          taskId: null,
          expiryTimer: null,
        }
        this.calls.set(update.toolCallId, known)
        created = true
      } else {
        const parsedCommand = parseCommand(update)
        if (!parsedCommand) return false
        const isMonitor = parsedCommand.notifyTimeoutSeconds !== null
        known = {
          toolCallId: update.toolCallId,
          entryKind: 'command',
          kind: isMonitor ? 'monitor' : 'shell',
          title: parsedCommand.title,
          command: parsedCommand.line,
          daemon: parsedCommand.daemon,
          status: 'running',
          call: 'pending',
          startedAt: now,
          endedAt: null,
          summary: null,
          carried: false,
          shownInWait: this.waiting,
          ...(isMonitor
            ? {
                schedule: {
                  mode: 'timeout',
                  durationSeconds: parsedCommand.notifyTimeoutSeconds!,
                  fireAt: now + Math.round(parsedCommand.notifyTimeoutSeconds! * 1000),
                  ...(parsedCommand.daemon ? { daemon: true } : {}),
                },
              }
            : {}),
          taskId: null,
          expiryTimer: null,
        }
        this.calls.set(update.toolCallId, known)
        created = true
      }
    }

    const extractedTaskId = extractTaskId(update)
    if (extractedTaskId && !known.taskId) known.taskId = extractedTaskId

    const status = fromAgy(update).status
    if (!status) return false

    const wasVisible = known.carried || known.shownInWait
    if (status === known.call && !created) return false

    const text = updateTexts(update)

    if (known.entryKind === 'schedule') {
      return this.updateScheduleStatus(known, status, text, now, wasVisible)
    }

    const ended = status === 'completed' || status === 'failed'
    if (status === 'in_progress' && known.call === 'pending') {
      known.startedAt = now
      if (known.schedule?.mode === 'timeout' && known.schedule.durationSeconds !== undefined) {
        known.schedule = {
          ...known.schedule,
          fireAt: now + Math.round(known.schedule.durationSeconds * 1000),
        }
      }
    }
    known.call = status
    if (this.waiting && status === 'in_progress') known.shownInWait = true
    if (ended) {
      this.clearExpiryTimer(known)
      known.status = callStatusToTaskStatus(status)
      known.endedAt = now
      known.summary = commandEnding(update) ?? known.summary
    } else {
      known.status = 'running'
    }
    return known.carried || known.shownInWait || wasVisible
  }

  /**
   * Exposes still-running commands, monitors, and schedules on the session board when the open
   * prompt settles into idle background wait so they are visible before the prompt resolves.
   */
  setWaiting(waiting: boolean, now = this.now()): boolean {
    this.waiting = waiting
    if (!waiting) return false
    let changed = this.sweep(now)
    for (const task of this.calls.values()) {
      if (task.carried || task.shownInWait) continue
      if (this.isActivelyRunning(task)) {
        task.shownInWait = true
        changed = true
      }
    }
    return changed
  }

  /**
   * Called when background activity wakes the session out of idle wait (not user steering):
   * clears expired one-shot timers and cancels timers whose `TimerCondition` matches a wakeup.
   */
  onWakeup(now = this.now(), senderId?: string): boolean {
    let changed = this.sweep(now)
    for (const task of this.calls.values()) {
      if (task.status !== 'running' || task.schedule?.mode !== 'timer') continue
      const condition = task.schedule.condition
      if (!condition || condition === 'never') continue
      if (condition === 'any' || (senderId !== undefined && condition === senderId)) {
        this.finishTask(task, 'stopped', now, 'Cancelled by wakeup')
        changed = true
      }
    }
    return changed
  }

  /**
   * Called when a specific sub-agent or sender delivers a completion/message event so any one-shot
   * timer waiting on that `TimerCondition` is cleared promptly.
   */
  onSenderEvent(senderId: string, now = this.now()): boolean {
    if (!senderId) return false
    let changed = false
    for (const task of this.calls.values()) {
      if (task.status !== 'running' || task.schedule?.mode !== 'timer') continue
      const condition = task.schedule.condition
      if (condition === 'any' || condition === senderId) {
        this.finishTask(task, 'stopped', now, 'Cancelled by message')
        changed = true
      }
    }
    return changed
  }

  /** Expires any one-shot timers that have passed their scheduled fire time. */
  sweep(now = this.now()): boolean {
    let changed = false
    for (const task of this.calls.values()) {
      if (task.status !== 'running' || task.schedule?.mode !== 'timer') continue
      const fireAt = task.schedule.fireAt
      if (fireAt !== undefined && now >= fireAt) {
        this.finishTask(task, 'completed', now, 'Timer fired')
        changed = true
      }
    }
    return changed
  }

  /**
   * Keeps tasks still running past the turn:
   * - daemon commands and daemon crons carry forward even on an aborted turn,
   * - non-daemon shell/monitor commands still `in_progress` carry forward on a normal turn end,
   * - non-daemon `schedule` timers/crons end when the open prompt finishes (`WaitForConversationFullyIdle`).
   */
  turnEnded(aborted = false, now = this.now()): boolean {
    this.waiting = false
    this.manageCalls.clear()
    let changed = false
    for (const [id, task] of this.calls) {
      if (task.carried) continue
      const keepSchedule = task.entryKind === 'schedule' && task.daemon && task.status === 'running'
      const keepCommand =
        task.entryKind === 'command' &&
        task.status === 'running' &&
        task.call === 'in_progress' &&
        (!aborted || task.daemon)
      if (keepSchedule || keepCommand) {
        task.carried = true
        task.shownInWait = false
        changed = true
      } else {
        this.clearExpiryTimer(task)
        if (task.shownInWait) changed = true
        this.calls.delete(id)
      }
    }
    if (this.sweep(now)) changed = true
    return changed
  }

  /** Whether a carried or background-wait command/monitor still runs. */
  get running(): boolean {
    for (const task of this.calls.values()) {
      if ((task.carried || (this.waiting && task.shownInWait)) && this.isActivelyRunning(task)) {
        return true
      }
    }
    return false
  }

  /** Number of active scheduled jobs (timers or recurring crons) tracked on this session. */
  get scheduledCount(): number {
    let count = 0
    for (const task of this.calls.values()) {
      if (task.entryKind === 'schedule' && task.status === 'running') count++
    }
    return count
  }

  /**
   * Whether the session has any known active background work (running background/monitored command
   * or active schedule timer/cron), even before `waitingBackground` has been entered.
   */
  get hasActiveBackground(): boolean {
    for (const task of this.calls.values()) {
      if (this.isActivelyRunning(task)) return true
    }
    return false
  }

  /** What the session board lists: carried tasks and tasks surfaced during background wait. */
  tasks(): BackgroundTaskView[] {
    return [...this.calls.values()]
      .filter((task) => task.carried || task.shownInWait)
      .map((task) => ({
        id: task.toolCallId,
        kind: task.kind,
        title: task.title,
        command: task.command,
        status: task.status,
        startedAt: task.startedAt,
        endedAt: task.endedAt,
        summary: task.summary,
        entryId: `t:${task.toolCallId}`,
        ...(task.schedule ? { schedule: { ...task.schedule } } : {}),
      }))
  }

  /** Clears all internal expiration timers when a session closes or unregisters. */
  dispose(): void {
    for (const task of this.calls.values()) this.clearExpiryTimer(task)
    this.calls.clear()
    this.manageCalls.clear()
  }

  private isActivelyRunning(task: TrackedTask): boolean {
    if (task.status !== 'running') return false
    if (task.entryKind === 'schedule') return true
    return task.call === 'in_progress'
  }

  private updateScheduleStatus(
    task: TrackedTask,
    status: acp.ToolCallStatus,
    text: string,
    now: number,
    wasVisible: boolean,
  ): boolean {
    if (status === 'in_progress') {
      if (task.call === 'pending') {
        task.startedAt = now
        if (task.schedule?.mode === 'timer' && task.schedule.durationSeconds !== undefined) {
          task.schedule = {
            ...task.schedule,
            fireAt: now + Math.round(task.schedule.durationSeconds * 1000),
          }
        }
      }
      task.call = status
      task.status = 'running'
      if (this.waiting) task.shownInWait = true
      this.armExpiryTimer(task, now)
      return task.carried || task.shownInWait || wasVisible
    }

    if (status === 'pending') {
      task.call = status
      return false
    }

    task.call = status
    if (status === 'failed') {
      this.finishTask(task, 'failed', now, text.trim() || null)
      return task.carried || task.shownInWait || wasVisible
    }

    // status === 'completed': distinguish between immediate background registration (the tool
    // returned immediately after arming a timer/cron) and genuine completion/cancellation.
    const saysEnded = ENDED_TEXT.test(text)
    const saysBackground = BG_RUNNING_TEXT.test(text)
    const elapsed = Math.max(0, now - task.startedAt)
    const fireAt = task.schedule?.fireAt
    const immediateRegister =
      !saysEnded &&
      (saysBackground ||
        (!task.shownInWait &&
          !task.carried &&
          elapsed < SCHEDULE_REGISTER_WINDOW_MS &&
          (task.schedule?.mode === 'cron' || (fireAt !== undefined && now < fireAt))))

    if (immediateRegister) {
      task.status = 'running'
      this.armExpiryTimer(task, now)
      return task.carried || task.shownInWait || wasVisible
    }

    const nextStatus = /cancel+ed|killed|stopped/i.test(text) ? 'stopped' : 'completed'
    this.finishTask(task, nextStatus, now, text.trim() || null)
    return task.carried || task.shownInWait || wasVisible
  }

  private followManageTask(update: acp.ToolCallUpdate, now: number): boolean | null {
    let call = this.manageCalls.get(update.toolCallId)
    const parsed = parseManageTask(update)
    if (parsed) {
      call = { action: parsed.action, taskId: parsed.taskId ?? call?.taskId ?? null }
      this.manageCalls.set(update.toolCallId, call)
    }
    if (!call) return null

    const status = fromAgy(update).status
    if (status !== 'completed' && status !== 'failed') return false
    this.manageCalls.delete(update.toolCallId)
    if (status === 'failed') return false

    const text = updateTexts(update)

    if (call.action === 'kill') {
      const targetId = call.taskId ?? extractTaskId(update)
      const target = this.findByTaskId(targetId) ?? this.singleRunningTask()
      if (!target || target.status !== 'running') return false
      const wasVisible = target.carried || target.shownInWait
      this.finishTask(target, 'stopped', now, 'Cancelled')
      return wasVisible || target.entryKind === 'schedule'
    }

    if (call.action === 'list') {
      if (NO_BG_TASKS_TEXT.test(text)) {
        let changed = false
        for (const task of this.calls.values()) {
          if (task.status !== 'running') continue
          const wasVisible = task.carried || task.shownInWait
          this.finishTask(task, 'completed', now, null)
          if (wasVisible || task.entryKind === 'schedule') changed = true
        }
        return changed
      }
      const listed = parseListedTasks(text)
      if (!listed) return false
      return this.reconcileListedTasks(listed, now)
    }

    if (call.action === 'status' && call.taskId) {
      const target = this.findByTaskId(call.taskId)
      if (target && target.status === 'running' && ENDED_TEXT.test(text)) {
        const wasVisible = target.carried || target.shownInWait
        const nextStatus = /cancel+ed|killed|stopped/i.test(text) ? 'stopped' : 'completed'
        this.finishTask(target, nextStatus, now, text.trim() || null)
        return wasVisible || target.entryKind === 'schedule'
      }
    }

    return false
  }

  private reconcileListedTasks(listed: readonly ListedAgyTask[], now: number): boolean {
    const liveIds = new Set<string>()
    const liveShortIds = new Set<string>()
    for (const item of listed) {
      liveIds.add(item.taskId)
      liveShortIds.add(shortTaskId(item.taskId))
      this.bindListedTaskId(item)
    }
    let changed = false
    for (const task of this.calls.values()) {
      if (task.status !== 'running' || !task.taskId) continue
      if (liveIds.has(task.taskId) || liveShortIds.has(shortTaskId(task.taskId))) continue
      const wasVisible = task.carried || task.shownInWait
      this.finishTask(task, 'completed', now, null)
      if (wasVisible || task.entryKind === 'schedule') changed = true
    }
    return changed
  }

  private bindListedTaskId(item: ListedAgyTask): void {
    if (this.findByTaskId(item.taskId)) return
    const candidates = [...this.calls.values()].filter((task) => {
      if (task.status !== 'running' || task.taskId !== null) return false
      if (item.toolName === 'schedule' && task.entryKind !== 'schedule') return false
      if (item.toolName === 'run_command' && task.entryKind !== 'command') return false
      if (
        item.description &&
        task.schedule?.cron &&
        item.description.includes(task.schedule.cron)
      ) {
        return true
      }
      if (item.description && task.command && item.description.includes(task.command)) {
        return true
      }
      if (item.toolSummary && task.title === item.toolSummary) return true
      return false
    })
    if (candidates.length === 1) {
      candidates[0]!.taskId = item.taskId
    }
  }

  private findByTaskId(taskId: string | null): TrackedTask | null {
    if (!taskId) return null
    const needleShort = shortTaskId(taskId)
    for (const task of this.calls.values()) {
      if (task.toolCallId === taskId) return task
      if (task.taskId && (task.taskId === taskId || shortTaskId(task.taskId) === needleShort)) {
        return task
      }
    }
    return null
  }

  private singleRunningTask(): TrackedTask | null {
    let only: TrackedTask | null = null
    for (const task of this.calls.values()) {
      if (!this.isActivelyRunning(task)) continue
      if (only !== null) return null
      only = task
    }
    return only
  }

  private finishTask(
    task: TrackedTask,
    status: Exclude<BackgroundTaskView['status'], 'running'>,
    now: number,
    summary: string | null,
  ): void {
    this.clearExpiryTimer(task)
    task.status = status
    task.endedAt = now
    if (summary !== null) task.summary = summary
  }

  private armExpiryTimer(task: TrackedTask, now: number): void {
    if (!this.onChange || task.schedule?.mode !== 'timer' || task.schedule.fireAt === undefined) {
      return
    }
    this.clearExpiryTimer(task)
    const delay = Math.max(0, task.schedule.fireAt - now) + TIMER_EXPIRY_GRACE_MS
    // Avoid Node's 32-bit signed timeout overflow on very long durations.
    if (delay > 2_147_483_647) return
    task.expiryTimer = setTimeout(() => {
      task.expiryTimer = null
      if (task.status !== 'running') return
      this.finishTask(task, 'completed', this.now(), 'Timer fired')
      this.onChange?.()
    }, delay)
    task.expiryTimer.unref?.()
  }

  private clearExpiryTimer(task: TrackedTask): void {
    if (task.expiryTimer) {
      clearTimeout(task.expiryTimer)
      task.expiryTimer = null
    }
  }
}
