import type { AgentDefinition } from '../catalog'

export const DIRAC: AgentDefinition = {
  id: 'dirac',
  limitsReason: 'model-provider-managed',
  name: 'Dirac',
  registryId: 'dirac',
  launch: { kind: 'package', package: 'dirac-cli', args: ['--acp'] },
  // The package allows Node 22.13 up to 25; detection reads the lower bound.
  requiresNode: '>=22.13',
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}
