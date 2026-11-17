import type { AgentDefinition } from '../catalog'

export const DEVIN: AgentDefinition = {
  id: 'devin',
  name: 'Devin',
  registryId: 'devin',
  launch: { kind: 'binary', command: 'devin', args: ['acp'] },
  install: {
    hint: 'detect.hint.archive',
    url: 'https://docs.devin.ai/cli',
  },
  installs: {
    archive: {},
  },
}
