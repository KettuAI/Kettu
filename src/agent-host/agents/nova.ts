import type { AgentDefinition } from '../catalog'

export const NOVA: AgentDefinition = {
  id: 'nova',
  name: 'Nova',
  registryId: 'nova',
  launch: { kind: 'package', package: '@compass-ai/nova', version: '1.1.60', args: ['acp'] },
  requiresNode: '>=22.13',
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}
