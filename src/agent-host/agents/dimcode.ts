import type { AgentDefinition } from '../catalog'

export const DIMCODE: AgentDefinition = {
  id: 'dimcode',
  limitsReason: 'not-yet-supported',
  name: 'DimCode',
  registryId: 'dimcode',
  launch: { kind: 'package', package: 'dimcode', command: 'dimcode', args: ['acp'] },
  install: {
    hint: 'detect.hint.node',
    url: 'https://nodejs.org/en/download',
    guide: 'https://www.npmjs.com/package/dimcode',
  },
  // Its README lists only the `beta` tag, which an npm route cannot carry.
}
