import type { AgentDefinition } from '../catalog'

export const AUTOHAND: AgentDefinition = {
  id: 'autohand',
  limitsReason: 'not-yet-supported',
  name: 'Autohand Code',
  registryId: 'autohand',
  // The registry lists Autohand Code as its own program, not this adapter.
  launch: { kind: 'package', package: '@autohandai/autohand-acp', fromVendor: true },
  requiresNode: '>=18.17',
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}
