import type { AgentId } from '@shared/thread'
import { optionsOn, useAgentOptionsStore } from '@renderer/stores/agent-options'
import { agentName } from '@renderer/stores/agents'

/** A model by the name its agent's menu shows it under, when known. */
export function useModelName(
  agentId: AgentId | null,
  model: string | null,
  hostId: string | null,
): string | null {
  const choices = useAgentOptionsStore((s) =>
    agentId
      ? optionsOn(s, hostId)[agentId]?.config.find((option) => option.category === 'model')?.choices
      : undefined,
  )
  if (!model) return null
  return choices?.find((choice) => choice.value === model)?.name ?? model
}

/** An agent and its model on one line, such as "Codex · GPT-5". */
export function useAgentLine(
  agentId: AgentId | null,
  model: string | null,
  hostId: string | null,
): string | null {
  const modelName = useModelName(agentId, model, hostId)
  if (!agentId) return null
  const agent = agentName(agentId, hostId)
  return modelName ? `${agent} · ${modelName}` : agent
}
