// A routine's page, and New routine, which uses the same fields before the routine exists.

import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from 'react'
import {
  ArrowLeftIcon,
  CalendarClockIcon,
  ChartNoAxesColumnIcon,
  CircleAlertIcon,
  EllipsisIcon,
  PlayIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Project } from '@shared/agent-host'
import {
  DEFAULT_SCHEDULE,
  DEFAULT_SCOPE,
  DEFAULT_TIME_LIMIT,
  ROUTINE_NAME_CHARS,
  TIME_LIMITS,
  type PermissionScope,
  type RoutineChanges,
  type RoutineOption,
  type RoutineView,
  type Schedule,
  type TimeLimitMinutes,
} from '@shared/routines'
import type { ScheduleProblem } from '@shared/schedule'
import type { AgentId } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { InputGroup, InputGroupTextarea } from '@renderer/components/ui/input-group'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Switch } from '@renderer/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { isEditable } from '@renderer/features/artifacts/keys'
import { AgentMenu } from '@renderer/features/session/new-session/agent-menu'
import { ProjectMenu } from '@renderer/features/session/new-session/project-menu'
import { canStart, startValues } from '@renderer/features/session/new-session/start-options'
import { TopBar } from '@renderer/features/shell/top-bar'
import { basename } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useAgentOptionsStore, type OptionValues } from '@renderer/stores/agent-options'
import { useAgentsStore, agentName } from '@renderer/stores/agents'
import { useProjectsStore } from '@renderer/stores/projects'
import { loadRoutinePage, useRoutinesStore } from '@renderer/stores/routines'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import { openRoutine, openRoutines, useViewStore } from '@renderer/stores/view'
import { openActiveRun } from './actions'
import { DeleteRoutineDialog } from './delete-routine-dialog'
import { FieldFrame, FieldRow, FieldSelect, RoutineSection } from './fields'
import {
  minutesLabel,
  optionValues,
  pauseNotice,
  routineOptions,
  routineState,
  stateText,
} from './model'
import { PermissionField } from './permission-field'
import { RoutineMenuItems } from './routine-menu'
import { RunAnnouncements, RunHistory } from './run-history'
import { ScheduleField } from './schedule-field'

export default function RoutinePage({ routineId }: { routineId: string | null }) {
  return routineId === null ? <NewRoutine /> : <ExistingRoutine routineId={routineId} />
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
      <RoutineShell>
        {loaded ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-small text-secondary">
              {loadError ? t('page.loadFailed') : t('routine.deleted')}
            </p>
            <Button variant="outline" size="sm" onClick={openRoutines}>
              {t('routine.backToRoutines')}
            </Button>
          </div>
        ) : (
          <div aria-hidden>
            <div className="flex items-center gap-3">
              <Skeleton className="size-11 rounded-xl" />
              <div className="flex flex-col gap-2">
                <Skeleton className="h-5 w-56" />
                <Skeleton className="h-3 w-40" />
              </div>
            </div>
            <Skeleton className="mt-9 h-24 w-full rounded-xl" />
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
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(routine.name)
  const [prompt, setPrompt] = useState(routine.prompt)
  const nameField = useRef<HTMLInputElement>(null)
  const nameButton = useRef<HTMLButtonElement>(null)
  const nameCancelled = useRef(false)
  // Enter and Esc hand the focus back to the name; a click elsewhere keeps it where it went.
  const refocusName = useRef(false)

  useEffect(() => {
    if (renaming) {
      nameField.current?.select()
    } else if (refocusName.current) {
      refocusName.current = false
      nameButton.current?.focus()
    }
  }, [renaming])

  const save = (changes: RoutineChanges) => {
    setError(null)
    useRoutinesStore
      .getState()
      .update(routine.id, changes)
      .catch((failure: unknown) => setError(errorMessage(failure)))
  }

  const saveName = () => {
    setRenaming(false)
    if (nameCancelled.current) {
      nameCancelled.current = false
      setName(routine.name)
      return
    }
    const next = name.trim()
    if (next === routine.name) {
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
      <Alert key="waiting" variant="warning" className="has-data-[slot=alert-action]:pr-32">
        <TriangleAlertIcon />
        <AlertTitle>{t('routine.waitingTitle')}</AlertTitle>
        <AlertDescription>{t('routine.waitingDescription')}</AlertDescription>
        {routine.activeRun?.sessionId && (
          <AlertAction className="top-1/2 right-3.5 -translate-y-1/2">
            <Button variant="outline" size="sm" onClick={openRun}>
              {t('routine.openRun')}
            </Button>
          </AlertAction>
        )}
      </Alert>,
    )
  }
  if (state.kind === 'paused' && state.pause) {
    notices.push(
      <Alert key="paused" variant="info">
        <ChartNoAxesColumnIcon />
        <AlertTitle>{t('pause.title', { agent: agentName(state.pause.agentId) })}</AlertTitle>
        <AlertDescription>{pauseNotice(state.pause, now)}</AlertDescription>
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

  return (
    <RoutineShell>
      <RunAnnouncements />
      <header className="mb-5.5 flex items-center gap-3">
        <RoutineTile agent={routine.agentId} />
        <div className="min-w-0 flex-1">
          {renaming ? (
            <NameField
              ref={nameField}
              value={name}
              onChange={(event) => setName(event.target.value)}
              onBlur={saveName}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  refocusName.current = true
                  saveName()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  nameCancelled.current = true
                  refocusName.current = true
                  setRenaming(false)
                  setName(routine.name)
                }
              }}
            />
          ) : (
            <h1 className="flex font-heading text-title font-semibold">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      ref={nameButton}
                      type="button"
                      onClick={() => setRenaming(true)}
                      className="-mx-1.25 min-w-0 truncate rounded-md px-1.25 text-left transition-colors duration-(--duration-fast) outline-none focus-ring hover:bg-hover"
                    />
                  }
                >
                  {routine.name}
                </TooltipTrigger>
                <TooltipContent side="bottom" align="start">
                  {t('routine.rename')}
                </TooltipContent>
              </Tooltip>
            </h1>
          )}
          <p
            className={cn(
              'mt-0.5 text-small text-tertiary',
              state.kind === 'waiting' && 'text-attention',
              state.kind === 'running' && state.status === 'running' && 'text-info',
            )}
          >
            {stateText(routine, now)}
          </p>
        </div>
        <Button variant="outline" size="sm" disabled={!!routine.activeRun} onClick={runNow}>
          <PlayIcon data-icon="inline-start" />
          {t('routine.runNow')}
        </Button>
        <Switch
          checked={routine.enabled}
          onCheckedChange={(enabled) => save({ enabled })}
          aria-label={t(routine.enabled ? 'page.switchOff' : 'page.switchOn', {
            name: routine.name,
          })}
        />
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              render={
                <DropdownMenuTrigger
                  render={<Button variant="quiet" size="icon-sm" aria-label={t('routine.more')} />}
                />
              }
            >
              <EllipsisIcon />
            </TooltipTrigger>
            <TooltipContent>{t('routine.more')}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end">
            <RoutineMenuItems
              routine={routine}
              onDelete={() => setDeleting(true)}
              onError={setError}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {notices.length > 0 && <div className="flex flex-col gap-2">{notices}</div>}

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
              : { ...(useAgentOptionsStore.getState().picks[agentId] ?? {}) }
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
        scope={routine.scope}
        onScope={(scope) => save({ scope })}
        schedule={routine.trigger.schedule}
        savedSchedule={routine.trigger.schedule}
        done={routine.state === 'done'}
        onSchedule={(schedule) => save({ trigger: { kind: 'schedule', schedule } })}
      />
      <RunHistory routine={routine} />

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
    </RoutineShell>
  )
}

function NewRoutine() {
  const { t } = useTranslation('routines')
  const projects = useProjectsStore((s) => s.projects)
  const defaultAgent = useSettingsStore((s) => s.settings.general.defaultAgent)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
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
  const [scope, setScope] = useState<PermissionScope>(DEFAULT_SCOPE)
  const [schedule, setSchedule] = useState<Schedule>(DEFAULT_SCHEDULE)
  const [scheduleProblem, setScheduleProblem] = useState<ScheduleProblem | null>(null)

  useBackOnEscape()
  useEffect(() => {
    promptField.current?.focus()
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
      })
      openRoutine(routine.id)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setCreating(false)
    }
  }

  return (
    <RoutineShell>
      <header className="mb-5.5 flex items-center gap-3">
        <RoutineTile agent={agentId} />
        <div className="min-w-0 flex-1">
          <NameField
            value={name}
            placeholder={t('routine.untitled')}
            onChange={(event) => setName(event.target.value)}
          />
          <p className="mt-0.5 text-small text-tertiary">
            {name.trim() ? t('routine.notSaved') : t('routine.newNotSaved')}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={openRoutines}>
          {t('routine.cancel')}
        </Button>
        {/* Says what is missing; once nothing is, the button needs no words of its own. */}
        <Tooltip disabled={!missing}>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <Button size="sm" disabled={!!missing || creating} onClick={() => void create()}>
              {t('routine.create')}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="end">
            {missing}
          </TooltipContent>
        </Tooltip>
      </header>

      {error && (
        <Alert variant="error">
          <CircleAlertIcon />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

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
          const next = { ...(useAgentOptionsStore.getState().picks[id] ?? {}) }
          const modelOption = entry?.config.find((option) => option.category === 'model')
          if (modelOption) {
            if (model === null) delete next[modelOption.id]
            else next[modelOption.id] = model
          }
          setValues(entry ? startValues(entry, next) : next)
        }}
        onValues={(optionId, value) => setValues((current) => ({ ...current, [optionId]: value }))}
        timeLimit={timeLimit}
        onTimeLimit={setTimeLimit}
        scope={scope}
        onScope={setScope}
        schedule={schedule}
        savedSchedule={null}
        onSchedule={setSchedule}
        onScheduleProblem={setScheduleProblem}
      />
    </RoutineShell>
  )
}

function RoutineShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation('routines')
  return (
    <div className="flex h-full flex-col">
      <TopBar className="shadow-none">{null}</TopBar>
      <div className="min-h-0 flex-1 scroll-fade-y overflow-y-auto [scrollbar-gutter:stable]">
        {/* Block flow, so a section's margin and the header's meet as one gap. */}
        <div className="@container/routine mx-auto w-full max-w-210 px-10 pb-20">
          <div className="mb-3.5 flex">
            <Button variant="quiet" size="sm" className="-ml-2 gap-1.5 px-2" onClick={openRoutines}>
              <ArrowLeftIcon />
              {t('routine.back')}
            </Button>
          </div>
          {children}
        </div>
      </div>
    </div>
  )
}

/** The name as an underlined field: New routine's, and a routine's while it is renamed. */
function NameField({ className, ...props }: ComponentProps<'input'>) {
  const { t } = useTranslation('routines')
  return (
    <input
      maxLength={ROUTINE_NAME_CHARS}
      aria-label={t('routine.name')}
      autoComplete="off"
      spellCheck={false}
      className={cn(
        '-mx-1.25 block h-7.5 w-105 max-w-full rounded-t-md bg-transparent px-1.25 font-heading text-title font-semibold text-primary shadow-[inset_0_calc(-1*var(--hairline))_0_var(--border-default)] transition-shadow duration-(--duration-fast) outline-none placeholder:text-placeholder selection:bg-edit-selection hover:shadow-[inset_0_calc(-1*var(--hairline))_0_var(--border-strong)] focus-visible:rounded-md focus-visible:shadow-none focus-visible:outline-[1.5px] focus-visible:outline-offset-1 focus-visible:outline-edit-ring focus-visible:outline-solid',
        className,
      )}
      {...props}
    />
  )
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

  return (
    <>
      <RoutineSection title={t('routine.task')}>
        <FieldRow name={t('routine.prompt')} description={t('routine.promptDescription')} wide>
          <InputGroup variant="prompt">
            <InputGroupTextarea
              ref={promptField}
              value={prompt}
              aria-label={t('routine.prompt')}
              placeholder={t('routine.promptPlaceholder')}
              onChange={(event) => onPrompt(event.target.value)}
              onBlur={onPromptBlur}
              className="min-h-24 px-3.5 py-3 text-prose leading-normal md:text-prose"
            />
          </InputGroup>
        </FieldRow>
        <FieldRow name={t('routine.project')} description={t('routine.projectDescription')}>
          <FieldFrame>
            <ProjectMenu
              project={project}
              noProject={noProject}
              onError={onProjectError}
              onChoose={onProject}
            />
          </FieldFrame>
        </FieldRow>
        <FieldRow name={t('routine.agent')} description={t('routine.agentDescription')}>
          <FieldFrame>
            <AgentMenu agentId={agentId} values={values} onChoose={onChoose} onValues={onValues} />
          </FieldFrame>
        </FieldRow>
      </RoutineSection>
      <RoutineSection title={t('routine.howItRuns')}>
        <FieldRow name={t('routine.schedule')} description={t('routine.scheduleDescription')} wide>
          <ScheduleField
            schedule={schedule}
            saved={savedSchedule}
            done={done}
            onSchedule={onSchedule}
            {...(onScheduleProblem ? { onProblem: onScheduleProblem } : {})}
          />
        </FieldRow>
        <FieldRow
          name={t('routine.permissions')}
          description={t('routine.permissionsDescription')}
          wide
        >
          <PermissionField scope={scope} agentId={agentId} onChange={onScope} />
        </FieldRow>
        <FieldRow name={t('routine.timeLimit')} description={t('routine.timeLimitDescription')}>
          <FieldSelect
            label={t('routine.timeLimit')}
            value={String(timeLimit) as `${TimeLimitMinutes}`}
            options={limitOptions}
            onChange={(value) => onTimeLimit(Number(value) as TimeLimitMinutes)}
          />
        </FieldRow>
      </RoutineSection>
    </>
  )
}

/** The routine's agent on a raised tile, or a calendar before New routine has an agent. */
function RoutineTile({ agent }: { agent: AgentId | null }) {
  return (
    <span
      aria-hidden
      className="grid size-11 shrink-0 place-items-center rounded-xl bg-card text-icon shadow-card"
    >
      {agent ? <AgentMark agent={agent} size={20} /> : <CalendarClockIcon className="size-5" />}
    </span>
  )
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
      openRoutines()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}

function initialValues(agentId: AgentId | null): OptionValues {
  if (!agentId) return {}
  const store = useAgentOptionsStore.getState()
  const entry = store.byId[agentId]
  return entry ? startValues(entry, store.picks[agentId]) : {}
}

/** Values for an agent whose options are not known yet; the run uses only known ids. */
function optionsFrom(values: OptionValues): RoutineOption[] {
  return Object.entries(values).map(([id, value]) => ({ id, value }))
}
