import type { AgentDefinition } from '../catalog'

export const JUNIE: AgentDefinition = {
  id: 'junie',
  name: 'Junie',
  registryId: 'junie',
  launch: { kind: 'binary', command: 'junie', args: ['--acp=true'] },
  install: {
    hint: 'detect.hint.archive',
    url: 'https://junie.jetbrains.com',
  },
  installs: {
    archive: {},
  },
}
