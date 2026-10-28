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
}
