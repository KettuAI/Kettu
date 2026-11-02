// The Routines page: every routine as a row of a table, with its schedule, agent and last run.

import { useEffect, useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  CalendarClockIcon,
  CalendarIcon,
  CheckIcon,
  CircleAlertIcon,
  PauseIcon,
  PlusIcon,
  XIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { RoutineView } from '@shared/routines'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
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
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@renderer/components/ui/empty'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { Switch } from '@renderer/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { CornerControls } from '@renderer/features/shell/top-bar'
import { basename, longAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { hasBand } from '@renderer/lib/platform'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { agentName } from '@renderer/stores/agents'
import { useProjectsStore } from '@renderer/stores/projects'
import { useRoutinesStore } from '@renderer/stores/routines'
import { useSettingsStore } from '@renderer/stores/settings'
import { openRoutine, useViewStore } from '@renderer/stores/view'
import { openActiveRun } from './actions'
import { DeleteRoutineDialog } from './delete-routine-dialog'
import {
  lastRunCell,
  nextRunText,
  offRoutines,
  onRoutines,
  pauseNotice,
  routineProject,
  rowDescription,
  runDay,
  runStatus,
  scheduleWords,
  sinceTime,
} from './model'
import { RoutineMenuItems } from './routine-menu'
import { RunAnnouncements } from './run-history'

/** The table's columns: routine, schedule, agent, last run and the switch; two of them narrow. */
const COLUMNS =
  'grid grid-cols-[minmax(0,2.4fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1.5fr)_44px] items-center gap-4 px-3 @max-[48rem]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_44px]'

/** The columns that give way in a narrow sheet, the schedule staying under the name. */
const WIDE_ONLY = '@max-[48rem]:hidden'

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
  const openAtLogin = useSettingsStore((s) => s.settings.general.openAtLogin)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  useEffect(() => {
    if (!useRoutinesStore.getState().loaded) void useRoutinesStore.getState().load()
  }, [])

  // On first, those that need the user leading, then Off, which the rows' dimming tells apart.
  const all = useMemo(() => [...onRoutines(routines), ...offRoutines(routines)], [routines])
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

  const enableOpenAtLogin = () => {
    setError(null)
    useSettingsStore
      .getState()
      .update({ general: { openAtLogin: true } })
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

  let body: ReactNode = null
  if (!loaded) {
    body = <LoadingTable />
  } else if (empty) {
    body = (
      <Empty className="py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CalendarClockIcon />
          </EmptyMedia>
          <EmptyTitle>{t('page.emptyTitle')}</EmptyTitle>
          <EmptyDescription>{t('page.emptyDescription')}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" onClick={() => openRoutine(null)}>
            <PlusIcon data-icon="inline-start" />
            {t('page.new')}
          </Button>
        </EmptyContent>
      </Empty>
    )
  } else if (all.length > 0) {
    body = (
      <div className="@container flex flex-col">
        <ColumnHeads />
        <div
          role="list"
          aria-label={t('page.title')}
          onKeyDown={moveRowFocus}
          className="flex flex-col"
        >
          {all.map((routine) => (
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
        </div>
        <div className="h-px bg-border-soft" />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <PageStrip />
      <div className="min-h-0 flex-1 scroll-fade-y overflow-y-auto px-9 pb-10 [scrollbar-gutter:stable]">
        {/* Block flow, so a notice's margin and the foot's meet as one gap. */}
        <div className="mx-auto w-full max-w-270">
          <RunAnnouncements />
          <header className="mb-6 flex items-start gap-4">
            <div className="min-w-0 flex-1">
              <h1 className="font-display text-title font-bold">{t('page.title')}</h1>
              <p className="mt-1.5 text-row text-tertiary">{t('page.description')}</p>
            </div>
            {!empty && (
              <Button
                onClick={() => openRoutine(null)}
                className="h-8.5 gap-1.5 rounded-xl pr-3.5 pl-2.5 text-row"
              >
                <PlusIcon data-icon="inline-start" />
                {t('page.new')}
              </Button>
            )}
          </header>
          {notices.length > 0 && <div className="mb-5.5 flex flex-col gap-2">{notices}</div>}
          {body}
          {loaded && (
            <p className={cn('mt-4 text-control text-tertiary', !empty && 'mx-3')}>
              {t('page.footnote')}
              {!openAtLogin && (
                <>
                  {' '}
                  <Button
                    variant="link"
                    size="xs"
                    onClick={enableOpenAtLogin}
                    className="h-auto px-0 align-baseline text-control text-secondary"
                  >
                    {t('page.openAtLoginAction')}
                  </Button>
                </>
              )}
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

/**
 * The strip of sheet above the page, which drags the window. On macOS with the sidebar collapsed
 * it is a top bar's height, beside the traffic lights, and holds the sidebar toggle.
 */
function PageStrip() {
  const cornered = useViewStore((s) => s.sidebarCollapsed) && !hasBand
  return (
    <div
      className={cn(
        'app-region-drag flex shrink-0 items-center',
        cornered ? 'h-top-bar pl-(--corner-inset)' : 'h-8',
      )}
    >
      {cornered && <CornerControls className="-ml-1" />}
    </div>
  )
}

function ColumnHeads() {
  const { t } = useTranslation('routines')
  return (
    // Each row's button names and describes the routine, so the heads are for the eye only.
    <div aria-hidden className={cn(COLUMNS, 'h-8 text-small font-medium text-tertiary')}>
      <span>{t('page.columns.routine')}</span>
      <span className={WIDE_ONLY}>{t('page.columns.schedule')}</span>
      <span className={WIDE_ONLY}>{t('page.columns.agent')}</span>
      <span>{t('page.columns.lastRun')}</span>
      <span />
    </div>
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
  const projectName =
    project?.name ??
    (routine.projectPath === null ? t('routine.noProject') : basename(routine.projectPath))

  const toggle = (enabled: boolean) => {
    useRoutinesStore
      .getState()
      .update(routine.id, { enabled })
      .catch((error: unknown) => onError(errorMessage(error)))
  }

  return (
    <ContextMenu onOpenChange={setContextOpen}>
      <div
        role="listitem"
        className={cn(
          COLUMNS,
          'relative min-h-16 shadow-[inset_0_1px_0_var(--border-subtle)]',
          off && '*:data-dims:opacity-60',
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
              aria-describedby={`${id}-line ${id}-schedule ${id}-agent ${id}-last`}
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
              className="absolute inset-0 rounded-lg transition-colors duration-(--duration-fast) outline-none focus-ring hover:bg-hover data-held:bg-hover"
            />
          }
        />
        <span
          data-dims=""
          className="pointer-events-none relative flex min-w-0 flex-col gap-0.75 py-2.5"
        >
          <span className="truncate text-row leading-tight font-medium text-primary">{name}</span>
          <span id={`${id}-line`} className="truncate text-control leading-tight text-tertiary">
            <span aria-hidden className="hidden @max-[48rem]:inline">
              {schedule} ·{' '}
            </span>
            {rowDescription(routine, projectName)}
          </span>
        </span>
        <span
          id={`${id}-schedule`}
          data-dims=""
          className={cn(
            'pointer-events-none relative truncate text-[13.5px] text-secondary',
            WIDE_ONLY,
          )}
        >
          {schedule}
        </span>
        <span
          data-dims=""
          className={cn(
            'pointer-events-none relative flex min-w-0 items-center gap-2 text-[13.5px] text-secondary',
            WIDE_ONLY,
          )}
        >
          <AgentMark agent={routine.agentId} size={16} />
          <span id={`${id}-agent`} className="truncate">
            {agentName(routine.agentId)}
          </span>
        </span>
        {/* Above the row's button, so only what is interactive here takes the pointer. */}
        <span data-dims="" id={`${id}-last`} className="pointer-events-none relative min-w-0">
          <LastRun routine={routine} tabbable={tabbable} onError={onError} />
        </span>
        <span data-dims="" className="pointer-events-none relative flex justify-end">
          <Switch
            className="pointer-events-auto"
            checked={routine.enabled}
            onCheckedChange={toggle}
            tabIndex={tabbable ? 0 : -1}
            aria-label={t(routine.enabled ? 'page.switchOff' : 'page.switchOn', { name })}
          />
        </span>
        <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                tabIndex={-1}
                aria-hidden
                className="absolute right-3 bottom-2 size-0"
              />
            }
          />
          <DropdownMenuContent align="end" side="bottom">
            <RoutineMenuItems
              routine={routine}
              onRunNow={onRunNow}
              onDelete={onDelete}
              onError={onError}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ContextMenuContent side="bottom" align="start">
        <RoutineMenuItems
          routine={routine}
          onRunNow={onRunNow}
          onDelete={onDelete}
          onError={onError}
        />
      </ContextMenuContent>
    </ContextMenu>
  )
}

const CELL_ICON = 'size-3.5 shrink-0'

/** The Last run cell: a run at work or waiting, a pause, how the last run ended, or the next. */
function LastRun({
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
  const line = 'pointer-events-none flex min-w-0 items-center gap-1.5 text-control'
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
              className="pointer-events-auto shrink-0"
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
          <Spinner aria-hidden className="size-3 shrink-0" />
          <span className="truncate">
            {cell.status === 'starting'
              ? t('state.starting')
              : cell.since === null
                ? t('state.running')
                : t('state.runningSince', { time: sinceTime(cell.since, now) })}
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
            <XIcon aria-hidden strokeWidth={1.75} className="size-3.25 shrink-0" />
            <span className="truncate">
              {cell.at === null ? t('run.failed') : t('row.failed', { ago: longAgo(cell.at, now) })}
            </span>
            <span className="sr-only">{runStatus(cell.run)}</span>
          </TooltipTrigger>
          <TooltipContent className="max-w-80">{runStatus(cell.run)}</TooltipContent>
        </Tooltip>
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
    case 'next':
      return (
        <span className={cn(line, 'text-tertiary')}>
          <CalendarIcon aria-hidden className={CELL_ICON} />
          <span className="truncate">{nextRunText(cell.at, now)}</span>
        </span>
      )
    case 'done':
      return <span className={cn(line, 'text-tertiary')}>{t('state.done')}</span>
    case 'never':
      return <span className={cn(line, 'text-tertiary')}>{t('row.never')}</span>
  }
}

/** Skeleton rows at the rows' sizes, under the column heads. */
function LoadingTable() {
  return (
    <div aria-hidden className="@container flex flex-col">
      <ColumnHeads />
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className={cn(COLUMNS, 'min-h-16 shadow-[inset_0_1px_0_var(--border-subtle)]')}
        >
          <span className="flex flex-col gap-2">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-3/5" />
          </span>
          <Skeleton className={cn('h-3 w-3/5', WIDE_ONLY)} />
          <Skeleton className={cn('h-3 w-1/2', WIDE_ONLY)} />
          <Skeleton className="h-3 w-1/2" />
          <span />
        </div>
      ))}
      <div className="h-px bg-border-soft" />
    </div>
  )
}

/** The table is one Tab stop; the arrow keys move between its rows. */
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
