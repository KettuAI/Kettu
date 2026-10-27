// The Routines page: every routine as a timetable, on and off, led by its next run or its state.

import { useEffect, useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  CalendarClockIcon,
  ChartNoAxesColumnIcon,
  CircleAlertIcon,
  PlusIcon,
  PowerIcon,
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
import { TopBar } from '@renderer/features/shell/top-bar'
import { basename } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { agentName } from '@renderer/stores/agents'
import { useProjectsStore } from '@renderer/stores/projects'
import { useRoutinesStore } from '@renderer/stores/routines'
import { useSettingsStore } from '@renderer/stores/settings'
import { openRoutine } from '@renderer/stores/view'
import { openActiveRun } from './actions'
import { DeleteRoutineDialog } from './delete-routine-dialog'
import { HEADING, ROW_SLOT } from './fields'
import {
  agentPauses,
  clockTime,
  failedRun,
  offRoutines,
  onRoutines,
  pauseNotice,
  resumeText,
  routineProject,
  routineState,
  rowDay,
  scheduleWords,
  sinceTime,
  type RoutinePause,
} from './model'
import { RoutineMenuItems } from './routine-menu'
import { RunAnnouncements } from './run-history'

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

  const on = useMemo(() => onRoutines(routines), [routines])
  const off = useMemo(() => offRoutines(routines), [routines])
  const all = useMemo(() => [...on, ...off], [on, off])
  const pauses = useMemo(() => agentPauses(routines), [routines])
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

  const notices: ReactNode[] = pauses.map((pause) => (
    <PauseNotice key={pause.agentId} pause={pause} />
  ))
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
    body = <LoadingGroup />
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
      <div className="flex flex-col gap-9" onKeyDown={moveRowFocus}>
        {on.length > 0 && (
          <RoutineGroup
            label={t('page.on')}
            routines={on}
            tabStop={tabStop}
            onFocus={setActive}
            onRunNow={runNow}
            onDelete={setDeleting}
            onError={setError}
          />
        )}
        {off.length > 0 && (
          <RoutineGroup
            label={t('page.off')}
            routines={off}
            tabStop={tabStop}
            onFocus={setActive}
            onRunNow={runNow}
            onDelete={setDeleting}
            onError={setError}
          />
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <TopBar className="shadow-none">{null}</TopBar>
      <div className="min-h-0 flex-1 scroll-fade-y overflow-y-auto [scrollbar-gutter:stable]">
        {/* Block flow, so a notice's margin and the foot's meet as one gap. */}
        <div className="mx-auto w-full max-w-210 px-10 pb-20">
          <RunAnnouncements />
          <header className="mb-7 flex items-start gap-4">
            <div className="min-w-0 flex-1">
              <h1 className="font-heading text-title font-semibold">{t('page.title')}</h1>
              <p className="mt-1 max-w-100 text-small text-tertiary">{t('page.description')}</p>
            </div>
            {!empty && (
              <Button size="sm" className="mt-0.5" onClick={() => openRoutine(null)}>
                <PlusIcon data-icon="inline-start" />
                {t('page.new')}
              </Button>
            )}
          </header>
          {notices.length > 0 && <div className="mb-5.5 flex flex-col gap-2">{notices}</div>}
          {body}
          {loaded && !openAtLogin && (
            <div className="mt-7 flex items-center gap-2 rounded-code bg-subtle px-3.5 py-3 text-small text-secondary">
              <PowerIcon aria-hidden className="size-3.5 shrink-0 text-icon" />
              <p className="min-w-0 flex-1">{t('page.openAtLogin')}</p>
              <Button variant="quiet" size="sm" onClick={enableOpenAtLogin}>
                {t('page.openAtLoginAction')}
              </Button>
            </div>
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

/** An agent's routines paused at a plan limit: the window, its use and when they resume. */
function PauseNotice({ pause }: { pause: RoutinePause }) {
  const { t } = useTranslation('routines')
  const now = useNow()
  return (
    <Alert variant="info">
      <ChartNoAxesColumnIcon />
      <AlertTitle>{t('pause.title', { agent: agentName(pause.agentId) })}</AlertTitle>
      <AlertDescription>{pauseNotice(pause, now)}</AlertDescription>
    </Alert>
  )
}

/** A row: its fill reaches 8 px past the column on each side, as a hovered row's does. */
const ROW = 'relative -mx-2 flex min-h-16 items-center gap-3.5 rounded-lg px-2 py-2.5'

function RoutineGroup({
  label,
  routines,
  tabStop,
  onFocus,
  onRunNow,
  onDelete,
  onError,
}: {
  label: string
  routines: RoutineView[]
  tabStop: string | undefined
  onFocus: (id: string) => void
  onRunNow: (routine: RoutineView) => void
  onDelete: (routineId: string) => void
  onError: (message: string) => void
}) {
  return (
    <section aria-label={label} className="flex flex-col">
      <div className={HEADING}>
        <h2 className="font-heading text-heading font-semibold">{label}</h2>
        <span className="text-xs text-tertiary tabular">{routines.length}</span>
      </div>
      <ul className="flex flex-col">
        {routines.map((routine) => (
          <RoutineRow
            key={routine.id}
            routine={routine}
            tabbable={routine.id === tabStop}
            onFocus={() => onFocus(routine.id)}
            onRunNow={() => onRunNow(routine)}
            onDelete={() => onDelete(routine.id)}
            onError={onError}
          />
        ))}
      </ul>
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
  const now = useNow()
  const id = useId()
  const [moreOpen, setMoreOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const project = routineProject(routine, projects)
  const failed = failedRun(routine.lastRun)
  const off = !routine.enabled
  const waiting = routine.activeRun?.status === 'waiting' && !!routine.activeRun.sessionId
  const name = routine.name

  const toggle = (enabled: boolean) => {
    useRoutinesStore
      .getState()
      .update(routine.id, { enabled })
      .catch((error: unknown) => onError(errorMessage(error)))
  }

  const openRun = () => {
    openActiveRun(routine).catch((error: unknown) => onError(errorMessage(error)))
  }

  return (
    <li className={ROW_SLOT}>
      <ContextMenu onOpenChange={setContextOpen}>
        <div className={ROW}>
          <ContextMenuTrigger
            render={
              <button
                type="button"
                data-routine-row=""
                data-held={moreOpen || contextOpen || undefined}
                tabIndex={tabbable ? 0 : -1}
                aria-label={t('page.open', { name })}
                aria-describedby={`${id}-when ${id}-line`}
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
          <RowWhen id={`${id}-when`} routine={routine} now={now} />
          <span
            aria-hidden
            className="pointer-events-none relative grid size-7.5 shrink-0 place-items-center rounded-lg bg-tile"
          >
            <AgentMark agent={routine.agentId} size={15} className={cn(off && 'opacity-60')} />
          </span>
          <span className="pointer-events-none relative flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  'truncate text-ui font-medium',
                  off ? 'text-secondary' : 'text-primary',
                )}
              >
                {name}
              </span>
              {failed && <FailedMark />}
            </span>
            <span id={`${id}-line`} className="mt-px truncate text-xs text-secondary">
              {scheduleWords(routine.trigger.schedule)} ·{' '}
              {project?.name ??
                (routine.projectPath === null
                  ? t('routine.noProject')
                  : basename(routine.projectPath))}
            </span>
          </span>
          {waiting && (
            <Button
              variant="outline"
              size="xs"
              tabIndex={tabbable ? 0 : -1}
              onClick={openRun}
              className="relative"
            >
              {t('routine.openRun')}
            </Button>
          )}
          <Switch
            checked={routine.enabled}
            onCheckedChange={toggle}
            tabIndex={tabbable ? 0 : -1}
            aria-label={t(routine.enabled ? 'page.switchOff' : 'page.switchOn', { name })}
            className="relative"
          />
          <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  tabIndex={-1}
                  aria-hidden
                  className="absolute right-2 bottom-2 size-0"
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
    </li>
  )
}

/** The error mark after a routine's name, named by its tooltip. */
function FailedMark() {
  const { t } = useTranslation('routines')
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={t('page.lastFailed')}
            className="pointer-events-auto inline-flex shrink-0 text-danger"
          />
        }
      >
        <CircleAlertIcon className="size-3" />
      </TooltipTrigger>
      <TooltipContent>{t('page.lastFailed')}</TooltipContent>
    </Tooltip>
  )
}

/** What leads a row: its next run's time and day, or its state when that matters more. */
function RowWhen({ id, routine, now }: { id: string; routine: RoutineView; now: number }) {
  const { t } = useTranslation('routines')
  const state = routineState(routine)
  let first: ReactNode
  let second: string | null = null
  switch (state.kind) {
    case 'waiting':
      first = (
        <span className="flex items-center gap-1.5 text-ui leading-5.5 font-medium text-attention">
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-full bg-attention-dot ring-3 ring-attention-dot/16"
          />
          {t('row.waiting')}
        </span>
      )
      if (state.since !== null) second = t('row.since', { time: sinceTime(state.since, now) })
      break
    case 'running':
      first = (
        <span
          className={cn(
            'flex items-center gap-1.5 text-ui leading-5.5 font-medium',
            // Starting is the app's own wait, so it keeps a neutral spinner.
            state.status === 'running' ? 'text-info' : 'text-secondary',
          )}
        >
          <Spinner aria-hidden className="size-3" />
          {t(state.status === 'starting' ? 'state.starting' : 'state.running')}
        </span>
      )
      if (state.since !== null) second = t('row.since', { time: sinceTime(state.since, now) })
      break
    case 'next':
      first = (
        <span className="font-heading text-subheading font-medium tracking-normal lining-nums tabular-nums">
          {clockTime(state.at)}
        </span>
      )
      second = rowDay(state.at, now)
      break
    default:
      first = <span className="text-ui leading-5.5 text-tertiary">{t(`state.${state.kind}`)}</span>
      if (state.kind === 'paused') second = resumeText(state.pause, now)
  }
  return (
    <span id={id} className="pointer-events-none relative flex w-28 shrink-0 flex-col">
      {first}
      {second && <span className="truncate text-xs text-tertiary">{second}</span>}
    </span>
  )
}

/** Skeleton rows at the rows' sizes, under a heading's. */
function LoadingGroup() {
  return (
    <div aria-hidden className="flex flex-col">
      <div className={cn(HEADING, 'items-start pt-1.5')}>
        <Skeleton className="h-3.5 w-7" />
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className={ROW_SLOT}>
          <div className={ROW}>
            <span className="flex w-28 shrink-0 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-16" />
              <Skeleton className="h-2.5 w-11" />
            </span>
            <Skeleton className="size-7.5 shrink-0 rounded-lg" />
            <span className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Skeleton className="h-3 w-2/5" />
              <Skeleton className="h-2.5 w-1/4" />
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

/** The list is one Tab stop; the arrow keys move between its rows. */
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
