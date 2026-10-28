import type { AgentDefinition } from '../catalog'

export const GLM: AgentDefinition = {
  id: 'glm',
  name: 'GLM Agent',
  registryId: 'glm-acp-agent',
  launch: { kind: 'package', package: 'glm-acp-agent', version: '1.16.0' },
  // The package allows ^20.19, ^22.13 or >=24; detection reads one minimum.
  requiresNode: '>=20.19',
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}
