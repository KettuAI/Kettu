import type { AgentDefinition } from '../catalog'

export const STAKPAK: AgentDefinition = {
  id: 'stakpak',
  limitsReason: 'not-yet-supported',
  name: 'Stakpak',
  registryId: 'stakpak',
  launch: { kind: 'binary', command: 'stakpak', args: ['acp'] },
  install: {
    hint: 'detect.hint.archive',
    url: 'https://stakpak.dev',
  },
  installs: {
    archive: {},
  },
}
