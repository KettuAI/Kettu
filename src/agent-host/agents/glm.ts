import type { AgentDefinition } from '../catalog'

export const GLM: AgentDefinition = {
  id: 'glm',
  limitsReason: 'not-yet-supported',
  name: 'GLM Agent',
  registryId: 'glm-acp-agent',
  launch: { kind: 'package', package: 'glm-acp-agent' },
  // The package allows ^20.19, ^22.13 or >=24; detection reads one minimum.
  requiresNode: '>=20.19',
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}
