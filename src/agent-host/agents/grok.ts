import type { AgentDefinition } from '../catalog'

export const GROK: AgentDefinition = {
  id: 'grok',
  name: 'Grok',
  registryId: 'grok-build',
  launch: {
    kind: 'package',
    package: '@xai-official/grok',
    version: '1.0.72',
    args: ['agent', 'stdio'],
  },
  requiresNode: '>=20',
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}
