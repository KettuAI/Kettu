import type { AgentDefinition } from '../catalog'

export const QODER_CN: AgentDefinition = {
  id: 'qoder-cn',
  name: 'Qoder CN',
  // Not in the registry: the China edition is its own package with its own folder and sign-in.
  registryId: 'qoder-cn',
  reportsAccount: true,
  launch: {
    kind: 'package',
    package: '@qodercn-ai/qoderclicn',
    fromVendor: true,
    args: ['--acp'],
  },
  requiresNode: '>=20',
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}
