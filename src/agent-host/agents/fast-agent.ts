import type { AgentDefinition } from '../catalog'

export const FAST_AGENT: AgentDefinition = {
  id: 'fast-agent',
  name: 'fast-agent',
  registryId: 'fast-agent',
  launch: { kind: 'uvx', package: 'fast-agent-acp', version: '0.10.1', args: ['-x'] },
  // The registry starts it with this model; the variable stays in its own environment.
  env: { FAST_AGENT_MODEL: 'codexplan' },
  install: { hint: 'detect.hint.uv', url: 'https://docs.astral.sh/uv/' },
}
