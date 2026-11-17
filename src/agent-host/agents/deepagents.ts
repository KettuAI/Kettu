import type { AgentDefinition } from '../catalog'

export const DEEPAGENTS: AgentDefinition = {
  id: 'deepagents',
  limitsReason: 'model-provider-managed',
  name: 'DeepAgents',
  registryId: 'deepagents',
  launch: { kind: 'package', package: 'deepagents-acp' },
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}
