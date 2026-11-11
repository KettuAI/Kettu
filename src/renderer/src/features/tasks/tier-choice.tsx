import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { type TaskTier, type TierChoice, type TierSettings } from '@shared/tasks'
import type { AgentId } from '@shared/thread'
import { optionValues, routineOptions } from '@renderer/features/routines/model'
import { AgentMenu } from '@renderer/features/session/new-session/agent-menu'
import { ControlError, SetButton, Skel } from '@renderer/features/settings/controls'
import { BlockLine } from '@renderer/features/settings/rows'
import { errorMessage } from '@renderer/lib/host'
import { optionsOn, picksOf, useAgentOptionsStore } from '@renderer/stores/agent-options'
import { useHostScope } from '@renderer/stores/host-scope'
import { hostKey, useTasksStore } from '@renderer/stores/tasks'
import { runsNodes } from './model'
import { useAgentLine } from './use-model-name'
import './tasks.css'

/**
 * The agent and model one tier stands for: the person's choice, or Automatic, which names the
 * agent the host picks.
 */
export function TierChoiceRow({ tier, text }: { tier: TaskTier; text: ReactNode }) {
  const { t } = useTranslation('tasks')
  const { hostId } = useHostScope()
  const key = hostKey(hostId)
  const state = useTasksStore((s) => s.tiers[key])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // The three rows mount together; the first starts the read and the others see it loading.
  useEffect(() => {
    if (!useTasksStore.getState().tiers[key]?.loading) {
      void useTasksStore.getState().loadTiers(hostId)
    }
  }, [key, hostId])

  const settings = state?.value?.settings ?? null
  const choice = settings?.[tier] ?? null
  const pick = state?.value?.agents[tier] ?? null
  const picked = useAgentLine(pick?.agentId ?? null, pick?.model ?? null, hostId)

  const save = (next: TierChoice | null) => {
    if (!settings) return
    setBusy(true)
    setError(null)
    const tiers: TierSettings = { ...settings, [tier]: next }
    useTasksStore
      .getState()
      .saveTiers(hostId, tiers)
      .catch((failure: unknown) => setError(errorMessage(failure)))
      .finally(() => setBusy(false))
  }

  const choiceFor = (agentId: AgentId, model: string | null): TierChoice => {
    const store = useAgentOptionsStore.getState()
    const entry = optionsOn(store, hostId)[agentId]
    const values =
      choice && choice.agentId === agentId
        ? optionValues(choice.options)
        : { ...(picksOf(store, hostId, agentId) ?? {}) }
    const modelOption = entry?.config.find((option) => option.category === 'model')
    if (modelOption && model !== null) values[modelOption.id] = model
    return {
      agentId,
      options: entry
        ? routineOptions(entry, values)
        : Object.entries(values).map(([id, value]) => ({ id, value })),
    }
  }

  return (
    <>
      <BlockLine text={text}>
        <ControlError
          error={error ?? (state?.error ? t('settings.loadFailed', { error: state.error }) : null)}
        />
        {choice && (
          <SetButton variant="ghost" disabled={busy} onClick={() => save(null)}>
            {t('settings.useAutomatic')}
          </SetButton>
        )}
      </BlockLine>
      {!settings && state?.loading && <Skel width={220} />}
      {settings && (
        <div className="flex items-center gap-3">
          <span className="k-tier-frame">
            <AgentMenu
              agentId={choice?.agentId ?? null}
              hostId={hostId}
              values={choice ? optionValues(choice.options) : {}}
              onChoose={(agentId, model) => {
                if (!runsNodes(agentId)) {
                  setError(t('settings.onlyNodeAgents'))
                  return
                }
                save(choiceFor(agentId, model))
              }}
              onValues={(optionId, value) => {
                if (!choice) return
                const entry = optionsOn(useAgentOptionsStore.getState(), hostId)[choice.agentId]
                if (!entry) return
                save({
                  agentId: choice.agentId,
                  options: routineOptions(entry, {
                    ...optionValues(choice.options),
                    [optionId]: value,
                  }),
                })
              }}
            />
          </span>
          {!choice && (
            <span className="k-muted shrink-0">
              {picked
                ? t('settings.automaticPick', { agent: picked })
                : t('settings.automaticNone')}
            </span>
          )}
        </div>
      )}
    </>
  )
}
