// Which agent and model the requests Kettu makes itself go to: session titles, branch names,
// outline titles, commit messages and problem report drafts, as the user's setting says.

import type { LightModel } from '@shared/settings'
import type { AgentId } from '@shared/thread'
import type { ModelPick } from './outline-titles'

export interface LightTarget {
  agentId: AgentId
  model: ModelPick
}

/**
 * Where a request for the task of `agentId` goes, its session using `model` (null without one):
 * that agent and its small model, that agent and that model, or the pinned agent and model
 * whatever the task's agent. Null when nothing is pinned and the task has no agent.
 */
export function lightTarget(
  setting: LightModel,
  agentId: AgentId,
  model: string | null,
): LightTarget
export function lightTarget(
  setting: LightModel,
  agentId: AgentId | null,
  model: string | null,
): LightTarget | null
export function lightTarget(
  setting: LightModel,
  agentId: AgentId | null,
  model: string | null,
): LightTarget | null {
  if (setting.mode === 'pinned') {
    return { agentId: setting.agentId, model: { small: false, model: setting.model, pinned: true } }
  }
  if (agentId === null) return null
  return { agentId, model: { small: setting.mode === 'small', model } }
}
