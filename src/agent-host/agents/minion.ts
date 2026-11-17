import type { AgentDefinition } from '../catalog'

export const MINION: AgentDefinition = {
  id: 'minion',
  limitsReason: 'model-provider-managed',
  name: 'Minion Code',
  registryId: 'minion-code',
  // The registry lists 0.1.44, which imports AuthMethod, gone from agent-client-protocol 0.9.0.
  launch: { kind: 'uvx', package: 'minion-code', args: ['acp'], minimum: '0.1.45' },
  install: { hint: 'detect.hint.uv', url: 'https://docs.astral.sh/uv/' },
}
