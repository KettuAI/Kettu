import type { AgentDefinition } from '../catalog'

export const CROW_CLI: AgentDefinition = {
  id: 'crow-cli',
  limitsReason: 'model-provider-managed',
  name: 'crow-cli',
  registryId: 'crow-cli',
  launch: { kind: 'binary', command: 'crow-cli', args: ['acp'] },
  install: {
    hint: 'detect.hint.archive',
    url: 'https://github.com/crow-cli/crow-cli',
  },
  installs: {
    archive: {},
  },
}
