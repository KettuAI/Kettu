import type { AgentDefinition } from '../catalog'

export const BOB: AgentDefinition = {
  id: 'bob',
  limitsReason: 'not-yet-supported',
  name: 'Bob',
  registryId: 'bob',
  launch: { kind: 'package', package: '@ibm/bob', command: 'bob', args: ['acp'] },
  requiresNode: '>=22',
  install: {
    hint: 'detect.hint.node',
    url: 'https://nodejs.org/en/download',
    guide: 'https://bob.ibm.com/docs/shell/getting-started/install-and-setup',
  },
  installs: { npm: '@ibm/bob' },
}
