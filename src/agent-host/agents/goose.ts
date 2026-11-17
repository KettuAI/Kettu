import type { AgentDefinition } from '../catalog'

export const GOOSE: AgentDefinition = {
  id: 'goose',
  limitsReason: 'model-provider-managed',
  name: 'goose',
  registryId: 'goose',
  launch: { kind: 'binary', command: 'goose', args: ['acp'] },
  install: {
    hint: 'detect.hint.goose',
    url: 'https://block.github.io/goose/',
  },
  installs: {
    archive: {},
  },
}
