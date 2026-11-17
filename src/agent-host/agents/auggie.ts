import type { AgentDefinition } from '../catalog'

export const AUGGIE: AgentDefinition = {
  id: 'auggie',
  name: 'Auggie CLI',
  registryId: 'auggie',
  reportsAccount: true,
  launch: {
    kind: 'package',
    package: '@augmentcode/auggie',
    args: ['--acp'],
    // npm owns the installed version, so the CLI's own updater stays off.
    env: { AUGMENT_DISABLE_AUTO_UPDATE: '1' },
  },
  requiresNode: '>=20',
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}
