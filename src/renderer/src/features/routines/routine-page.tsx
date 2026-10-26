// A routine's page, and New routine, which uses the same fields before the routine exists.

import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeftIcon,
  CalendarClockIcon,
  ChartNoAxesColumnIcon,
  CircleAlertIcon,
  EllipsisIcon,
  PlayIcon,
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
import { AgentTile } from '@renderer/components/agents/agent-mark'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Switch } from '@renderer/components/ui/switch'
import { Textarea } from '@renderer/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { isEditable } from '@renderer/features/artifacts/keys'
import { AgentMenu } from '@renderer/features/session/new-session/agent-menu'
import { ProjectMenu } from '@renderer/features/session/new-session/project-menu'
import { canStart, startValues } from '@renderer/features/session/new-session/start-options'
import { SettingSelect } from '@renderer/features/settings/controls'
import { RowLine, RowShell, RowText } from '@renderer/features/settings/rows'
import { NoDrag, TopBar } from '@renderer/features/shell/top-bar'
import { basename } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import { i18n } from '@renderer/lib/i18n'
import { useAgentOptionsStore, type OptionValues } from '@renderer/stores/agent-options'
import { useAgentsStore, agentName } from '@renderer/stores/agents'
import { useProjectsStore } from '@renderer/stores/projects'
import { loadRoutinePage, useRoutinesStore } from '@renderer/stores/routines'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import { openRoutine, openRoutines, openSession, useViewStore } from '@renderer/stores/view'
import { DeleteRoutineDialog } from './delete-routine-dialog'
import { optionValues, pauseNotice, routineOptions, routineState, stateText } from './model'
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
            <Button variant="outline" onClick={openRoutines}>
              {t('routine.backToRoutines')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3" aria-hidden>
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}
      </RoutineShell>
    )
  }

  return <RoutineBody key={routine.id} routine={routine} />
}

function RoutineBody({ routine }: { routine: RoutineView }) {
  const { t } = useTranslation('routines')
  const activeSession = useSessionsStore((s) => {
    const id = routine.activeRun?.sessionId
    return id ? s.byId[id] : undefined
  })
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(routine.name)
  const [prompt, setPrompt] = useState(routine.prompt)
  const nameField = useRef<HTMLInputElement>(null)
  const nameCancelled = useRef(false)

  useEffect(() => {
    if (renaming) nameField.current?.select()
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
    if (!activeSession) return
    useSessionsStore.getState().upsert(activeSession)
    openSession(activeSession.id, activeSession.projectPath)
  }

  const state = routineState(routine)
  const now = useNow()

  return (
    <RoutineShell>
      <RunAnnouncements />
      <div className="flex items-start gap-3">
        <RoutineTile agent={routine.agentId} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {renaming ? (
            <input
              ref={nameField}
              value={name}
              maxLength={ROUTINE_NAME_CHARS}
              aria-label={t('routine.name')}
              onChange={(event) => setName(event.target.value)}
              onBlur={saveName}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  saveName()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  nameCancelled.current = true
                  setRenaming(false)
                  setName(routine.name)
                }
              }}
              className="min-w-0 rounded-md bg-transparent font-heading text-title font-semibold outline-none focus-visible:outline-[1.5px] focus-visible:outline-edit-ring focus-visible:outline-offset-2"
            />
          ) : (
            <button
              type="button"
              onClick={() => setRenaming(true)}
              title={t('routine.rename')}
              className="min-w-0 truncate rounded-md text-left font-heading text-title font-semibold outline-none hover:text-primary focus-ring"
            >
              {routine.name}
            </button>
          )}
          <p className="text-small leading-normal text-secondary">{stateText(routine, now)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" disabled={!!routine.activeRun} onClick={runNow}>
            <PlayIcon />
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
            <DropdownMenuTrigger
              render={
                <Button variant="quiet" size="icon" aria-label={t('routine.more')}>
                  <EllipsisIcon />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <RoutineMenuItems
                routine={routine}
                onDelete={() => setDeleting(true)}
                onError={setError}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {state.kind === 'waiting' && (
        <Alert variant="warning">
          <CircleAlertIcon />
          <AlertTitle>{t('routine.waitingTitle')}</AlertTitle>
          <AlertDescription>{t('routine.waitingDescription')}</AlertDescription>
          {activeSession && (
            <AlertAction>
              <Button variant="outline" size="xs" onClick={openRun}>
                {t('routine.openRun')}
              </Button>
            </AlertAction>
          )}
        </Alert>
      )}
      {state.kind === 'paused' && state.pause && (
        <Alert variant="info">
          <ChartNoAxesColumnIcon />
          <AlertTitle>{t('pause.title', { agent: agentName(state.pause.agentId) })}</AlertTitle>
          <AlertDescription>{pauseNotice(state.pause, now)}</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="error">
          <CircleAlertIcon />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-6">
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
      <div className="flex items-start gap-3">
        <RoutineTile agent={agentId} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <input
            value={name}
            maxLength={ROUTINE_NAME_CHARS}
            placeholder={t('routine.untitled')}
            aria-label={t('routine.name')}
            onChange={(event) => setName(event.target.value)}
            className="min-w-0 rounded-md bg-transparent font-heading text-title font-semibold outline-none placeholder:text-tertiary focus-visible:outline-[1.5px] focus-visible:outline-edit-ring focus-visible:outline-offset-2"
          />
          <p className="text-small leading-normal text-secondary">{t('routine.newLine')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              <Button disabled={!!missing || creating} onClick={() => void create()}>
                {t('routine.create')}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{missing ?? t('routine.createReady')}</TooltipContent>
          </Tooltip>
          <Button variant="outline" onClick={openRoutines}>
            {t('routine.cancel')}
          </Button>
        </div>
      </div>

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

function RoutineShell({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation('routines')
  return (
    <div className="flex h-full flex-col">
      <TopBar>
        <NoDrag>
          <Button variant="quiet" size="compact" className="gap-1.5 px-1.5" onClick={openRoutines}>
            <ArrowLeftIcon />
            {t('routine.back')}
          </Button>
        </NoDrag>
        <span className="flex-1" />
      </TopBar>
      <div className="min-h-0 flex-1 overflow-y-auto px-7 pt-2 pb-9 [scrollbar-gutter:stable]">
        <div className="mx-auto flex w-full max-w-thread flex-col gap-6">{children}</div>
      </div>
    </div>
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
  onSchedule,
  onScheduleProblem,
}: {
  prompt: string
  onPrompt: (prompt: string) => void
  onPromptBlur?: () => void
  promptField?: React.RefObject<HTMLTextAreaElement | null>
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
    value: String(minutes),
    label:
      minutes < 60
        ? i18n.t('routines:limit.minutes', { count: minutes })
        : i18n.t('routines:limit.hours', { count: minutes / 60 }),
  }))

  return (
    <>
      <section aria-label={t('routine.task')} className="flex flex-col">
        <h2 className="flex h-7.5 items-center px-1 text-xs font-medium text-tertiary">
          {t('routine.task')}
        </h2>
        <RowShell>
          <div className="py-3">
            <RowText name={t('routine.prompt')} description={t('routine.promptDescription')} />
            <Textarea
              ref={promptField}
              value={prompt}
              aria-label={t('routine.prompt')}
              onChange={(event) => onPrompt(event.target.value)}
              onBlur={onPromptBlur}
              className="mt-2 min-h-24 rounded-xl border-0 bg-card px-3.5 py-2.5 text-prose leading-normal shadow-card focus-visible:border-0"
            />
          </div>
        </RowShell>
        <RowShell>
          <RowLine
            text={
              <RowText name={t('routine.project')} description={t('routine.projectDescription')} />
            }
          >
            <ProjectMenu
              project={project}
              noProject={noProject}
              onError={onProjectError}
              onChoose={onProject}
            />
          </RowLine>
        </RowShell>
        <RowShell>
          <RowLine
            text={<RowText name={t('routine.agent')} description={t('routine.agentDescription')} />}
          >
            <AgentMenu agentId={agentId} values={values} onChoose={onChoose} onValues={onValues} />
          </RowLine>
        </RowShell>
      </section>
      <section aria-label={t('routine.howItRuns')} className="flex flex-col">
        <h2 className="flex h-7.5 items-center px-1 text-xs font-medium text-tertiary">
          {t('routine.howItRuns')}
        </h2>
        <RowShell>
          <div className="py-3">
            <RowText name={t('routine.schedule')} description={t('routine.scheduleDescription')} />
            <ScheduleField
              schedule={schedule}
              saved={savedSchedule}
              onSchedule={onSchedule}
              {...(onScheduleProblem ? { onProblem: onScheduleProblem } : {})}
            />
          </div>
        </RowShell>
        <RowShell>
          <div className="py-3">
            <RowText
              name={t('routine.permissions')}
              description={t('routine.permissionsDescription')}
            />
            <div className="mt-2">
              <PermissionField scope={scope} agentId={agentId} onChange={onScope} />
            </div>
          </div>
        </RowShell>
        <RowShell>
          <RowLine
            text={
              <RowText
                name={t('routine.timeLimit')}
                description={t('routine.timeLimitDescription')}
              />
            }
          >
            <SettingSelect
              label={t('routine.timeLimit')}
              value={String(timeLimit)}
              options={limitOptions}
              onChange={(value) => onTimeLimit(Number(value) as TimeLimitMinutes)}
            />
          </RowLine>
        </RowShell>
      </section>
    </>
  )
}

function RoutineTile({ agent }: { agent: AgentId | null }) {
  if (agent) return <AgentTile agent={agent} />
  return (
    <span
      aria-hidden
      className="grid size-8 shrink-0 place-items-center rounded-lg bg-tile text-icon shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)]"
    >
      <CalendarClockIcon className="size-4" />
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
