// The Routines page: every routine, on and off, with the state of its runs.

import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { CalendarClockIcon, CircleAlertIcon, PlusIcon } from 'lucide-react'
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
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@renderer/components/ui/empty'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Switch } from '@renderer/components/ui/switch'
import { TopBar } from '@renderer/features/shell/top-bar'
import { errorMessage } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import { useProjectsStore } from '@renderer/stores/projects'
import { useRoutinesStore } from '@renderer/stores/routines'
import { useSettingsStore } from '@renderer/stores/settings'
import { openRoutine } from '@renderer/stores/view'
import { DeleteRoutineDialog } from './delete-routine-dialog'
import {
  failedRun,
  offRoutines,
  onRoutines,
  routineProject,
  routineState,
  scheduleWords,
  stateText,
} from './model'
import { RoutineMenuItems } from './routine-menu'
import { RunningDot } from './run-mark'
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
  const tabStop = active && all.some((routine) => routine.id === active) ? active : all[0]?.id

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

  let body
  if (!loaded) {
    body = (
      <div className="flex flex-col gap-1" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-12 w-full rounded-lg" />
        ))}
      </div>
    )
  } else if (all.length === 0) {
    body = (
      <Empty className="py-20">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CalendarClockIcon />
          </EmptyMedia>
          <EmptyTitle>{t('page.emptyTitle')}</EmptyTitle>
          <EmptyDescription>{t('page.emptyDescription')}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={() => openRoutine(null)}>
            <PlusIcon />
            {t('page.new')}
          </Button>
        </EmptyContent>
      </Empty>
    )
  } else {
    body = (
      <div className="flex flex-col gap-5" onKeyDown={moveRowFocus}>
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
      <TopBar>
        <span className="flex-1" />
      </TopBar>
      <div className="min-h-0 flex-1 overflow-y-auto px-7 pt-2 pb-9 [scrollbar-gutter:stable]">
        <div className="mx-auto flex w-full max-w-thread flex-col gap-6">
          <RunAnnouncements />
          <div className="flex items-start gap-4">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <h1 className="text-title font-semibold">{t('page.title')}</h1>
              <p className="text-small leading-normal text-secondary">{t('page.description')}</p>
            </div>
            <Button onClick={() => openRoutine(null)}>
              <PlusIcon />
              {t('page.new')}
            </Button>
          </div>
          {problem && (
            <Alert variant="error">
              <CircleAlertIcon />
              <AlertTitle>{t('page.unreadableTitle')}</AlertTitle>
              <AlertDescription>
                {problem.backup
                  ? t('page.unreadable', { backup: problem.backup })
                  : t('page.unreadableGone')}
              </AlertDescription>
            </Alert>
          )}
          {loadError && (
            <Alert variant="error">
              <CircleAlertIcon />
              <AlertTitle>{t('page.loadFailed')}</AlertTitle>
              <AlertDescription>{loadError}</AlertDescription>
              <AlertAction>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => void useRoutinesStore.getState().load()}
                >
                  {t('page.retry')}
                </Button>
              </AlertAction>
            </Alert>
          )}
          {error && (
            <Alert variant="error">
              <CircleAlertIcon />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {body}
          {!openAtLogin && (
            <div className="flex items-center justify-between gap-4 border-t border-subtle pt-4">
              <p className="text-small text-secondary">{t('page.openAtLogin')}</p>
              <Button variant="outline" size="sm" onClick={enableOpenAtLogin}>
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
    <section className="flex flex-col">
      <div className="flex h-7.5 items-center gap-1.5 px-1 text-xs font-medium text-tertiary">
        <h2>{label}</h2>
        <span className="font-normal tabular">{routines.length}</span>
      </div>
      <ul className="flex flex-col gap-px">
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
  const [moreOpen, setMoreOpen] = useState(false)
  const project = routineProject(routine, projects)
  const failed = failedRun(routine.lastRun)
  const name = routine.name

  const toggle = (enabled: boolean) => {
    useRoutinesStore
      .getState()
      .update(routine.id, { enabled })
      .catch((error: unknown) => onError(errorMessage(error)))
  }

  return (
    <li>
      <ContextMenu>
        <div className="group/routine relative flex min-h-12 items-center gap-2.5 rounded-lg pr-2 transition-colors duration-(--duration-fast) hover:bg-accent">
          <ContextMenuTrigger
            render={
              <button
                type="button"
                data-routine-row=""
                tabIndex={tabbable ? 0 : -1}
                aria-label={t('page.open', { name })}
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
                className="absolute inset-0 rounded-lg outline-none focus-ring"
              />
            }
          />
          <AgentMark
            agent={routine.agentId}
            size={14}
            className="pointer-events-none relative ml-2"
          />
          <span className="pointer-events-none relative flex min-w-0 flex-1 flex-col py-1.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-ui font-medium">{name}</span>
              {failed && (
                <CircleAlertIcon
                  role="img"
                  aria-label={t('page.lastFailed')}
                  className="size-3 shrink-0 text-danger"
                />
              )}
            </span>
            <span className="truncate text-xs text-tertiary">
              {scheduleWords(routine.trigger.schedule)} ·{' '}
              {project?.name ??
                (routine.projectPath === null ? t('routine.noProject') : routine.projectPath)}
            </span>
          </span>
          <span className="pointer-events-none relative shrink-0">
            <RowState routine={routine} now={now} />
          </span>
          <Switch
            checked={routine.enabled}
            onCheckedChange={toggle}
            tabIndex={tabbable ? 0 : -1}
            aria-label={t(routine.enabled ? 'page.switchOff' : 'page.switchOn', { name })}
            className="relative z-10 ml-1"
          />
          <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  tabIndex={-1}
                  aria-hidden
                  className="absolute top-0 right-0 size-0"
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

/** What the routine is doing at the row's end, by a session row's priorities. */
function RowState({ routine, now }: { routine: RoutineView; now: number }) {
  const { t } = useTranslation('routines')
  const state = routineState(routine)
  if (state.kind === 'waiting') {
    return <Badge variant="warning">{t('state.waiting')}</Badge>
  }
  if (state.kind === 'running') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-secondary">
        <RunningDot />
        {t(state.status === 'starting' ? 'state.starting' : 'state.running')}
      </span>
    )
  }
  return <span className="text-xs text-tertiary">{stateText(routine, now)}</span>
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
