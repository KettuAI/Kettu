import type { AgentDefinition } from '../catalog'

export const DIRAC: AgentDefinition = {
  id: 'dirac',
  name: 'Dirac',
  registryId: 'dirac',
  launch: { kind: 'package', package: 'dirac-cli', version: '0.5.24', args: ['--acp'] },
  // The package allows Node 22.13 up to 25; detection reads the lower bound.
  requiresNode: '>=22.13',
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}
