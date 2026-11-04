import type { AgentDefinition } from '../catalog'

export const CODEWHALE: AgentDefinition = {
  id: 'codewhale',
  name: 'CodeWhale',
  registryId: 'codewhale',
  launch: { kind: 'binary', command: 'codewhale', args: ['serve', '--acp'] },
  install: {
    hint: 'detect.hint.codewhale',
    url: 'https://codewhale.net',
  },
  // The routes its install page lists, checked on 2026-11-03.
  installs: {
    script: 'https://codewhale.net/install.sh',
    scriptShell: 'sh',
    scriptBin: ['.local', 'bin'],
    scriptHome: ['.local', 'bin'],
    winget: 'HunterBown.CodeWhale',
    npm: 'codewhale',
  },
}
