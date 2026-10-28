import type { AgentDefinition } from '../catalog'

export const BOB: AgentDefinition = {
  id: 'bob',
  name: 'Bob',
  registryId: 'bob',
  launch: { kind: 'package', package: '@ibm/bob', version: '2.0.9', args: ['acp'] },
  requiresNode: '>=22',
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}
