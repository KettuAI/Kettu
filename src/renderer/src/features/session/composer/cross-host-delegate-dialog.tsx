import { useEffect, useId, useMemo, useState } from 'react'
import {
  AlertCircleIcon,
  Folder01Icon,
  InformationCircleIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { Project } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Spinner } from '@renderer/components/ui/spinner'
import { Textarea } from '@renderer/components/ui/textarea'
import { HostIcon, OnlineDot } from '@renderer/features/settings/remote-parts'
import { NO_PROJECT_ICON } from '@renderer/features/shell/no-project-icon'
import { ProjectMark } from '@renderer/features/shell/project-icon'
import { errorMessage, hostAt } from '@renderer/lib/host'
import { hostPath } from '@renderer/lib/host-paths'
import { cn } from '@renderer/lib/utils'
import { agentsOn, readHostAgents, useAgentsStore } from '@renderer/stores/agents'
import { useProjectsStore } from '@renderer/stores/projects'
import {
  executeCrossHostDelegation,
  type ExecuteCrossHostDelegationInput,
} from '../cross-host-delegation-tracker'
import {
  composeCrossHostPrompt,
  defaultTargetAgentId,
  selectDelegatableHostAgents,
  targetHostProjects,
  type PairedHostAvailability,
  type PairedHostTarget,
  type RemoteTargetAgent,
} from './cross-host-delegation'

const SELF_HOST_KEY = '\0self-host'
const NO_PROJECT_KEY = '\0no-project'

const hostKey = (hostId: string | null): string => (hostId === null ? SELF_HOST_KEY : hostId)

export type TargetHostDataLoader = (targetHostId: string | null) => Promise<void>
export type CrossHostDelegationRunner = (input: ExecuteCrossHostDelegationInput) => Promise<unknown>

const defaultLoadHostData: TargetHostDataLoader = async (targetHostId) => {
  const [projects] = await Promise.all([
    hostAt(targetHostId, 'projects.list', undefined),
    targetHostId === null ? useAgentsStore.getState().refresh() : readHostAgents(targetHostId),
  ])
  useProjectsStore.getState().setAll(projects, targetHostId)
}

/**
 * Explicit confirmation dialog for user-initiated cross-host delegation (#2581).
 *
 * Lets the user explicitly pick a paired same-account computer (showing online/offline status),
 * choose a project and agent loaded from that computer, review/edit the task and opt-in context,
 * and confirms that the target session will use the target computer's own permissions.
 */
export function CrossHostDelegateDialog({
  open,
  onOpenChange,
  originSessionId,
  originHostId,
  originHostName,
  originSessionTitle,
  originAgentId,
  originFullAccess,
  initialTask,
  originContextPreview,
  targets,
  onDelegated,
  loadHostData = defaultLoadHostData,
  runDelegation = executeCrossHostDelegation,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  originSessionId: string
  originHostId: string | null
  originHostName: string
  originSessionTitle: string
  originAgentId: AgentId
  originFullAccess: boolean
  initialTask: string
  originContextPreview: string
  targets: readonly PairedHostTarget[]
  onDelegated: () => void
  loadHostData?: TargetHostDataLoader
  runDelegation?: CrossHostDelegationRunner
}) {
  const { t } = useTranslation('composer')
  const taskFieldId = useId()
  const contextFieldId = useId()
  const contextCheckId = useId()

  const firstOnline = useMemo(() => targets.find((target) => target.selectable) ?? null, [targets])
  const [selectedHostKey, setSelectedHostKey] = useState<string | null>(() =>
    firstOnline ? hostKey(firstOnline.hostId) : null,
  )
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState<AgentId | null>(null)
  const [task, setTask] = useState(initialTask)
  const [includeContext, setIncludeContext] = useState(false)
  const [contextText, setContextText] = useState('')
  const [contextTouched, setContextTouched] = useState(false)
  const [loadState, setLoadState] = useState<{
    key: string | null
    loading: boolean
    error: string | null
  }>({ key: null, loading: false, error: null })
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [wasOpen, setWasOpen] = useState(open)

  // Reset form state cleanly every time the dialog opens.
  if (wasOpen !== open) {
    setWasOpen(open)
    if (open) {
      setSelectedHostKey(firstOnline ? hostKey(firstOnline.hostId) : null)
      setSelectedProjectKey(null)
      setSelectedAgentId(null)
      setTask(initialTask)
      setIncludeContext(false)
      setContextText('')
      setContextTouched(false)
      setLoadState({ key: null, loading: false, error: null })
      setSubmitError(null)
      setSubmitting(false)
    }
  }

  // Keep the chosen computer valid if live connection status changes while the dialog is open.
  const selectedHost = useMemo(() => {
    const matched = targets.find((target) => hostKey(target.hostId) === selectedHostKey)
    if (matched?.selectable) return matched
    return firstOnline
  }, [targets, selectedHostKey, firstOnline])

  const activeHostKey = selectedHost ? hostKey(selectedHost.hostId) : null
  const activeHostId = selectedHost ? selectedHost.hostId : null

  const loadKey = open && activeHostKey ? activeHostKey : null
  if (loadState.key !== loadKey) {
    setLoadState({ key: loadKey, loading: loadKey !== null, error: null })
  }

  const allProjects = useProjectsStore((s) => s.projects)
  const projects = useMemo<Project[]>(
    () => (selectedHost ? targetHostProjects(allProjects, activeHostId) : []),
    [allProjects, selectedHost, activeHostId],
  )
  const hostAgents = useAgentsStore((s) =>
    selectedHost ? agentsOn(s, activeHostId) : { byId: {}, order: [] },
  )
  const agents = useMemo<RemoteTargetAgent[]>(
    () => selectDelegatableHostAgents(hostAgents),
    [hostAgents],
  )

  // Refresh the chosen target computer's projects and installed agents whenever it changes.
  useEffect(() => {
    if (!open || !selectedHost || !activeHostKey) return
    let cancelled = false
    loadHostData(selectedHost.hostId)
      .then(() => {
        if (cancelled) return
        setLoadState((current) =>
          current.key === activeHostKey
            ? { key: activeHostKey, loading: false, error: null }
            : current,
        )
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setLoadState((current) =>
          current.key === activeHostKey
            ? {
                key: activeHostKey,
                loading: false,
                error: errorMessage(error) || t('crossHostDelegation.loadTargetFailed'),
              }
            : current,
        )
      })
    return () => {
      cancelled = true
    }
  }, [open, selectedHost, activeHostKey, loadHostData, t])

  // Derive effective project and agent selections with sensible defaults for the active host.
  const effectiveProjectKey = useMemo(() => {
    if (!selectedHost) return null
    if (selectedProjectKey === NO_PROJECT_KEY) return NO_PROJECT_KEY
    if (
      selectedProjectKey !== null &&
      projects.some((project) => project.path === selectedProjectKey && !project.missing)
    ) {
      return selectedProjectKey
    }
    const firstUsable = projects.find((project) => !project.missing)
    return firstUsable ? firstUsable.path : NO_PROJECT_KEY
  }, [selectedHost, selectedProjectKey, projects])

  const effectiveAgentId = useMemo(() => {
    if (!selectedHost) return null
    if (
      selectedAgentId !== null &&
      agents.some((agent) => agent.id === selectedAgentId && agent.selectable)
    ) {
      return selectedAgentId
    }
    return defaultTargetAgentId(agents, originAgentId)
  }, [selectedHost, selectedAgentId, agents, originAgentId])

  const selectedProject = useMemo(
    () =>
      effectiveProjectKey && effectiveProjectKey !== NO_PROJECT_KEY
        ? (projects.find((project) => project.path === effectiveProjectKey) ?? null)
        : null,
    [effectiveProjectKey, projects],
  )
  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === effectiveAgentId) ?? null,
    [agents, effectiveAgentId],
  )

  const loadingTarget = loadState.key === activeHostKey && loadState.loading
  const loadError = loadState.key === activeHostKey ? loadState.error : null
  const trimmedTask = task.trim()
  const canConfirm =
    !submitting &&
    selectedHost !== null &&
    selectedHost.selectable &&
    selectedAgent !== null &&
    selectedAgent.selectable &&
    trimmedTask.length > 0

  const availabilityLabel = (availability: PairedHostAvailability): string => {
    switch (availability) {
      case 'online':
        return t('crossHostDelegation.hostOnline')
      case 'connecting':
        return t('crossHostDelegation.hostConnecting')
      case 'update_client':
      case 'update_host':
        return t('crossHostDelegation.hostUpdateRequired')
      case 'offline':
        return t('crossHostDelegation.hostOffline')
    }
  }

  const agentStateLabel = (agent: RemoteTargetAgent): { text: string; tone: string } | null => {
    if (agent.state === 'needs_sign_in') {
      return { text: t('delegation.statusSignIn'), tone: 'text-warning' }
    }
    if (agent.state === 'installing') {
      return { text: t('delegation.statusInstalling'), tone: 'text-tertiary' }
    }
    if (agent.state === 'failed') {
      return { text: t('delegation.statusFailed'), tone: 'text-danger' }
    }
    return null
  }

  const handleToggleContext = (checked: boolean) => {
    setIncludeContext(checked)
    if (checked && !contextTouched && contextText === '') {
      setContextText(originContextPreview)
    }
  }

  const handleConfirm = async () => {
    if (!canConfirm || !selectedHost || !selectedAgent) return
    setSubmitError(null)
    setSubmitting(true)
    const promptText = composeCrossHostPrompt({
      task: trimmedTask,
      includeContext,
      contextText,
      originHostName,
      originSessionTitle,
    })
    try {
      await runDelegation({
        originSessionId,
        originHostId,
        targetHostId: selectedHost.hostId,
        targetHostName: selectedHost.name,
        targetHostPlatform: selectedHost.platform,
        targetProjectPath: selectedProject ? selectedProject.path : null,
        targetProjectName: selectedProject ? selectedProject.name : null,
        targetAgentId: selectedAgent.id,
        targetAgentName: selectedAgent.name,
        taskText: trimmedTask,
        promptText,
      })
      onOpenChange(false)
      onDelegated()
    } catch (error: unknown) {
      setSubmitError(errorMessage(error) || t('crossHostDelegation.startFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next)
      }}
    >
      <DialogContent
        data-cross-host-delegate-dialog=""
        className="flex max-h-[min(86dvh,720px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
      >
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle>{t('crossHostDelegation.dialogTitle')}</DialogTitle>
          <DialogDescription>{t('crossHostDelegation.dialogDescription')}</DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-4">
          {/* 1. Target paired computer */}
          <section
            className="flex flex-col gap-1.5"
            aria-label={t('crossHostDelegation.hostLabel')}
          >
            <span className="text-small font-medium text-primary">
              {t('crossHostDelegation.hostLabel')}
            </span>
            {targets.length === 0 ? (
              <p className="rounded-lg bg-subtle px-3 py-2.5 text-small text-tertiary">
                {t('crossHostDelegation.noPairedHosts')}
              </p>
            ) : (
              <div
                role="radiogroup"
                aria-label={t('crossHostDelegation.hostLabel')}
                className="flex flex-col gap-1"
              >
                {targets.map((target) => {
                  const key = hostKey(target.hostId)
                  const selected = activeHostKey === key && target.selectable
                  const statusText = availabilityLabel(target.availability)
                  return (
                    <button
                      key={key}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      disabled={!target.selectable || submitting}
                      data-cross-host-option={target.hostId ?? 'local'}
                      onClick={() => {
                        setSelectedHostKey(key)
                        setSelectedProjectKey(null)
                        setSelectedAgentId(null)
                        setSubmitError(null)
                      }}
                      className={cn(
                        'flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-menu transition-colors outline-none focus-ring',
                        selected
                          ? 'bg-selected text-primary shadow-[inset_0_0_0_var(--hairline)_var(--border-strong)]'
                          : 'bg-subtle text-primary shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)] enabled:hover:bg-hover',
                        !target.selectable && 'cursor-not-allowed opacity-55',
                      )}
                    >
                      <HostIcon platform={target.platform} className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate font-medium">{target.name}</span>
                      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                        {target.availability === 'online' && <OnlineDot />}
                        <span>{statusText}</span>
                      </span>
                      {selected && (
                        <HugeiconsIcon
                          aria-hidden
                          icon={Tick02Icon}
                          strokeWidth={2}
                          className="size-3.5 shrink-0 text-primary"
                        />
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </section>

          {/* 2. Target project */}
          {selectedHost && (
            <section
              className="flex flex-col gap-1.5"
              aria-label={t('crossHostDelegation.projectLabel')}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-small font-medium text-primary">
                  {t('crossHostDelegation.projectLabel')}
                </span>
                {loadingTarget && (
                  <span className="inline-flex items-center gap-1.5 text-xs text-tertiary">
                    <Spinner className="size-3" />
                    {t('crossHostDelegation.loadingTarget')}
                  </span>
                )}
              </div>
              {loadError && (
                <p role="alert" className="text-small text-danger">
                  {loadError}
                </p>
              )}
              <div
                role="radiogroup"
                aria-label={t('crossHostDelegation.projectLabel')}
                className="flex max-h-36 flex-col gap-1 overflow-y-auto"
              >
                {projects.map((project) => {
                  const selected = effectiveProjectKey === project.path
                  const disabled = project.missing || submitting
                  return (
                    <button
                      key={project.path}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      disabled={disabled}
                      data-cross-host-project={project.path}
                      onClick={() => {
                        setSelectedProjectKey(project.path)
                        setSubmitError(null)
                      }}
                      className={cn(
                        'flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-menu transition-colors outline-none focus-ring',
                        selected
                          ? 'bg-selected text-primary shadow-[inset_0_0_0_var(--hairline)_var(--border-strong)]'
                          : 'bg-subtle text-primary shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)] enabled:hover:bg-hover',
                        project.missing && 'cursor-not-allowed opacity-55',
                      )}
                    >
                      <span className="grid size-4 shrink-0 place-items-center text-icon">
                        {project.icon ? (
                          <ProjectMark icon={project.icon} fallback="folder-glyph" />
                        ) : (
                          <HugeiconsIcon
                            aria-hidden
                            icon={Folder01Icon}
                            strokeWidth={1.9}
                            className="size-4"
                          />
                        )}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-medium">{project.name}</span>
                        <span className="truncate text-xs text-tertiary">
                          {hostPath(project.path)}
                        </span>
                      </span>
                      {project.missing && (
                        <span className="shrink-0 text-xs text-danger">
                          {t('crossHostDelegation.projectMissing')}
                        </span>
                      )}
                      {selected && !project.missing && (
                        <HugeiconsIcon
                          aria-hidden
                          icon={Tick02Icon}
                          strokeWidth={2}
                          className="size-3.5 shrink-0 text-primary"
                        />
                      )}
                    </button>
                  )
                })}
                <button
                  type="button"
                  role="radio"
                  aria-checked={effectiveProjectKey === NO_PROJECT_KEY}
                  disabled={submitting}
                  data-cross-host-project="none"
                  onClick={() => {
                    setSelectedProjectKey(NO_PROJECT_KEY)
                    setSubmitError(null)
                  }}
                  className={cn(
                    'flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-menu transition-colors outline-none focus-ring',
                    effectiveProjectKey === NO_PROJECT_KEY
                      ? 'bg-selected text-primary shadow-[inset_0_0_0_var(--hairline)_var(--border-strong)]'
                      : 'bg-subtle text-primary shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)] enabled:hover:bg-hover',
                  )}
                >
                  <HugeiconsIcon
                    aria-hidden
                    icon={NO_PROJECT_ICON}
                    strokeWidth={1.9}
                    className="size-4 shrink-0 text-icon"
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">
                      {t('crossHostDelegation.noProject')}
                    </span>
                    <span className="truncate text-xs text-tertiary">
                      {t('crossHostDelegation.noProjectHint')}
                    </span>
                  </span>
                  {effectiveProjectKey === NO_PROJECT_KEY && (
                    <HugeiconsIcon
                      aria-hidden
                      icon={Tick02Icon}
                      strokeWidth={2}
                      className="size-3.5 shrink-0 text-primary"
                    />
                  )}
                </button>
              </div>
            </section>
          )}

          {/* 3. Target agent */}
          {selectedHost && (
            <section
              className="flex flex-col gap-1.5"
              aria-label={t('crossHostDelegation.agentLabel')}
            >
              <span className="text-small font-medium text-primary">
                {t('crossHostDelegation.agentLabel')}
              </span>
              {agents.length === 0 ? (
                <p className="rounded-lg bg-subtle px-3 py-2.5 text-small text-tertiary">
                  {loadingTarget
                    ? t('delegation.loading')
                    : t('crossHostDelegation.noAgentsOnHost', { host: selectedHost.name })}
                </p>
              ) : (
                <div
                  role="radiogroup"
                  aria-label={t('crossHostDelegation.agentLabel')}
                  className="flex max-h-36 flex-col gap-1 overflow-y-auto"
                >
                  {agents.map((agent) => {
                    const selected = effectiveAgentId === agent.id && agent.selectable
                    const stateNote = agentStateLabel(agent)
                    const subtitle = agent.harnessName !== agent.name ? agent.harnessName : null
                    return (
                      <button
                        key={agent.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        disabled={!agent.selectable || submitting}
                        data-cross-host-agent={agent.id}
                        onClick={() => {
                          setSelectedAgentId(agent.id)
                          setSubmitError(null)
                        }}
                        className={cn(
                          'flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-menu transition-colors outline-none focus-ring',
                          selected
                            ? 'bg-selected text-primary shadow-[inset_0_0_0_var(--hairline)_var(--border-strong)]'
                            : 'bg-subtle text-primary shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)] enabled:hover:bg-hover',
                          !agent.selectable && 'cursor-not-allowed opacity-55',
                        )}
                      >
                        <AgentMark agent={agent.id} size={16} hostId={activeHostId} />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate font-medium">{agent.name}</span>
                          {subtitle && (
                            <span className="truncate text-xs text-tertiary">{subtitle}</span>
                          )}
                        </span>
                        {stateNote && (
                          <span className={cn('shrink-0 text-xs', stateNote.tone)}>
                            {stateNote.text}
                          </span>
                        )}
                        {selected && (
                          <HugeiconsIcon
                            aria-hidden
                            icon={Tick02Icon}
                            strokeWidth={2}
                            className="size-3.5 shrink-0 text-primary"
                          />
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
            </section>
          )}

          {/* 4. Explicit task & opt-in context review */}
          <section className="flex flex-col gap-2">
            <label htmlFor={taskFieldId} className="text-small font-medium text-primary">
              {t('crossHostDelegation.taskLabel')}
            </label>
            <Textarea
              id={taskFieldId}
              value={task}
              disabled={submitting}
              onChange={(event) => {
                setTask(event.target.value)
                setSubmitError(null)
              }}
              placeholder={t('crossHostDelegation.taskPlaceholder')}
              className="min-h-20 max-h-40 resize-y"
              data-cross-host-task=""
            />

            <label
              htmlFor={contextCheckId}
              className="mt-1 flex cursor-pointer items-start gap-2 select-none"
            >
              <Checkbox
                id={contextCheckId}
                checked={includeContext}
                disabled={submitting}
                onCheckedChange={(checked) => handleToggleContext(checked === true)}
                className="mt-0.5"
                data-cross-host-include-context=""
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-small font-medium text-primary">
                  {t('crossHostDelegation.includeContext')}
                </span>
                <span className="text-xs text-tertiary">
                  {t('crossHostDelegation.includeContextHint')}
                </span>
              </span>
            </label>

            {includeContext && (
              <div className="flex flex-col gap-1 pt-0.5">
                <label htmlFor={contextFieldId} className="text-xs font-medium text-secondary">
                  {t('crossHostDelegation.contextLabel')}
                </label>
                <Textarea
                  id={contextFieldId}
                  value={contextText}
                  disabled={submitting}
                  onChange={(event) => {
                    setContextTouched(true)
                    setContextText(event.target.value)
                  }}
                  placeholder={t('crossHostDelegation.contextPlaceholder')}
                  className="min-h-24 max-h-44 resize-y text-small"
                  data-cross-host-context=""
                />
              </div>
            )}
          </section>

          {/* 5. Explicit permission isolation notice */}
          <div
            data-cross-host-permission-note=""
            className="flex items-start gap-2 rounded-xl bg-subtle px-3 py-2.5 text-small text-secondary shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)]"
          >
            <HugeiconsIcon
              aria-hidden
              icon={InformationCircleIcon}
              strokeWidth={1.9}
              className="mt-0.5 size-4 shrink-0 text-tertiary"
            />
            <div className="flex min-w-0 flex-col gap-1">
              <p>
                {t('crossHostDelegation.permissionNotice', {
                  host: selectedHost?.name ?? t('place.unknownHost'),
                })}
              </p>
              {originFullAccess && (
                <p className="text-xs text-warning">
                  {t('crossHostDelegation.fullAccessNotCarried')}
                </p>
              )}
            </div>
          </div>

          {submitError && (
            <div
              role="alert"
              data-cross-host-error=""
              className="flex items-start gap-2 rounded-lg bg-subtle px-3 py-2 text-small text-danger shadow-[inset_0_0_0_var(--hairline)_var(--danger)]"
            >
              <HugeiconsIcon
                aria-hidden
                icon={AlertCircleIcon}
                strokeWidth={1.9}
                className="mt-0.5 size-4 shrink-0"
              />
              <span>{submitError}</span>
            </div>
          )}
        </div>

        <DialogFooter className="border-t border-subtle px-5 py-3.5">
          <Button
            type="button"
            variant="outline"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            {t('crossHostDelegation.cancel')}
          </Button>
          <Button
            type="button"
            disabled={!canConfirm}
            onClick={() => void handleConfirm()}
            data-cross-host-confirm=""
          >
            {submitting && <Spinner className="size-3.5" />}
            {selectedHost
              ? t('crossHostDelegation.confirmOnHost', { host: selectedHost.name })
              : t('crossHostDelegation.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
