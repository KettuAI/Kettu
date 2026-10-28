import type { AgentDefinition } from '../catalog'

export const DEEPAGENTS: AgentDefinition = {
  id: 'deepagents',
  name: 'DeepAgents',
  registryId: 'deepagents',
  launch: { kind: 'package', package: 'deepagents-acp', version: '0.1.7' },
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}
