import type { AgentDefinition } from '../catalog'

export const HARN: AgentDefinition = {
  id: 'harn',
  limitsReason: 'model-provider-managed',
  name: 'Harn',
  registryId: 'harn',
  launch: { kind: 'binary', command: 'harn', args: ['serve', 'acp'] },
  install: {
    hint: 'detect.hint.harn',
    url: 'https://harnlang.com',
  },
  installs: {
    archive: {},
  },
}
