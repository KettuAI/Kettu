import { useEffect, useState, type ReactNode } from 'react'
import { ArrowDown01Icon, ArrowUp01Icon, Delete02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { type TaskTier, type TierCandidate, type TierSettings } from '@shared/tasks'
import type { AgentId } from '@shared/thread'
import { Button } from '@renderer/components/ui/button'
import { optionValues, routineOptions } from '@renderer/features/routines/model'
import { AgentMenu } from '@renderer/features/session/new-session/agent-menu'
import { ControlError, SetButton, Skel } from '@renderer/features/settings/controls'
import { BlockLine } from '@renderer/features/settings/rows'
import { Glyph } from '@renderer/features/shell/glyph'
import { errorMessage } from '@renderer/lib/host'
import { optionsOn, picksOf, useAgentOptionsStore } from '@renderer/stores/agent-options'
import { agentName, agentsOn, usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { useHostScope } from '@renderer/stores/host-scope'
import { hostKey, useTasksStore } from '@renderer/stores/tasks'
import { runsStages } from './model'
import './tasks.css'

/** One tier's candidates, each an agent and its model, with Add agent under them. */
export function TierList({ tier, text }: { tier: TaskTier; text: ReactNode }) {
  const { t } = useTranslation('tasks')
  const { hostId } = useHostScope()
  const key = hostKey(hostId)
  const state = useTasksStore((s) => s.tiers[key])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const stageAgents = useAgentsStore((s) => {
    const { order, byId } = agentsOn(s, hostId)
    return usableAgents(order, byId)
      .filter((agent) => !agent.disabled && runsStages(agent.id))
      .map((agent) => agent.id)
      .join('\n')
  })

  // The three rows mount together; the first starts the read and the others see it loading.
  useEffect(() => {
    const shown = useTasksStore.getState().tiers[key]
    if (!shown?.value && !shown?.loading) void useTasksStore.getState().loadTiers(hostId)
  }, [key, hostId])

  const settings = state?.value ?? null
  const list = settings?.[tier] ?? []

  const save = (next: TierCandidate[]) => {
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

  const candidateFor = (agentId: AgentId, model: string | null, seed: TierCandidate | null) => {
    const store = useAgentOptionsStore.getState()
    const entry = optionsOn(store, hostId)[agentId]
    const values =
      seed && seed.agentId === agentId
        ? optionValues(seed.options)
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

  const add = () => {
    const ids = stageAgents ? (stageAgents.split('\n') as AgentId[]) : []
    const agentId = ids.find((id) => !list.some((c) => c.agentId === id)) ?? ids[0]
    if (!agentId) return
    save([...list, candidateFor(agentId, null, null)])
  }

  const move = (from: number, to: number) => {
    const next = [...list]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item!)
    save(next)
  }

  return (
    <>
      <BlockLine text={text}>
        <ControlError
          error={error ?? (state?.error ? t('settings.loadFailed', { error: state.error }) : null)}
        />
        <SetButton disabled={!settings || busy || !stageAgents} onClick={add}>
          {t('settings.add')}
        </SetButton>
      </BlockLine>
      {!settings && state?.loading && <Skel width={220} />}
      {settings && !stageAgents && <p className="k-muted">{t('settings.noStageAgent')}</p>}
      {settings && list.length === 0 && stageAgents && (
        <p className="k-muted">{t('settings.empty')}</p>
      )}
      {list.length > 0 && (
        <ol className="k-inset k-list">
          {list.map((candidate, i) => {
            const name = agentName(candidate.agentId, hostId)
            return (
              <li key={`${candidate.agentId}:${i}`} className="k-list__row">
                <span className="k-num k-muted w-4 shrink-0">{i + 1}</span>
                <span className="k-tier-frame">
                  <AgentMenu
                    agentId={candidate.agentId}
                    hostId={hostId}
                    values={optionValues(candidate.options)}
                    onChoose={(agentId, model) => {
                      if (!runsStages(agentId)) {
                        setError(t('settings.onlyStageAgents'))
                        return
                      }
                      const next = [...list]
                      next[i] = candidateFor(agentId, model, candidate)
                      save(next)
                    }}
                    onValues={(optionId, value) => {
                      const entry = optionsOn(useAgentOptionsStore.getState(), hostId)[
                        candidate.agentId
                      ]
                      if (!entry) return
                      const next = [...list]
                      next[i] = {
                        agentId: candidate.agentId,
                        options: routineOptions(entry, {
                          ...optionValues(candidate.options),
                          [optionId]: value,
                        }),
                      }
                      save(next)
                    }}
                  />
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('settings.moveUp', { agent: name })}
                  title={t('settings.moveUp', { agent: name })}
                  disabled={busy || i === 0}
                  onClick={() => move(i, i - 1)}
                >
                  <Glyph icon={ArrowUp01Icon} size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('settings.moveDown', { agent: name })}
                  title={t('settings.moveDown', { agent: name })}
                  disabled={busy || i === list.length - 1}
                  onClick={() => move(i, i + 1)}
                >
                  <Glyph icon={ArrowDown01Icon} size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('settings.remove', { agent: name })}
                  title={t('settings.remove', { agent: name })}
                  disabled={busy}
                  onClick={() => save(list.filter((_, at) => at !== i))}
                >
                  <Glyph icon={Delete02Icon} size={14} />
                </Button>
              </li>
            )
          })}
        </ol>
      )}
    </>
  )
}
