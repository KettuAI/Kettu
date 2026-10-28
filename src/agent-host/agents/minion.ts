import type { AgentDefinition } from '../catalog'

export const MINION: AgentDefinition = {
  id: 'minion',
  name: 'Minion Code',
  registryId: 'minion-code',
  launch: { kind: 'uvx', package: 'minion-code', version: '0.1.45', args: ['acp'] },
  // The registry lists 0.1.44, which imports AuthMethod, gone from agent-client-protocol 0.9.0.
  install: { hint: 'detect.hint.uv', url: 'https://docs.astral.sh/uv/' },
}
