import type { AgentDefinition } from '../catalog'

export const MISTRAL_VIBE: AgentDefinition = {
  id: 'mistral-vibe',
  name: 'Mistral Vibe',
  registryId: 'mistral-vibe',
  reportsAccount: true,
  launch: { kind: 'binary', command: 'vibe-acp', args: [] },
  install: {
    hint: 'detect.hint.archive',
    url: 'https://github.com/mistralai/mistral-vibe',
  },
  installs: {
    archive: {},
  },
}
