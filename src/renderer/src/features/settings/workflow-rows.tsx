// The rows of Settings › Agents › workflow.

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentId } from '@shared/thread'
import { WORKING_STEP_LIMITS, type WorkingStepLimit } from '@shared/workflow'
import { AgentTile } from '@renderer/components/agents/agent-mark'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { errorMessage } from '@renderer/lib/host'
import { useHostScope } from '@renderer/stores/host-scope'
import { workflowsKey, useHostWorkflows, useWorkflowsStore } from '@renderer/stores/workflows'
import { ControlError, SetButton, SettingSelect, SettingSwitch } from './controls'
import { ItemLine, RowLine, RowText, Thing } from './rows'
import { useApply } from './use-apply'
import { changedAgents, changeWorkflowSettings } from './workflow-data'

const STEP_LIMITS = WORKING_STEP_LIMITS.map((n) => ({ value: String(n), label: String(n) }))

/** How many step sessions work at once across the host's tasks. */
export function StepLimitSelect({ label }: { label: string }) {
  const { useSettingsStore } = useHostScope()
  const limit = useSettingsStore((s) => s.settings.workflow.maxWorkingSteps)
  const [apply, error] = useApply()
  return (
    <>
      <ControlError error={error} />
      <SettingSelect
        label={label}
        value={String(limit)}
        options={STEP_LIMITS}
        onChange={(value) =>
          apply({ workflow: { maxWorkingSteps: Number(value) as WorkingStepLimit } })
        }
      />
    </>
  )
}

/** Agents can suggest a workflow: read again each time the page shows, as agents come and go. */
export function SuggestSwitch() {
  const { t } = useTranslation('settings')
  const scope = useHostScope()
  const { hostId } = scope
  const suggest = useWorkflowsStore(
    (s) => s.byHost[workflowsKey(hostId)]?.settings?.suggest ?? null,
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void useWorkflowsStore.getState().load(hostId)
  }, [hostId])
  if (suggest === null) return <Skeleton className="h-5 w-9 rounded-md" />
  return (
    <>
      <ControlError error={error} />
      <SettingSwitch
        label={t('agents.workflow.suggest.name')}
        checked={suggest}
        disabled={busy}
        onChange={(next) => {
          setBusy(true)
          setError(null)
          changeWorkflowSettings(scope, { suggest: next })
            .catch((failure: unknown) => setError(errorMessage(failure)))
            .finally(() => setBusy(false))
        }}
      />
    </>
  )
}

export function AutoPickRow({
  agentId,
  name,
  account,
  allowed,
  byDefault,
}: {
  agentId: AgentId
  name: string
  account: { label: string; email?: string | null } | null
  allowed: boolean
  byDefault: boolean
}) {
  const { t } = useTranslation('settings')
  const scope = useHostScope()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const line = [
    account?.label.trim() || null,
    account?.email?.trim() || null,
    byDefault ? null : t('agents.workflow.auto.offByDefault'),
  ].filter(Boolean)
  return (
    <div className="ui-sg-row">
      <Thing
        mark={<AgentTile agent={agentId} size={24} />}
        name={<span className="k-name">{name}</span>}
      >
        {line.length > 0 && <ItemLine>{line.join(' · ')}</ItemLine>}
      </Thing>
      <span className="ui-sg-control">
        <ControlError error={error} />
        <SettingSwitch
          label={t('agents.workflow.auto.switch', { agent: name })}
          checked={allowed}
          disabled={busy}
          onChange={(next) => {
            setBusy(true)
            setError(null)
            changeWorkflowSettings(scope, { autoPick: { [agentId]: next } })
              .catch((failure: unknown) => setError(errorMessage(failure)))
              .finally(() => setBusy(false))
          }}
        />
      </span>
    </div>
  )
}

/** Back to the default for every agent: subscriptions on, API keys off. */
export function ResetAuto() {
  const { t } = useTranslation('settings')
  const scope = useHostScope()
  const settings = useHostWorkflows(scope.hostId).settings
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reset = () => {
    const autoPick = Object.fromEntries(changedAgents(settings).map((id) => [id, null]))
    setBusy(true)
    setError(null)
    changeWorkflowSettings(scope, { autoPick })
      .catch((failure: unknown) => setError(errorMessage(failure)))
      .finally(() => setBusy(false))
  }
  return (
    <>
      <ControlError error={error} />
      <SetButton size="sm" variant="ghost" loading={busy} onClick={reset}>
        {t('agents.workflow.auto.reset')}
      </SetButton>
    </>
  )
}

export function AgentsLoading() {
  return (
    <div className="ui-sg-row" aria-hidden>
      <Skeleton className="h-6 w-48 rounded-md" />
      <Skeleton className="h-5 w-9 rounded-md" />
    </div>
  )
}

export function ReadFailed({ error }: { error: string }) {
  const { t } = useTranslation(['settings', 'common'])
  const { hostId } = useHostScope()
  const [busy, setBusy] = useState(false)
  return (
    <RowLine
      text={
        <RowText
          name={t('agents.workflow.auto.readFailed')}
          description={<span className="k-error">{error}</span>}
        />
      }
    >
      <SetButton
        loading={busy}
        onClick={() => {
          setBusy(true)
          void useWorkflowsStore
            .getState()
            .load(hostId)
            .finally(() => setBusy(false))
        }}
      >
        {t('common:actions.retry')}
      </SetButton>
    </RowLine>
  )
}
