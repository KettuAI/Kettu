import type { AgentDefinition } from '../catalog'

export const KILO: AgentDefinition = {
  id: 'kilo',
  name: 'Kilo Code',
  registryId: 'kilo',
  reportsAccount: true,
  launch: { kind: 'binary', command: 'kilo', args: ['acp'] },
  install: {
    hint: 'detect.hint.kilo',
    url: 'https://kilo.ai/docs/code-with-ai/platforms/cli',
  },
  // The archive needs no Node.js, so it comes first, then npm's global install.
  installs: {
    archive: {},
    npm: '@kilocode/cli',
  },
}
