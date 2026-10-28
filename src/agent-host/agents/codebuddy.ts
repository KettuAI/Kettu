import type { AgentDefinition } from '../catalog'

export const CODEBUDDY: AgentDefinition = {
  id: 'codebuddy',
  name: 'Codebuddy Code',
  registryId: 'codebuddy-code',
  launch: {
    kind: 'package',
    package: '@tencent-ai/codebuddy-code',
    version: '2.177.1',
    args: ['--acp'],
  },
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}
