import type { AgentDefinition } from '../catalog'

export const POOLSIDE: AgentDefinition = {
  id: 'poolside',
  limitsReason: 'harness-does-not-offer',
  name: 'Poolside',
  registryId: 'poolside',
  launch: { kind: 'binary', command: 'pool', args: ['acp'] },
  install: {
    hint: 'detect.hint.archive',
    url: 'https://poolside.ai',
  },
  installs: {
    archive: {},
  },
}
