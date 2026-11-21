import type { AgentDefinition } from '../catalog'

export const FAST_AGENT: AgentDefinition = {
  id: 'fast-agent',
  limitsReason: 'model-provider-managed',
  name: 'fast-agent',
  registryId: 'fast-agent',
  launch: { kind: 'uvx', package: 'fast-agent-acp', args: ['-x'] },
  // Its dependency fastmcp-slim is pinned to a pre-release, which uv resolves from 0.12.0 on.
  requiresUv: '0.12.0',
  // The registry starts it with this model; the variable stays in its own environment.
  env: { FAST_AGENT_MODEL: 'codexplan' },
  install: { hint: 'detect.hint.uv', url: 'https://docs.astral.sh/uv/' },
}
