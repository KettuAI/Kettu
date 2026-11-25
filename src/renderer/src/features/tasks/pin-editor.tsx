import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { StepPick, TaskView } from '@shared/workflow'
import type { AgentId, ConfigOption } from '@shared/thread'
import { Button } from '@renderer/components/ui/button'
import { AgentMenu } from '@renderer/features/session/new-session/agent-menu'
import { startValues } from '@renderer/features/session/new-session/start-options'
import { errorMessage, host } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import {
  optionsOn,
  picksOf,
  useAgentOptionsStore,
  type OptionValues,
} from '@renderer/stores/agent-options'
import type { AgentOptions } from '@shared/agent-host'
import { useTasksStore } from '@renderer/stores/tasks'
import { agentName } from '@renderer/stores/agents'
import { canDoSteps } from './model'
import { runsSteps } from '@renderer/features/session/new-session/workflow-picks'

function modelOption(entry: AgentOptions | undefined): ConfigOption | undefined {
  return entry?.config.find((o) => o.category === 'model' && o.type === 'select')
}

function levelOption(entry: AgentOptions | undefined, model: string | null) {
  return (
    (model === null ? undefined : entry?.levels[model]) ??
    entry?.config.find((o) => o.category === 'thought_level' && o.type === 'select')
  )
}

/** The agent's options as a pick: its model and effort among `values`, or its own. */
function pickOf(entry: AgentOptions | undefined, agentId: AgentId, values: OptionValues): StepPick {
  const model = modelOption(entry)
  const chosen = model ? values[model.id] : undefined
  const modelValue =
    typeof chosen === 'string' ? chosen : typeof model?.value === 'string' ? model.value : null
  const level = levelOption(entry, modelValue)
  const effort = level ? values[level.id] : undefined
  return {
    agentId,
    model: modelValue,
    effort:
      typeof effort === 'string' ? effort : typeof level?.value === 'string' ? level.value : null,
  }
}

/** A pick as the option values the agent menu shows. */
function valuesOf(entry: AgentOptions | undefined, pick: StepPick): OptionValues {
  const values: OptionValues = {}
  const model = modelOption(entry)
  if (model && pick.model !== null) values[model.id] = pick.model
  const level = levelOption(entry, pick.model)
  if (level && pick.effort !== null) values[level.id] = pick.effort
  return values
}

/**
 * Who does a step for this task alone: an agent with its model and effort from the agent menu,
 * kept here rather than in New session's picks; Back to Auto drops a pin made before.
 */
export function PinEditor({
  view,
  stepId,
  onDone,
}: {
  view: TaskView
  stepId: string
  onDone: () => void
}) {
  const { t } = useTranslation(['tasks', 'common'])
  const hostId = hostOfPath(view.projectPath)
  const pinned = view.pins[stepId] ?? null
  const [agentId, setAgentId] = useState<AgentId | null>(pinned?.agentId ?? null)
  const [values, setValues] = useState<OptionValues>(() =>
    pinned
      ? valuesOf(optionsOn(useAgentOptionsStore.getState(), hostId)[pinned.agentId], pinned)
      : {},
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notYet, setNotYet] = useState<string | null>(null)

  const send = async (pick: StepPick | null) => {
    if (pick && !canDoSteps(pick.agentId)) {
      setError(t('pin.onlySteps'))
      return
    }
    setBusy(true)
    setError(null)
    setNotYet(null)
    try {
      const next = await host('tasks.pin', { taskId: view.id, stepId, pick })
      useTasksStore.getState().receive(next, useTasksStore.getState().hosts[view.id] ?? null)
      // A pin kept for someone who cannot take the step yet stays open here, under the card's why.
      if (pick && next.needs.some((need) => need.kind === 'blocked' && need.stepId === stepId)) {
        setNotYet(t('pin.notYet', { agent: agentName(pick.agentId, hostId) }))
        return
      }
      onDone()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const entryOf = (id: AgentId) => optionsOn(useAgentOptionsStore.getState(), hostId)[id]
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex min-w-0 items-center rounded-lg bg-(--thread-chip)">
          <AgentMenu
            only={runsSteps}
            agentId={agentId}
            values={values}
            hostId={hostId}
            onChoose={(id, model) => {
              setAgentId(id)
              setError(null)
              setNotYet(null)
              const entry = entryOf(id)
              const next = { ...(picksOf(useAgentOptionsStore.getState(), hostId, id) ?? {}) }
              const option = modelOption(entry)
              if (option) {
                if (model === null) delete next[option.id]
                else next[option.id] = model
              }
              setValues(entry ? startValues(entry, next) : next)
            }}
            onValues={(optionId, value) =>
              setValues((current) => ({ ...current, [optionId]: value }))
            }
          />
        </span>
        <span className="flex-1" />
        {pinned && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void send(null)}>
            {t('pin.auto')}
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onDone}>
          {t('common:actions.cancel')}
        </Button>
        <Button
          size="sm"
          disabled={busy || agentId === null}
          onClick={() => agentId && void send(pickOf(entryOf(agentId), agentId, values))}
        >
          {t('pin.confirm')}
        </Button>
      </div>
      {notYet && (
        <p role="status" className="text-hint text-warning">
          {notYet}
        </p>
      )}
      {error && (
        <p role="alert" className="text-hint text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
