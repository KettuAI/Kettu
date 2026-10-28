import type { AgentDefinition } from '../catalog'

export const MUSE: AgentDefinition = {
  id: 'muse',
  name: 'Muse Code',
  registryId: 'muse',
  // The ACP mode is a vendor preview behind this gate, which a release may remove.
  env: { MUSE_EXPERIMENTAL_ACP: 'on' },
  launch: { kind: 'binary', command: 'muse', args: ['acp'] },
  install: {
    hint: 'detect.hint.muse',
    url: 'https://dev.meta.ai',
  },
}
