import type { AgentDefinition } from '../catalog'

export const KIMCHI: AgentDefinition = {
  id: 'kimchi',
  limitsReason: 'not-yet-supported',
  name: 'Kimchi',
  registryId: 'kimchi',
  launch: { kind: 'binary', command: 'kimchi', args: ['--mode', 'acp'] },
  install: {
    hint: 'detect.hint.kimchi',
    url: 'https://kimchi.dev',
  },
  // The binary loads the share/kimchi tree beside it, so the whole archive is extracted.
  installs: {
    archive: {},
  },
}
