import type { AgentDefinition } from '../catalog'

export const CLINE: AgentDefinition = {
  id: 'cline',
  name: 'Cline',
  registryId: 'cline',
  launch: { kind: 'package', package: 'cline', version: '3.0.74', args: ['--acp'] },
  requiresNode: '>=22',
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}
