import type { AgentDefinition } from '../catalog'

export const DIMCODE: AgentDefinition = {
  id: 'dimcode',
  name: 'DimCode',
  registryId: 'dimcode',
  launch: { kind: 'package', package: 'dimcode', version: '0.5.22', args: ['acp'] },
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}
