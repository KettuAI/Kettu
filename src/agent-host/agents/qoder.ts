import type { AgentDefinition } from '../catalog'

export const QODER: AgentDefinition = {
  id: 'qoder',
  name: 'Qoder CLI',
  registryId: 'qoder',
  reportsAccount: true,
  launch: {
    kind: 'package',
    package: '@qoder-ai/qodercli',
    command: 'qodercli',
    args: ['--acp'],
  },
  // The package declares Node.js 20 or later, unlike the registry entry, which names none.
  requiresNode: '>=20',
  install: {
    hint: 'detect.hint.node',
    url: 'https://nodejs.org/en/download',
    guide: 'https://docs.qoder.com/cli/installation',
  },
  // Its script installs a native build and leaves the command and folder to the program, so only npm
  // is listed.
  installs: { npm: '@qoder-ai/qodercli' },
}
