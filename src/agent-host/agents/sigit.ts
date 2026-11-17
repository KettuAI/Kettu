import type { AgentDefinition } from '../catalog'

export const SIGIT: AgentDefinition = {
  id: 'sigit',
  limitsReason: 'model-provider-managed',
  name: 'siGit Code',
  registryId: 'sigit',
  launch: { kind: 'package', package: '@smbcloud/sigit' },
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}
