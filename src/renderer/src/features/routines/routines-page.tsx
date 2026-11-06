// The Routines page: the routines that are on and those that are off, each group a card of rows
// with their schedule, agent and status; with none yet, examples to start from.

import { useEffect, useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  ArrowRightIcon,
  CalendarIcon,
  CheckIcon,
  CircleAlertIcon,
  ClockIcon,
  EllipsisIcon,
  InfoIcon,
  PauseIcon,
  PlusIcon,
  XIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { RoutineView } from '@shared/routines'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { Switch } from '@renderer/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { TurnDots } from '@renderer/features/session/turn-dots'
import { basename, longAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { currentLocale } from '@renderer/lib/i18n'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { agentName } from '@renderer/stores/agents'
import { useProjectsStore } from '@renderer/stores/projects'
import { useRoutinesStore } from '@renderer/stores/routines'
import { openRoutine } from '@renderer/stores/view'
import { openActiveRun } from './actions'
import { DeleteRoutineDialog } from './delete-routine-dialog'
import { ROUTINE_EXAMPLES, routineExample, type RoutineExampleId } from './examples'
import { GroupHeading, PAGE_COLUMN, PageStrip } from './fields'
import {
  clockTime,
  lastRunCell,
  nextRunText,
  offRoutines,
  onRoutines,
  pauseNotice,
  routineProject,
  rowDescription,
  runDay,
  runningFor,
  runStatus,
  scheduleWords,
  sinceTime,
} from './model'
import { RoutineMenuItems } from './routine-menu'
import { RunAnnouncements } from './run-history'

/** The rows' columns: routine, schedule, agent, status, More and the switch; four when narrow. */
const COLUMNS =
  'grid grid-cols-[minmax(0,2.3fr)_minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,1.6fr)_28px_34px] items-center gap-x-5 px-4 @max-[48rem]:grid-cols-[minmax(0,1fr)_minmax(0,0.95fr)_28px_34px] @max-[48rem]:gap-x-3.5'

/** The columns that give way when narrow, the schedule and agent going under the name. */
const WIDE_ONLY = '@max-[48rem]:hidden'
const NARROW_ONLY = 'hidden @max-[48rem]:inline'

/** A row's line under the one above it in its card. */
const ROW_LINE = 'not-first:shadow-[inset_0_var(--hairline)_0_var(--border-subtle)]'

export default function RoutinesPage() {
  const { t } = useTranslation('routines')
  const routines = useRoutinesStore(
    useShallow((s) =>
      s.order.map((id) => s.byId[id]).filter((routine): routine is RoutineView => !!routine),
    ),
  )
  const loaded = useRoutinesStore((s) => s.loaded)
  const problem = useRoutinesStore((s) => s.problem)
  const loadError = useRoutinesStore((s) => s.error)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  useEffect(() => {
    if (!useRoutinesStore.getState().loaded) void useRoutinesStore.getState().load()
  }, [])

  // On first, those that need the user leading, then Off, which the rows' dimming tells apart.
  const on = useMemo(() => onRoutines(routines), [routines])
  const off = useMemo(() => offRoutines(routines), [routines])
  const all = useMemo(() => [...on, ...off], [on, off])
  const tabStop = active && all.some((routine) => routine.id === active) ? active : all[0]?.id
  // With nothing to list, the empty state holds the one New routine; with a notice, the header.
  const empty = loaded && all.length === 0 && !problem && !loadError

  const target = useRoutinesStore((s) => (deleting ? s.byId[deleting] : undefined))

  const runNow = (routine: RoutineView) => {
    setError(null)
    useRoutinesStore
      .getState()
      .runNow(routine.id)
      .catch((failure: unknown) => setError(errorMessage(failure)))
  }

  const notices: ReactNode[] = []
  if (problem) {
    notices.push(
      <Alert key="problem" variant="error">
        <CircleAlertIcon />
        <AlertTitle>{t('page.unreadableTitle')}</AlertTitle>
        <AlertDescription>
          {problem.backup
            ? t('page.unreadable', { backup: basename(problem.backup) })
            : t('page.unreadableGone')}
        </AlertDescription>
      </Alert>,
    )
  }
  if (loadError) {
    notices.push(
      <Alert key="load" variant="error" className="has-data-[slot=alert-action]:pr-28">
        <CircleAlertIcon />
        <AlertTitle>{t('page.loadFailed')}</AlertTitle>
        <AlertDescription>{loadError}</AlertDescription>
        <AlertAction className="top-1/2 right-3.5 -translate-y-1/2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void useRoutinesStore.getState().load()}
          >
            {t('page.retry')}
          </Button>
        </AlertAction>
      </Alert>,
    )
  }
  if (error) {
    notices.push(
      <Alert key="error" variant="error">
        <CircleAlertIcon />
        <AlertDescription>{error}</AlertDescription>
      </Alert>,
    )
  }

  const group = (label: string, list: RoutineView[], heads: boolean) => (
    <RoutineGroup label={label} count={list.length} heads={heads}>
      {list.map((routine) => (
        <RoutineRow
          key={routine.id}
          routine={routine}
          tabbable={routine.id === tabStop}
          onFocus={() => setActive(routine.id)}
          onRunNow={() => runNow(routine)}
          onDelete={() => setDeleting(routine.id)}
          onError={setError}
        />
      ))}
    </RoutineGroup>
  )

  let body: ReactNode = null
  if (!loaded) {
    body = <LoadingGroup />
  } else if (empty) {
    body = <Examples />
  } else if (all.length > 0) {
    body = (
      <div className="flex flex-col gap-7" onKeyDown={moveRowFocus}>
        {on.length > 0 && group(t('state.on'), on, true)}
        {off.length > 0 && group(t('state.off'), off, on.length === 0)}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <PageStrip />
      <div className="min-h-0 flex-1 scroll-fade-y overflow-y-auto px-9 pb-10 [scrollbar-gutter:stable]">
        {/* Block flow, so a notice's margin and the foot's meet as one gap. */}
        <div className={cn(PAGE_COLUMN, '@container')}>
          <RunAnnouncements />
          <header className="mb-7 flex items-start gap-4 pt-5">
            <div className="min-w-0 flex-1">
              <h1 className="font-display text-title font-semibold">{t('page.title')}</h1>
              <p className="mt-1.5 text-lede text-tertiary">{t('page.description')}</p>
            </div>
            {!empty && (
              <Button onClick={() => openRoutine(null)} className="pl-2.5">
                <PlusIcon data-icon="inline-start" />
                {t('page.new')}
              </Button>
            )}
          </header>
          {notices.length > 0 && <div className="mb-5.5 flex flex-col gap-2">{notices}</div>}
          {body}
          {loaded && (
            <p className="mt-4 flex items-center gap-2 px-4 text-hint text-tertiary">
              <InfoIcon aria-hidden className="size-3.5 shrink-0" />
              {t('page.footnote')}
            </p>
          )}
        </div>
      </div>
      {target && (
        <DeleteRoutineDialog
          routine={target}
          open
          onOpenChange={(open) => {
            if (!open) setDeleting(null)
          }}
        />
      )}
    </div>
  )
}

/** A group's card under its name and count, and the columns' names over the first group. */
function RoutineGroup({
  label,
  count,
  heads,
  children,
}: {
  label: string
  count: number
  heads: boolean
  children: ReactNode
}) {
  const { t } = useTranslation('routines')
  return (
    <section aria-label={label}>
      {/* Each row's button names and describes the routine, so the heads are for the eye only. */}
      <div aria-hidden className={cn(COLUMNS, 'h-7.5 text-small font-medium text-tertiary')}>
        <span className="flex items-baseline gap-1.75">
          <span className="text-control font-semibold text-primary">{label}</span>
          <span className="tabular">{count}</span>
        </span>
        {heads && (
          <>
            <span className={WIDE_ONLY}>{t('page.columns.schedule')}</span>
            <span className={WIDE_ONLY}>{t('page.columns.agent')}</span>
            <span>{t('page.columns.status')}</span>
          </>
        )}
      </div>
      <div
        role="list"
        aria-label={label}
        className="flex flex-col overflow-hidden rounded-card bg-card shadow-card"
      >
        {children}
      </div>
    </section>
  )
}

function RoutineRow({
  routine,
  tabbable,
  onFocus,
  onRunNow,
  onDelete,
  onError,
}: {
  routine: RoutineView
  tabbable: boolean
  onFocus: () => void
  onRunNow: () => void
  onDelete: () => void
  onError: (message: string) => void
}) {
  const { t } = useTranslation('routines')
  const projects = useProjectsStore((s) => s.projects)
  const id = useId()
  const [moreOpen, setMoreOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const project = routineProject(routine, projects)
  const off = !routine.enabled
  const name = routine.name
  const schedule = scheduleWords(routine.trigger.schedule)
  const agent = agentName(routine.agentId)
  const projectName =
    project?.name ??
    (routine.projectPath === null ? t('routine.noProject') : basename(routine.projectPath))

  const toggle = (enabled: boolean) => {
    useRoutinesStore
      .getState()
      .update(routine.id, { enabled })
      .catch((error: unknown) => onError(errorMessage(error)))
  }

  const items = (
    <RoutineMenuItems
      routine={routine}
      onOpen={() => openRoutine(routine.id)}
      onRunNow={onRunNow}
      onToggle={toggle}
      onDelete={onDelete}
    />
  )

  return (
    <ContextMenu onOpenChange={setContextOpen}>
      <div
        role="listitem"
        className={cn(
          COLUMNS,
          ROW_LINE,
          'group/row relative min-h-16',
          off && '*:data-dims:opacity-55',
        )}
      >
        <ContextMenuTrigger
          render={
            <button
              type="button"
              data-routine-row=""
              data-held={moreOpen || contextOpen || undefined}
              tabIndex={tabbable ? 0 : -1}
              aria-label={t('page.open', { name })}
              aria-describedby={`${id}-line ${id}-schedule ${id}-agent ${id}-status`}
              onClick={() => openRoutine(routine.id)}
              onFocus={onFocus}
              onKeyDown={(event) => {
                // The context menu key opens the row's menu, for the keyboard.
                if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                  event.preventDefault()
                  setMoreOpen(true)
                } else if (event.key === 'Enter' || event.key === ' ') {
                  // The trigger takes the key before the button activates itself.
                  event.preventDefault()
                  openRoutine(routine.id)
                }
              }}
              className="absolute inset-0 transition-colors duration-(--duration-fast) outline-none focus-ring hover:bg-hover focus-visible:rounded-card focus-visible:-outline-offset-2 data-held:bg-hover"
            />
          }
        />
        <span
          data-dims=""
          className="pointer-events-none relative flex min-w-0 flex-col gap-0.5 py-3"
        >
          <span className="truncate text-row font-medium text-primary">{name}</span>
          <span id={`${id}-line`} className="truncate text-hint text-tertiary">
            <span className={WIDE_ONLY}>{rowDescription(routine, projectName)}</span>
            <span aria-hidden className={NARROW_ONLY}>
              {schedule} · {agent}
            </span>
          </span>
        </span>
        <span
          id={`${id}-schedule`}
          data-dims=""
          className={cn(
            'pointer-events-none relative truncate text-control text-secondary',
            WIDE_ONLY,
          )}
        >
          {schedule}
        </span>
        <span
          data-dims=""
          className={cn(
            'pointer-events-none relative flex min-w-0 items-center gap-2 text-control text-secondary',
            WIDE_ONLY,
          )}
        >
          <AgentMark agent={routine.agentId} size={16} />
          <span id={`${id}-agent`} className="truncate">
            {agent}
          </span>
        </span>
        {/* Above the row's button, so only what is interactive here takes the pointer. */}
        <span data-dims="" id={`${id}-status`} className="pointer-events-none relative min-w-0">
          <StatusCell routine={routine} tabbable={tabbable} onError={onError} />
        </span>
        <span className="relative flex justify-center">
          <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="quiet"
                  size="icon-sm"
                  tabIndex={-1}
                  aria-label={t('routine.more')}
                  className="opacity-0 group-hover/row:opacity-100 data-popup-open:opacity-100"
                />
              }
            >
              <EllipsisIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="bottom">
              {items}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
        <span className="relative flex justify-end">
          <Switch
            size="md"
            checked={routine.enabled}
            onCheckedChange={toggle}
            tabIndex={tabbable ? 0 : -1}
            aria-label={t(routine.enabled ? 'page.switchOff' : 'page.switchOn', { name })}
          />
        </span>
      </div>
      <ContextMenuContent side="bottom" align="start">
        {items}
      </ContextMenuContent>
    </ContextMenu>
  )
}

const CELL_ICON = 'size-3.5 shrink-0'

/** The Status cell: a run at work or waiting, a pause, a failure, the next run, or the last. */
function StatusCell({
  routine,
  tabbable,
  onError,
}: {
  routine: RoutineView
  tabbable: boolean
  onError: (message: string) => void
}) {
  const { t } = useTranslation('routines')
  const now = useNow()
  const cell = lastRunCell(routine)
  const line = 'pointer-events-none flex min-w-0 items-center gap-2 text-control'
  switch (cell.kind) {
    case 'waiting': {
      const openRun = () => {
        openActiveRun(routine).catch((error: unknown) => onError(errorMessage(error)))
      }
      return (
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn(line, 'text-attention')}>
            <span aria-hidden className="size-1.75 shrink-0 rounded-full bg-attention-dot" />
            <span className="truncate">
              {cell.since === null
                ? t('state.waiting')
                : t('row.waitingSince', { time: sinceTime(cell.since, now) })}
            </span>
          </span>
          {routine.activeRun?.sessionId && (
            <Button
              variant="outline"
              size="xs"
              tabIndex={tabbable ? 0 : -1}
              onClick={openRun}
              className={cn('pointer-events-auto shrink-0', WIDE_ONLY)}
            >
              {t('routine.openRun')}
            </Button>
          )}
        </span>
      )
    }
    case 'running':
      return (
        <span className={cn(line, 'text-secondary')}>
          {cell.status === 'starting' ? (
            <Spinner aria-hidden className="size-3 shrink-0" />
          ) : (
            <TurnDots phase="working" />
          )}
          <span className="truncate">
            {cell.status === 'starting'
              ? t('state.starting')
              : cell.since === null
                ? t('state.running')
                : t('row.running', { duration: runningFor(cell.since, now) })}
          </span>
        </span>
      )
    case 'queued':
      return <span className={cn(line, 'text-tertiary')}>{t('state.queued')}</span>
    case 'paused': {
      const text = t(cell.pause?.usedPercent === null ? 'row.pausedReached' : 'row.pausedNear')
      return (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className={cn(line, 'pointer-events-auto w-fit max-w-full text-warning')} />
            }
          >
            <PauseIcon aria-hidden className={CELL_ICON} />
            <span className="truncate">{text}</span>
            {cell.pause && <span className="sr-only">{pauseNotice(cell.pause, now)}</span>}
          </TooltipTrigger>
          {cell.pause && (
            <TooltipContent className="max-w-80">{pauseNotice(cell.pause, now)}</TooltipContent>
          )}
        </Tooltip>
      )
    }
    case 'failed':
      return (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className={cn(line, 'pointer-events-auto w-fit max-w-full text-danger')} />
            }
          >
            <XIcon aria-hidden strokeWidth={1.75} className={CELL_ICON} />
            <span className="truncate">
              {cell.at === null ? t('run.failed') : t('row.failed', { ago: longAgo(cell.at, now) })}
            </span>
            <span className="sr-only">{runStatus(cell.run)}</span>
          </TooltipTrigger>
          <TooltipContent className="max-w-80">{runStatus(cell.run)}</TooltipContent>
        </Tooltip>
      )
    case 'next':
      return (
        <span className={cn(line, 'text-secondary')}>
          <CalendarIcon aria-hidden className={cn(CELL_ICON, 'text-tertiary')} />
          <span className="truncate">{nextRunText(cell.at, now)}</span>
        </span>
      )
    case 'succeeded':
      return (
        <span className={cn(line, 'text-secondary')}>
          <CheckIcon aria-hidden strokeWidth={1.75} className={cn(CELL_ICON, 'text-success')} />
          <span className="truncate">
            {cell.at === null ? t('run.succeeded') : runDay(cell.at, now)}
          </span>
        </span>
      )
    case 'ended':
      return (
        <span className={cn(line, 'text-tertiary')}>
          <span className="truncate">
            {cell.at === null
              ? t(`row.${cell.status}`)
              : t(`row.${cell.status}At`, { when: runDay(cell.at, now) })}
          </span>
        </span>
      )
    case 'done':
      return (
        <span className={cn(line, 'text-tertiary')}>
          <CheckIcon aria-hidden strokeWidth={1.75} className={CELL_ICON} />
          <span className="truncate">{t('state.done')}</span>
        </span>
      )
    case 'never':
      return <span className={cn(line, 'text-tertiary')}>{t('row.never')}</span>
  }
}

/** Skeleton rows at the rows' sizes, in a group's card. */
function LoadingGroup() {
  return (
    <div aria-hidden className="flex flex-col">
      <div className={cn(COLUMNS, 'h-7.5')}>
        <Skeleton className="h-3 w-12" />
      </div>
      <div className="flex flex-col overflow-hidden rounded-card bg-card shadow-card">
        {[0, 1, 2].map((i) => (
          <div key={i} className={cn(COLUMNS, ROW_LINE, 'min-h-16')}>
            <span className="flex flex-col gap-2">
              <Skeleton className="h-3.5 w-2/5" />
              <Skeleton className="h-3 w-3/5" />
            </span>
            <Skeleton className={cn('h-3 w-3/5', WIDE_ONLY)} />
            <Skeleton className={cn('h-3 w-1/2', WIDE_ONLY)} />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    </div>
  )
}

/** With no routines: what a routine is and New routine, then examples to start from. */
function Examples() {
  const { t } = useTranslation('routines')
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-10 rounded-card bg-card py-7 pr-8 pl-7 shadow-card">
        <div className="min-w-0 flex-1">
          <h2 className="text-heading font-semibold">{t('page.emptyTitle')}</h2>
          <p className="mt-1.5 max-w-130 text-lede text-pretty text-secondary">
            {t('page.emptyDescription')}
          </p>
          <Button onClick={() => openRoutine(null)} className="mt-5 pl-2.5">
            <PlusIcon data-icon="inline-start" />
            {t('page.new')}
          </Button>
        </div>
        <WeekSketch />
      </div>
      <GroupHeading title={t('examples.heading')} hint={t('examples.hint')} className="mt-7" />
      <div className="grid grid-cols-3 gap-3 @max-[56rem]:grid-cols-2 @max-[34rem]:grid-cols-1">
        {ROUTINE_EXAMPLES.map((id) => (
          <ExampleCard key={id} id={id} />
        ))}
      </div>
    </div>
  )
}

function ExampleCard({ id }: { id: RoutineExampleId }) {
  const { t } = useTranslation('routines')
  const example = routineExample(id)
  const level = t(`permission.level.${example.scope.level}.name`)
  return (
    <button
      type="button"
      aria-label={t('examples.open', { name: example.name })}
      onClick={() => openRoutine(null, { example: id })}
      className="group/example flex min-h-35 flex-col rounded-card bg-card px-4 pt-4 pb-3.5 text-left shadow-card transition-shadow duration-(--duration-fast) outline-none focus-ring hover:shadow-outline-hover"
    >
      <span className="flex w-full items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-row font-medium">{example.name}</span>
        <span
          aria-hidden
          className="flex shrink-0 items-center gap-1 text-hint font-medium text-secondary opacity-0 transition-opacity duration-(--duration-fast) group-hover/example:opacity-100 group-focus-visible/example:opacity-100"
        >
          {t('examples.use')}
          <ArrowRightIcon className="size-3.5" />
        </span>
      </span>
      <span className="mt-1 line-clamp-2 text-hint text-tertiary">{example.prompt}</span>
      <span className="mt-auto flex flex-wrap gap-1.5 pt-3.5">
        <Badge variant="neutral">
          <ClockIcon data-icon="inline-start" className="text-tertiary" />
          {scheduleWords(example.schedule)}
        </Badge>
        <Badge variant="neutral">{example.scope.web ? t('examples.web', { level }) : level}</Badge>
      </span>
    </button>
  )
}

/** A week of runs at one time on weekdays, the empty state's picture of a routine. */
function WeekSketch() {
  const days = [1, 2, 3, 4, 5, 6, 0]
  const weekday = new Intl.DateTimeFormat(currentLocale(), { weekday: 'narrow' })
  return (
    <div
      aria-hidden
      className="flex shrink-0 items-start gap-3.5 rounded-card bg-subtle px-5.5 pt-4.5 pb-3.5 @max-[48rem]:hidden"
    >
      <span className="mt-1.75 font-mono text-count text-tertiary">
        {clockTime(new Date(2024, 0, 1, 9).getTime())}
      </span>
      <span className="relative flex gap-3">
        <span className="absolute inset-x-[-6px] top-3.25 border-t border-dashed border-strong" />
        {days.map((day) => (
          <span key={day} className="flex w-4.5 flex-col items-center gap-2.25">
            <span
              className={cn(
                'relative mt-2.25 size-2.5 rounded-full',
                day >= 1 && day <= 5
                  ? 'bg-attention-dot shadow-[0_0_0_3px_color-mix(in_srgb,var(--attention-dot)_18%,transparent)]'
                  : 'bg-subtle shadow-[inset_0_0_0_1.5px_var(--border-strong)]',
              )}
            />
            <span className="text-count font-medium text-tertiary">
              {weekday.format(new Date(2024, 0, 7 + day))}
            </span>
          </span>
        ))}
      </span>
    </div>
  )
}

/** The page's rows are one Tab stop; the arrow keys move between them, across the groups. */
function moveRowFocus(event: KeyboardEvent<HTMLDivElement>): void {
  const target = event.target
  if (!(target instanceof HTMLElement) || !target.hasAttribute('data-routine-row')) return
  if (
    event.key !== 'ArrowDown' &&
    event.key !== 'ArrowUp' &&
    event.key !== 'Home' &&
    event.key !== 'End'
  )
    return
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-routine-row]'))
  if (!rows.length) return
  const at = rows.indexOf(target)
  let next = at
  if (event.key === 'ArrowDown') next = at < 0 ? 0 : Math.min(rows.length - 1, at + 1)
  if (event.key === 'ArrowUp') next = at < 0 ? rows.length - 1 : Math.max(0, at - 1)
  if (event.key === 'Home') next = 0
  if (event.key === 'End') next = rows.length - 1
  event.preventDefault()
  rows[next]?.focus()
}
