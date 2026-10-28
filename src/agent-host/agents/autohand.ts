import type { AgentDefinition } from '../catalog'

export const AUTOHAND: AgentDefinition = {
  id: 'autohand',
  name: 'Autohand Code',
  registryId: 'autohand',
  launch: { kind: 'package', package: '@autohandai/autohand-acp', version: '0.2.1' },
  requiresNode: '>=18.17',
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}
