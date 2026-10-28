import type { AgentDefinition } from '../catalog'

export const SIGIT: AgentDefinition = {
  id: 'sigit',
  name: 'siGit Code',
  registryId: 'sigit',
  launch: { kind: 'package', package: '@smbcloud/sigit', version: '1.7.5' },
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}
