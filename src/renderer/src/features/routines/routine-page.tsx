// A routine's page, and New routine, which uses the same fields before the routine exists: a bar
// like the screens' heads, the settings cards on the left and its runs on the right.

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import {
  Alert02Icon,
  ArrowLeft01Icon,
  Calendar03Icon,
  MoreHorizontalIcon,
  PauseIcon,
  PlayIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { Project } from '@shared/agent-host'
import {
  DEFAULT_KEPT_RUN_SESSIONS,
  DEFAULT_SCHEDULE,
  DEFAULT_SCOPE,
  DEFAULT_TIME_LIMIT,
  KEPT_RUN_SESSIONS,
  ROUTINE_NAME_CHARS,
  TIME_LIMITS,
  type KeptRunSessions,
  type PermissionScope,
  type RoutineChanges,
  type RoutineOption,
  type RoutineView,
  type Schedule,
  type TimeLimitMinutes,
} from '@shared/routines'
import type { ScheduleProblem } from '@shared/schedule'
import type { AgentId } from '@shared/thread'
import { backTo } from '@renderer/app/history'
import { Dropdown, Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { isEditable } from '@renderer/features/artifacts/keys'
import { AgentMenu } from '@renderer/features/session/new-session/agent-menu'
import { ProjectMenu } from '@renderer/features/session/new-session/project-menu'
import { useCornered } from '@renderer/features/shell/corner'
import { CornerControlsSpace } from '@renderer/features/shell/top-bar'
import { canStart, startValues } from '@renderer/features/session/new-session/start-options'
import { TurnDots } from '@renderer/features/session/turn-dots'
import { basename } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import { picksOf, useAgentOptionsStore, type OptionValues } from '@renderer/stores/agent-options'
import { useAgentsStore, agentName } from '@renderer/stores/agents'
import { useProjectsStore } from '@renderer/stores/projects'
import { loadRoutinePage, useRoutinesStore } from '@renderer/stores/routines'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import { openRoutine, openRoutines, useViewStore } from '@renderer/stores/view'
import { openActiveRun } from './actions'
import { DeleteRoutineDialog } from './delete-routine-dialog'
import { routineExample, type RoutineExampleId } from './examples'
import { Head, Notice, Row, Select, SettingsStyles, Toggle } from './kit'
import {
  firstRunHint,
  minutesLabel,
  optionValues,
  pauseNotice,
  routineOptions,
  routineState,
  stateText,
} from './model'
import { PermissionField } from './permission-field'
import { routineMenu } from './menu-items'
import { RunAnnouncements, RunHistory, RunsCard, RunsEmpty } from './run-history'
import { ScheduleField } from './schedule-field'

export default function RoutinePage({
  routineId,
  example,
}: {
  routineId: string | null
  /** New routine's example to start from, when it opened from one. */
  example: RoutineExampleId | null
}) {
  return routineId === null ? (
    <NewRoutine example={example} />
  ) : (
    <ExistingRoutine routineId={routineId} />
  )
}

function ExistingRoutine({ routineId }: { routineId: string }) {
  const { t } = useTranslation('routines')
  const routine = useRoutinesStore((s) => s.byId[routineId])
  const loaded = useRoutinesStore((s) => s.loaded)
  const loadError = useRoutinesStore((s) => s.error)
  const unseen = routine?.unseen.ended ?? 0

  useBackOnEscape()
  useEffect(() => {
    loadRoutinePage(routineId)
  }, [routineId])
  // Showing the page counts its ended runs as seen, as new ones end while it shows.
  useEffect(() => {
    if (unseen === 0) return
    useRoutinesStore
      .getState()
      .markSeen(routineId)
      .catch((failure: unknown) => {
        console.warn(`Could not mark the routine's runs seen: ${errorMessage(failure)}`)
      })
  }, [routineId, unseen])

  if (!routine) {
    return (
      <RoutineShell bar={null}>
        {loaded ? (
          <div className="k-routine__missing">
            <span>{loadError ? t('page.loadFailed') : t('routine.deleted')}</span>
            <Button size="sm" variant="secondary" onClick={leaveRoutine}>
              {t('routine.backToRoutines')}
            </Button>
          </div>
        ) : (
          <div aria-hidden className="k-routine__grid">
            <div className="k-routine__form">
              <Head title=" " />
              <div className="ui-sg-card" style={{ height: 240 }} />
            </div>
            <div className="ui-sg-card k-runs" style={{ height: 160 }} />
          </div>
        )}
      </RoutineShell>
    )
  }

  return <RoutineBody key={routine.id} routine={routine} />
}

function RoutineBody({ routine }: { routine: RoutineView }) {
  const { t } = useTranslation('routines')
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [name, setName] = useState(routine.name)
  const [prompt, setPrompt] = useState(routine.prompt)
  // A lower number of kept run sessions that would remove some, until it is confirmed.
  const [trimming, setTrimming] = useState<KeptRunSessions | null>(null)
  const nameCancelled = useRef(false)

  const save = (changes: RoutineChanges) => {
    setError(null)
    useRoutinesStore
      .getState()
      .update(routine.id, changes)
      .catch((failure: unknown) => setError(errorMessage(failure)))
  }

  const saveName = () => {
    if (nameCancelled.current) {
      nameCancelled.current = false
      setName(routine.name)
      return
    }
    const next = name.trim()
    if (!next || next === routine.name) {
      setName(routine.name)
      return
    }
    setError(null)
    useRoutinesStore
      .getState()
      .update(routine.id, { name: next })
      .then((view) => setName(view.name))
      .catch((failure: unknown) => {
        setName(routine.name)
        setError(errorMessage(failure))
      })
  }

  const savePrompt = () => {
    if (!prompt.trim()) {
      setPrompt(routine.prompt)
      return
    }
    if (prompt === routine.prompt) return
    setError(null)
    useRoutinesStore
      .getState()
      .update(routine.id, { prompt })
      .catch((failure: unknown) => {
        setPrompt(routine.prompt)
        setError(errorMessage(failure))
      })
  }

  const saveKept = (keptRunSessions: KeptRunSessions) => {
    if (keptRunSessions < routine.sessions) setTrimming(keptRunSessions)
    else save({ keptRunSessions })
  }

  const runNow = () => {
    setError(null)
    useRoutinesStore
      .getState()
      .runNow(routine.id)
      .catch((failure: unknown) => setError(errorMessage(failure)))
  }

  const openRun = () => {
    setError(null)
    openActiveRun(routine).catch((failure: unknown) => setError(errorMessage(failure)))
  }

  const state = routineState(routine)
  const now = useNow()

  const notices: ReactNode[] = []
  if (state.kind === 'waiting') {
    notices.push(
      <Notice
        key="waiting"
        tone="amber"
        mark={<span className="k-rs__dot" />}
        title={t('routine.waitingTitle')}
        action={
          routine.activeRun?.sessionId && (
            <Button size="sm" variant="secondary" onClick={openRun}>
              {t('routine.openRun')}
            </Button>
          )
        }
      >
        {t('routine.waitingDescription')}
      </Notice>,
    )
  }
  if (state.kind === 'paused' && state.pause) {
    notices.push(
      <Notice
        key="paused"
        tone="amber"
        mark={<Icon icon={PauseIcon} size={16} />}
        title={t('pause.title', { agent: agentName(state.pause.agentId) })}
      >
        {pauseNotice(state.pause, now)}
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

  return (
    <RoutineShell
      bar={
        <>
          <span className="k-routine__title">
            <RoutineMark agent={routine.agentId} />
            <input
              className="k-routine__name"
              value={name}
              maxLength={ROUTINE_NAME_CHARS}
              aria-label={t('routine.name')}
              title={t('routine.rename')}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setName(event.target.value)}
              onBlur={saveName}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  event.currentTarget.blur()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  nameCancelled.current = true
                  event.currentTarget.blur()
                }
              }}
            />
          </span>
          <span
            className="k-routine__state"
            data-tone={state.kind === 'waiting' ? 'amber' : undefined}
          >
            {state.kind === 'waiting' && <span aria-hidden className="k-rs__dot" />}
            {state.kind === 'running' && state.status === 'running' && <TurnDots phase="working" />}
            <span>{stateText(routine, now)}</span>
          </span>
          <span className="k-routine__acts">
            <Button
              size="sm"
              variant="secondary"
              icon={<Icon icon={PlayIcon} size={14} />}
              disabled={!!routine.activeRun}
              onClick={runNow}
            >
              {t('routine.runNow')}
            </Button>
            <Toggle
              on={routine.enabled}
              label={t(routine.enabled ? 'page.switchOff' : 'page.switchOn', {
                name: routine.name,
              })}
              onChange={(enabled) => save({ enabled })}
            />
            <Dropdown
              align="end"
              items={routineMenu(routine, t, { onDelete: () => setDeleting(true) })}
              trigger={({ open, toggle }) => (
                <button
                  type="button"
                  className="ui-as-icon-btn"
                  aria-label={t('routine.more')}
                  title={t('routine.more')}
                  aria-haspopup="menu"
                  aria-expanded={open}
                  onClick={toggle}
                >
                  <Icon icon={MoreHorizontalIcon} size={16} />
                </button>
              )}
            />
          </span>
        </>
      }
    >
      <RunAnnouncements />
      {notices}
      <div className="k-routine__grid">
        <RoutineFields
          prompt={prompt}
          onPrompt={setPrompt}
          onPromptBlur={savePrompt}
          projectPath={routine.projectPath}
          noProject={routine.projectPath === null}
          onProject={(projectPath) => save({ projectPath })}
          onProjectError={setError}
          agentId={routine.agentId}
          values={optionValues(routine.options)}
          onChoose={(agentId, model) => {
            const entry = useAgentOptionsStore.getState().byId[agentId]
            const seed =
              agentId === routine.agentId
                ? optionValues(routine.options)
                : { ...(picksOf(useAgentOptionsStore.getState(), null, agentId) ?? {}) }
            const modelOption = entry?.config.find((option) => option.category === 'model')
            const next = { ...seed }
            if (modelOption) {
              if (model === null) delete next[modelOption.id]
              else next[modelOption.id] = model
            }
            save({
              agentId,
              options: entry ? routineOptions(entry, next) : optionsFrom(next),
            })
          }}
          onValues={(optionId, value) => {
            const entry = useAgentOptionsStore.getState().byId[routine.agentId]
            if (!entry) return
            save({
              options: routineOptions(entry, {
                ...optionValues(routine.options),
                [optionId]: value,
              }),
            })
          }}
          timeLimit={routine.timeLimitMinutes}
          onTimeLimit={(timeLimitMinutes) => save({ timeLimitMinutes })}
          kept={routine.keptRunSessions}
          onKept={saveKept}
          scope={routine.scope}
          onScope={(scope) => save({ scope })}
          schedule={routine.trigger.schedule}
          savedSchedule={routine.trigger.schedule}
          done={routine.state === 'done'}
          onSchedule={(schedule) => save({ trigger: { kind: 'schedule', schedule } })}
        />
        <RunHistory routine={routine} />
      </div>

      {deleting && (
        <DeleteRoutineDialog
          routine={routine}
          open
          onOpenChange={(open) => {
            if (!open) setDeleting(false)
          }}
          onDeleted={openRoutines}
        />
      )}
      <AlertDialog
        open={trimming !== null}
        onOpenChange={(open) => {
          if (!open) setTrimming(null)
        }}
      >
        {trimming !== null && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t('routine.keptConfirmTitle', { count: trimming })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t('routine.keptConfirm', { count: routine.sessions - trimming })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('routine.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  save({ keptRunSessions: trimming })
                  setTrimming(null)
                }}
              >
                {t('routine.keptConfirmAction')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </RoutineShell>
  )
}

function NewRoutine({ example }: { example: RoutineExampleId | null }) {
  const { t } = useTranslation('routines')
  const projects = useProjectsStore((s) => s.projects)
  const defaultAgent = useSettingsStore((s) => s.settings.general.defaultAgent)
  const [seed] = useState(() => (example ? routineExample(example) : null))
  const [name, setName] = useState(seed?.name ?? '')
  const [prompt, setPrompt] = useState(seed?.prompt ?? '')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const promptField = useRef<HTMLTextAreaElement>(null)
  const [projectPath, setProjectPath] = useState<string | null>(() => {
    const view = useViewStore.getState()
    const shown =
      view.main.kind === 'session'
        ? useSessionsStore.getState().byId[view.main.sessionId]
        : undefined
    const inProject = (path: string | null | undefined): path is string =>
      !!path && projects.some((project) => project.path === path)
    if (shown && !shown.scratch && inProject(shown.projectPath)) return shown.projectPath
    return inProject(view.projectPath) ? view.projectPath : null
  })
  const [projectChosen, setProjectChosen] = useState(projectPath !== null)
  const [agentId, setAgentId] = useState<AgentId | null>(() => {
    const status = defaultAgent ? useAgentsStore.getState().byId[defaultAgent] : undefined
    return defaultAgent && status && canStart(status) ? defaultAgent : null
  })
  const [values, setValues] = useState<OptionValues>(() => initialValues(agentId))
  const [timeLimit, setTimeLimit] = useState<TimeLimitMinutes>(DEFAULT_TIME_LIMIT)
  const [kept, setKept] = useState<KeptRunSessions>(DEFAULT_KEPT_RUN_SESSIONS)
  const [scope, setScope] = useState<PermissionScope>(seed?.scope ?? DEFAULT_SCOPE)
  const [schedule, setSchedule] = useState<Schedule>(seed?.schedule ?? DEFAULT_SCHEDULE)
  const [scheduleProblem, setScheduleProblem] = useState<ScheduleProblem | null>(null)
  const now = useNow()

  useBackOnEscape()
  useEffect(() => {
    const field = promptField.current
    if (!field) return
    field.focus()
    field.setSelectionRange(field.value.length, field.value.length)
  }, [])

  const missing = !prompt.trim()
    ? t('routine.createMissingPrompt')
    : !projectChosen
      ? t('routine.createMissingProject')
      : !agentId
        ? t('routine.createMissingAgent')
        : scheduleProblem
          ? t('routine.createMissingSchedule')
          : null

  const create = async () => {
    if (missing || !agentId || creating) return
    setCreating(true)
    setError(null)
    try {
      const entry = useAgentOptionsStore.getState().byId[agentId]
      const routine = await useRoutinesStore.getState().create({
        name: name.trim(),
        prompt,
        agentId,
        projectPath,
        options: entry ? routineOptions(entry, values) : optionsFrom(values),
        trigger: { kind: 'schedule', schedule },
        scope,
        timeLimitMinutes: timeLimit,
        keptRunSessions: kept,
      })
      openRoutine(routine.id, { replace: true })
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setCreating(false)
    }
  }

  return (
    <RoutineShell
      bar={
        <>
          <span className="k-routine__title">
            <RoutineMark agent={agentId} />
            <input
              className="k-routine__name"
              value={name}
              maxLength={ROUTINE_NAME_CHARS}
              placeholder={t('routine.untitled')}
              aria-label={t('routine.name')}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setName(event.target.value)}
            />
          </span>
          <span className="k-routine__state">
            <span>{t('routine.notSaved')}</span>
          </span>
          <span className="k-routine__acts">
            <Button size="sm" variant="secondary" onClick={openRoutines}>
              {t('routine.cancel')}
            </Button>
            {/* Says what is missing; once nothing is, the button needs no words of its own. */}
            <Tooltip disabled={!missing}>
              <TooltipTrigger render={<span className="inline-flex" />}>
                <Button
                  size="sm"
                  disabled={!!missing || creating}
                  loading={creating}
                  onClick={() => void create()}
                >
                  {t('routine.create')}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="end">
                {missing}
              </TooltipContent>
            </Tooltip>
          </span>
        </>
      }
    >
      {error && (
        <Notice tone="red" mark={<Icon icon={Alert02Icon} size={16} />}>
          {error}
        </Notice>
      )}
      <div className="k-routine__grid">
        <RoutineFields
          prompt={prompt}
          onPrompt={setPrompt}
          promptField={promptField}
          projectPath={projectPath}
          noProject={projectChosen && projectPath === null}
          onProject={(path) => {
            setProjectPath(path)
            setProjectChosen(true)
          }}
          onProjectError={setError}
          agentId={agentId}
          values={values}
          onChoose={(id, model) => {
            setAgentId(id)
            const entry = useAgentOptionsStore.getState().byId[id]
            const next = { ...(picksOf(useAgentOptionsStore.getState(), null, id) ?? {}) }
            const modelOption = entry?.config.find((option) => option.category === 'model')
            if (modelOption) {
              if (model === null) delete next[modelOption.id]
              else next[modelOption.id] = model
            }
            setValues(entry ? startValues(entry, next) : next)
          }}
          onValues={(optionId, value) =>
            setValues((current) => ({ ...current, [optionId]: value }))
          }
          timeLimit={timeLimit}
          onTimeLimit={setTimeLimit}
          kept={kept}
          onKept={setKept}
          scope={scope}
          onScope={setScope}
          schedule={schedule}
          savedSchedule={null}
          onSchedule={setSchedule}
          onScheduleProblem={setScheduleProblem}
        />
        <RunsCard>
          <RunsEmpty hint={firstRunHint(schedule, now)} />
        </RunsCard>
      </div>
    </RoutineShell>
  )
}

/** The page: its bar with Back, then the body under it. */
function RoutineShell({ bar, children }: { bar: ReactNode; children: ReactNode }) {
  const { t } = useTranslation('routines')
  // The corner's controls sit where Back would.
  const cornered = useCornered()
  return (
    <div className="k-scroll">
      <SettingsStyles />
      <div className="k-routine">
        <header className="k-routine__bar app-region-drag" data-cornered={cornered || undefined}>
          {cornered && <CornerControlsSpace />}
          <button type="button" className="k-back" onClick={leaveRoutine}>
            <Icon icon={ArrowLeft01Icon} size={15} />
            {t('routine.back')}
          </button>
          {bar}
        </header>
        <div className="k-routine__body">{children}</div>
      </div>
    </div>
  )
}

/** The routine's agent before its name, or a calendar before New routine has an agent. */
function RoutineMark({ agent }: { agent: AgentId | null }) {
  return agent ? <AgentMark agent={agent} size={18} /> : <Icon icon={Calendar03Icon} size={16} />
}

function RoutineFields({
  prompt,
  onPrompt,
  onPromptBlur,
  promptField,
  projectPath,
  noProject,
  onProject,
  onProjectError,
  agentId,
  values,
  onChoose,
  onValues,
  timeLimit,
  onTimeLimit,
  kept,
  onKept,
  scope,
  onScope,
  schedule,
  savedSchedule,
  done = false,
  onSchedule,
  onScheduleProblem,
}: {
  prompt: string
  onPrompt: (prompt: string) => void
  onPromptBlur?: () => void
  promptField?: RefObject<HTMLTextAreaElement | null>
  projectPath: string | null
  /** Whether the project row says No project now. */
  noProject: boolean
  onProject: (projectPath: string | null) => void
  onProjectError: (message: string | null) => void
  agentId: AgentId | null
  values: OptionValues
  onChoose: (agentId: AgentId, model: string | null) => void
  onValues: (optionId: string, value: string | boolean) => void
  timeLimit: TimeLimitMinutes
  onTimeLimit: (timeLimit: TimeLimitMinutes) => void
  kept: KeptRunSessions
  onKept: (kept: KeptRunSessions) => void
  scope: PermissionScope
  onScope: (scope: PermissionScope) => void
  schedule: Schedule
  savedSchedule: Schedule | null
  /** A one-time routine that has run. */
  done?: boolean
  onSchedule: (schedule: Schedule) => void
  onScheduleProblem?: (problem: ScheduleProblem | null) => void
}) {
  const { t } = useTranslation('routines')
  const projects = useProjectsStore((s) => s.projects)
  const project: Project | null =
    projectPath === null
      ? null
      : (projects.find((shown) => shown.path === projectPath) ?? {
          path: projectPath,
          name: basename(projectPath),
          missing: false,
          lastOpenedAt: 0,
        })
  const limitOptions = TIME_LIMITS.map((minutes) => ({
    value: String(minutes) as `${TimeLimitMinutes}`,
    label: minutesLabel(minutes),
  }))
  const keptOptions = KEPT_RUN_SESSIONS.map((count) => ({
    value: String(count) as `${KeptRunSessions}`,
    label: t('routine.keptRunsOption', { count }),
  }))

  return (
    <div className="k-routine__form">
      <Head title={t('routine.task')} />
      <div className="ui-sg-card">
        <label className="k-prompt">
          <span className="ui-sg-label">
            <b>{t('routine.prompt')}</b>
            <small>{t('routine.promptDescription')}</small>
          </span>
          <textarea
            ref={promptField}
            className="ui-sg-textarea"
            value={prompt}
            placeholder={t('routine.promptPlaceholder')}
            onChange={(event) => onPrompt(event.target.value)}
            onBlur={onPromptBlur}
          />
        </label>
        <Row title={t('routine.project')} note={t('routine.projectDescription')}>
          <span className="k-frame">
            <ProjectMenu
              project={project}
              noProject={noProject}
              onError={onProjectError}
              onChoose={onProject}
            />
          </span>
        </Row>
        <Row title={t('routine.agent')} note={t('routine.agentDescription')}>
          <span className="k-frame">
            <AgentMenu agentId={agentId} values={values} onChoose={onChoose} onValues={onValues} />
          </span>
        </Row>
      </div>
      <Head title={t('routine.schedule')} note={t('routine.scheduleHint')} />
      <ScheduleField
        schedule={schedule}
        saved={savedSchedule}
        done={done}
        onSchedule={onSchedule}
        {...(onScheduleProblem ? { onProblem: onScheduleProblem } : {})}
      />
      <Head title={t('routine.permissions')} note={t('routine.permissionsHint')} />
      <PermissionField scope={scope} agentId={agentId} onChange={onScope} />
      <Head title={t('routine.limits')} />
      <div className="ui-sg-card">
        <Row title={t('routine.timeLimit')} note={t('routine.timeLimitDescription')}>
          <Select
            label={t('routine.timeLimit')}
            value={String(timeLimit) as `${TimeLimitMinutes}`}
            options={limitOptions}
            onChange={(value) => onTimeLimit(Number(value) as TimeLimitMinutes)}
          />
        </Row>
        <Row title={t('routine.keptRuns')} note={t('routine.keptRunsDescription')}>
          <Select
            label={t('routine.keptRuns')}
            value={String(kept) as `${KeptRunSessions}`}
            options={keptOptions}
            onChange={(value) => onKept(Number(value) as KeptRunSessions)}
          />
        </Row>
      </div>
    </div>
  )
}

/** The page's Back: to the Routines list. */
function leaveRoutine(): void {
  backTo({ kind: 'routines' }, openRoutines)
}

/** Esc leaves the page for the Routines list, as the back link does. */
function useBackOnEscape(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (isEditable(event.target)) return
      if (document.querySelector('[data-open][data-slot$="-content"]')) return
      if (useViewStore.getState().settings.open) return
      event.preventDefault()
      leaveRoutine()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}

function initialValues(agentId: AgentId | null): OptionValues {
  if (!agentId) return {}
  const store = useAgentOptionsStore.getState()
  const entry = store.byId[agentId]
  return entry ? startValues(entry, picksOf(store, null, agentId)) : {}
}

/** Values for an agent whose options are not known yet; the run uses only known ids. */
function optionsFrom(values: OptionValues): RoutineOption[] {
  return Object.entries(values).map(([id, value]) => ({ id, value }))
}
