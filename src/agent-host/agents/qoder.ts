import type { AgentDefinition } from '../catalog'

export const QODER: AgentDefinition = {
  id: 'qoder',
  name: 'Qoder CLI',
  registryId: 'qoder',
  launch: {
    kind: 'package',
    package: '@qoder-ai/qodercli',
    version: '0.2.14',
    args: ['--acp'],
  },
  // The package declares Node.js 20 or later, unlike the registry entry, which names none.
  requiresNode: '>=20',
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}
