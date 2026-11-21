// The host's agents as the task engine sees them: what each lists and gets, read from their
// statuses, the options their last sessions offered, the catalog's model notes and the
// Marketplace; and the option values a pick starts a session with.

import type { AgentOptions, AgentStatus } from '@shared/agent-host'
import type { MarketServer, MarketSkill } from '@shared/marketplace'
import { limitsForModel } from '@shared/plan-limits'
import type { StepPick } from '@shared/workflow'
import type { AgentId, ConfigOption } from '@shared/thread'
import { modelNoteOf, type AgentDefinition } from '../catalog'
import type { WorkflowAgent, WorkflowModel } from './picks'

function modelOption(options: AgentOptions | null): ConfigOption | undefined {
  return options?.config.find((o) => o.category === 'model' && o.type === 'select')
}

function levelOption(options: AgentOptions | null, model: string | null): ConfigOption | undefined {
  const own = model === null ? undefined : options?.levels[model]
  return own ?? options?.config.find((o) => o.category === 'thought_level' && o.type === 'select')
}

function choicesOf(option: ConfigOption | undefined): string[] | null {
  const values = option?.choices?.map((choice) => choice.value) ?? []
  return values.length > 0 ? values : null
}

export interface WorkflowAgentSources {
  statuses: readonly AgentStatus[]
  options(agentId: AgentId): AgentOptions | null
  catalog: readonly AgentDefinition[]
  marketplace: { mcp: readonly MarketServer[]; skills: readonly MarketSkill[] }
}

export function workflowAgents(sources: WorkflowAgentSources): WorkflowAgent[] {
  return sources.statuses
    .filter((status) => status.registered !== false)
    .map((status) => {
      const options = sources.options(status.id)
      const model = modelOption(options)
      const notes = sources.catalog.find((def) => def.id === status.harnessId)?.modelNotes
      const models: WorkflowModel[] | null = model?.choices?.length
        ? model.choices.map((choice) => ({
            value: choice.value,
            name: choice.name,
            ...(choice.modelId ? { modelId: choice.modelId } : {}),
            note: modelNoteOf(notes, choice),
            efforts: choicesOf(options?.levels[choice.value]),
          }))
        : null
      const apiKey = status.account?.kind === 'api_key' || status.apiKey?.set === true
      return {
        id: status.id,
        name: status.name,
        harness: status.harnessId,
        disabled: status.disabled === true,
        missing: status.uninstalled === true || status.state === 'not-installed',
        account: status.account
          ? {
              kind: status.account.kind,
              label: status.account.label,
              ...(status.account.tier ? { tier: status.account.tier } : {}),
            }
          : null,
        apiKey,
        kettu: status.kettuServer?.runs !== false,
        models,
        efforts: choicesOf(levelOption(options, null)),
        limits: (value: string | null) =>
          value === null || !model
            ? [...status.limits]
            : limitsForModel(status.limits, { ...model, value }),
        // A step names a tool by its name or its Marketplace entry's id.
        skills: new Set(
          sources.marketplace.skills.filter((s) => s.on).flatMap((s) => [s.name, s.id]),
        ),
        mcp: new Set(sources.marketplace.mcp.filter((s) => s.on).flatMap((s) => [s.name, s.id])),
      }
    })
}

/** The option values that start the agent with the pick's model and effort. */
export function optionsOfPick(
  options: AgentOptions | null,
  pick: StepPick,
): Record<string, string> {
  const out: Record<string, string> = {}
  const model = modelOption(options)
  if (model && pick.model !== null) out[model.id] = pick.model
  const level = levelOption(options, pick.model)
  if (level && pick.effort !== null) out[level.id] = pick.effort
  return out
}

/** The pick New session's tray stands for: its model and effort values, or the agent's own. */
export function pickOfOptions(
  options: AgentOptions | null,
  agentId: AgentId,
  values: Record<string, string | boolean>,
): StepPick {
  const model = modelOption(options)
  const chosen = model ? values[model.id] : undefined
  const modelValue =
    typeof chosen === 'string' ? chosen : typeof model?.value === 'string' ? model.value : null
  const level = levelOption(options, modelValue)
  const effort = level ? values[level.id] : undefined
  return {
    agentId,
    model: modelValue,
    effort:
      typeof effort === 'string' ? effort : typeof level?.value === 'string' ? level.value : null,
  }
}
