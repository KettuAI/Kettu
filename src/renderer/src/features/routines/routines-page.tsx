// The Routines page: the routines that are on and those that are off, each group a card of rows
// with their schedule, agent and status; with none yet, examples to start from.

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import {
  Alert02Icon,
  ArrowRight01Icon,
  Calendar03Icon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  MoreHorizontalIcon,
  PlusSignIcon,
} from '@hugeicons/core-free-icons'
import { Trans, useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { RoutineView } from '@shared/routines'
import { Dropdown, Icon, SectionHead } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import { RingSpinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { TurnDots } from '@renderer/features/session/turn-dots'
import { basename, longAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import { agentName } from '@renderer/stores/agents'
import { useProjectsStore } from '@renderer/stores/projects'
import { useRoutinesStore } from '@renderer/stores/routines'
import { openRoutine } from '@renderer/stores/view'
import { openActiveRun } from './actions'
import { DeleteRoutineDialog } from './delete-routine-dialog'
import { ROUTINE_EXAMPLES, routineExample, type RoutineExampleId } from './examples'
import { Notice, SettingsStyles, Toggle } from './kit'
import {
  lastRunCell,
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
  untilTime,
} from './model'
import { routineMenu } from './menu-items'
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
      <Notice
        key="problem"
        tone="red"
        mark={<Icon icon={Alert02Icon} size={16} />}
        title={t('page.unreadableTitle')}
      >
        {problem.backup
          ? t('page.unreadable', { backup: basename(problem.backup) })
          : t('page.unreadableGone')}
      </Notice>,
    )
  }
  if (loadError) {
    notices.push(
      <Notice
        key="load"
        tone="red"
        mark={<Icon icon={Alert02Icon} size={16} />}
        title={t('page.loadFailed')}
        action={
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void useRoutinesStore.getState().load()}
          >
            {t('page.retry')}
          </Button>
        }
      >
        {loadError}
      </Notice>,
    )
  }
  if (error) {
    notices.push(
      <Notice key="error" tone="red" mark={<Icon icon={Alert02Icon} size={16} />}>
        {error}
      </Notice>,
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
      <div onKeyDown={moveRowFocus}>
        {on.length > 0 && group(t('state.on'), on, true)}
        {off.length > 0 && group(t('state.off'), off, on.length === 0)}
      </div>
    )
  }

  return (
    <div className="k-scroll">
      <SettingsStyles />
      <div aria-hidden className="k-drag app-region-drag" />
      <div className="ui-as-page k-rpage">
        <RunAnnouncements />
        <header className="k-rpage__head">
          <span>
            <h1 className="ui-as-page-title">{t('page.title')}</h1>
            <p className="ui-as-page-sub">{t('page.description')}</p>
          </span>
          {!empty && (
            <Button
              size="sm"
              icon={<Icon icon={PlusSignIcon} size={15} />}
              onClick={() => openRoutine(null)}
            >
              {t('page.new')}
            </Button>
          )}
        </header>
        {notices.length > 0 && <div className="k-rpage__notices">{notices}</div>}
        {body}
        {loaded && all.length > 0 && (
          <p className="ui-sg-hint k-rpage__foot">{t('page.footnote')}</p>
        )}
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

/** A group's head with its count, then its card, the columns' names over the first group. */
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
      <SectionHead title={label} count={count} />
      <div role="list" aria-label={label} className="ui-sg-card k-rcard">
        {/* Each row's button names and describes the routine, so the heads are for the eye only. */}
        {heads && (
          <div aria-hidden className="k-rrow k-rrow--head">
            <span>{t('page.columns.name')}</span>
            <span className="k-rrow__schedule">{t('page.columns.schedule')}</span>
            <span className="k-rrow__agent">{t('page.columns.agent')}</span>
            <span>{t('page.columns.status')}</span>
            <span />
            <span />
          </div>
        )}
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
  const more = useRef<HTMLSpanElement>(null)
  const [contextOpen, setContextOpen] = useState(false)
  const project = routineProject(routine, projects)
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
  const open = () => openRoutine(routine.id)

  return (
    <ContextMenu onOpenChange={setContextOpen}>
      <div role="listitem" className="k-rrow" data-off={!routine.enabled || undefined}>
        <ContextMenuTrigger
          render={
            <button
              type="button"
              className="k-rrow__open"
              data-routine-row=""
              data-held={contextOpen || undefined}
              tabIndex={tabbable ? 0 : -1}
              aria-label={t('page.open', { name })}
              aria-describedby={`${id}-line ${id}-schedule ${id}-agent ${id}-status`}
              onClick={open}
              onFocus={onFocus}
              onKeyDown={(event) => {
                // The context menu key opens the row's More menu, for the keyboard.
                if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                  event.preventDefault()
                  more.current?.querySelector('button')?.click()
                } else if (event.key === 'Enter' || event.key === ' ') {
                  // The trigger takes the key before the button activates itself.
                  event.preventDefault()
                  open()
                }
              }}
            />
          }
        />
        <span className="k-rrow__name">
          <b>{name}</b>
          <small id={`${id}-line`}>
            <span className="k-rrow__wide">{rowDescription(routine, projectName)}</span>
            <span aria-hidden className="k-rrow__narrow">
              {schedule} · {agent}
            </span>
          </small>
        </span>
        <span id={`${id}-schedule`} className="k-rrow__cell k-rrow__schedule">
          {schedule}
        </span>
        <span className="k-rrow__cell k-rrow__agent">
          <AgentMark agent={routine.agentId} size={14} />
          <span id={`${id}-agent`}>{agent}</span>
        </span>
        <span id={`${id}-status`} className="k-rrow__cell">
          <StatusCell routine={routine} tabbable={tabbable} onError={onError} />
        </span>
        <span ref={more} className="k-rrow__more">
          <Dropdown
            align="end"
            items={routineMenu(routine, t, {
              onOpen: open,
              onRunNow,
              onToggle: toggle,
              onDelete,
            })}
            trigger={({ open: shown, toggle: flip }) => (
              <button
                type="button"
                className="ui-as-icon-btn"
                tabIndex={-1}
                aria-label={t('routine.more')}
                aria-haspopup="menu"
                aria-expanded={shown}
                onClick={flip}
              >
                <Icon icon={MoreHorizontalIcon} size={16} />
              </button>
            )}
          />
        </span>
        <span className="k-rrow__switch">
          <Toggle
            on={routine.enabled}
            tabIndex={tabbable ? 0 : -1}
            label={t(routine.enabled ? 'page.switchOff' : 'page.switchOn', { name })}
            onChange={toggle}
          />
        </span>
      </div>
      <ContextMenuContent side="bottom" align="start">
        <RoutineMenuItems
          routine={routine}
          onOpen={open}
          onRunNow={onRunNow}
          onToggle={toggle}
          onDelete={onDelete}
        />
      </ContextMenuContent>
    </ContextMenu>
  )
}

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
  switch (cell.kind) {
    case 'waiting': {
      const openRun = () => {
        openActiveRun(routine).catch((error: unknown) => onError(errorMessage(error)))
      }
      return (
        <span className="k-rs" data-tone="amber">
          <span className="k-rs__dot" />
          <span className="k-rs__text">
            {cell.since === null
              ? t('state.waiting')
              : t('row.waitingSince', { time: sinceTime(cell.since, now) })}
          </span>
          {routine.activeRun?.sessionId && (
            <button
              type="button"
              className="k-rs__link"
              tabIndex={tabbable ? 0 : -1}
              onClick={openRun}
            >
              {t('routine.openRun')}
            </button>
          )}
        </span>
      )
    }
    case 'running':
      return (
        <span className="k-rs">
          {cell.status === 'starting' ? <RingSpinner aria-hidden /> : <TurnDots phase="working" />}
          <span className="k-rs__text">
            {cell.status === 'starting'
              ? t('state.starting')
              : cell.since === null
                ? t('state.running')
                : t('row.running', { duration: runningFor(cell.since, now) })}
          </span>
        </span>
      )
    case 'queued':
      return (
        <span className="k-rs" data-tone="faint">
          <span className="k-rs__text">{t('state.queued')}</span>
        </span>
      )
    case 'paused': {
      const text = t(cell.pause?.usedPercent === null ? 'row.pausedReached' : 'row.pausedNear')
      return (
        <Tooltip>
          <TooltipTrigger render={<span className="k-rs" data-tone="muted" data-tip="" />}>
            <Icon icon={Clock01Icon} size={13} />
            <span className="k-rs__text">{text}</span>
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
          <TooltipTrigger render={<span className="k-rs" data-tone="red" data-tip="" />}>
            <Icon icon={Alert02Icon} size={13} />
            <span className="k-rs__text">
              {cell.at === null ? t('run.failed') : t('row.failed', { ago: longAgo(cell.at, now) })}
            </span>
            <span className="sr-only">{runStatus(cell.run)}</span>
          </TooltipTrigger>
          <TooltipContent className="max-w-80">{runStatus(cell.run)}</TooltipContent>
        </Tooltip>
      )
    case 'next':
      return (
        <span className="k-rs" data-tone="muted">
          <span className="k-rs__text">
            <Trans
              t={t}
              i18nKey="row.nextAtRich"
              values={{ when: runDay(cell.at, now), away: untilTime(cell.at, now) }}
              components={{ away: <span className="k-rs__away" /> }}
            />
          </span>
        </span>
      )
    case 'succeeded':
      return (
        <span className="k-rs" data-tone="muted">
          <Icon icon={CheckmarkCircle02Icon} size={13} />
          <span className="k-rs__text">
            {cell.at === null ? t('run.succeeded') : runDay(cell.at, now)}
          </span>
        </span>
      )
    case 'ended':
      return (
        <span className="k-rs" data-tone="faint">
          <span className="k-rs__text">
            {cell.at === null
              ? t(`row.${cell.status}`)
              : t(`row.${cell.status}At`, { when: runDay(cell.at, now) })}
          </span>
        </span>
      )
    case 'done':
      return (
        <span className="k-rs" data-tone="muted">
          <Icon icon={CheckmarkCircle02Icon} size={13} />
          <span className="k-rs__text">{t('state.done')}</span>
        </span>
      )
    case 'never':
      return (
        <span className="k-rs" data-tone="faint">
          <span className="k-rs__text">{t('row.never')}</span>
        </span>
      )
  }
}

/** Rows at the rows' sizes, in a group's card, while the routines load. */
function LoadingGroup() {
  return (
    <div aria-hidden>
      <SectionHead title=" " />
      <div className="ui-sg-card k-rcard">
        {[0, 1, 2].map((i) => (
          <div key={i} className="k-rrow">
            <span className="k-rrow__name" style={{ gap: 8 }}>
              <span className="k-bone" style={{ width: '40%' }} />
              <span className="k-bone" style={{ width: '60%', height: 8 }} />
            </span>
            <span className="k-bone k-rrow__schedule" style={{ width: '70%' }} />
            <span className="k-bone k-rrow__agent" style={{ width: '60%' }} />
            <span className="k-bone" style={{ width: '50%' }} />
          </div>
        ))}
      </div>
    </div>
  )
}

/** A week of small dots, a few of them lit: the empty state's sketch of a schedule. */
function WeekDots() {
  return (
    <svg className="k-weekdots" viewBox="0 0 106 46" width="106" height="46" aria-hidden="true">
      {Array.from({ length: 7 }).flatMap((_, day) =>
        Array.from({ length: 3 }).map((__, hour) => {
          const lit = (hour === 0 && day < 5) || (hour === 2 && day === 4)
          return (
            <circle
              key={`${day}${hour}`}
              cx={8 + day * 15}
              cy={8 + hour * 15}
              r={lit ? 3.4 : 2.4}
              data-lit={lit || undefined}
            />
          )
        }),
      )}
    </svg>
  )
}

/** With no routines: what a routine is and New routine, then examples to start from. */
function Examples() {
  const { t } = useTranslation('routines')
  return (
    <>
      <div className="ui-sg-card k-rempty">
        <WeekDots />
        <b>{t('page.emptyTitle')}</b>
        <p>{t('page.emptyDescription')}</p>
        <Button
          size="sm"
          icon={<Icon icon={PlusSignIcon} size={15} />}
          onClick={() => openRoutine(null)}
        >
          {t('page.new')}
        </Button>
      </div>
      <SectionHead title={t('examples.heading')} />
      <p className="ui-sg-hint k-rex__hint">{t('examples.hint')}</p>
      <div className="k-rex">
        {ROUTINE_EXAMPLES.map((id, i) => (
          <ExampleCard key={id} id={id} index={i} />
        ))}
      </div>
    </>
  )
}

function ExampleCard({ id, index }: { id: RoutineExampleId; index: number }) {
  const { t } = useTranslation('routines')
  const example = routineExample(id)
  const level = t(`permission.level.${example.scope.level}.name`)
  return (
    <button
      type="button"
      aria-label={t('examples.open', { name: example.name })}
      onClick={() => openRoutine(null, { example: id })}
      className="ui-sg-card k-rex__card ui-as-rise"
      style={{ '--i': index } as CSSProperties}
    >
      <b>{example.name}</b>
      <p>{example.prompt}</p>
      <span className="k-rex__badges">
        <span className="ui-ss-badge">
          <Icon icon={Calendar03Icon} size={12} />
          {scheduleWords(example.schedule)}
        </span>
        <span className="ui-ss-badge">
          {example.scope.web ? t('examples.web', { level }) : level}
        </span>
      </span>
      <span aria-hidden className="k-rex__use">
        {t('examples.use')} <Icon icon={ArrowRight01Icon} size={13} />
      </span>
    </button>
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
