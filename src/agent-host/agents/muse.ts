import type { AgentDefinition } from '../catalog'

export const MUSE: AgentDefinition = {
  id: 'muse',
  limitsReason: 'harness-does-not-offer',
  name: 'Muse Code',
  registryId: 'muse',
  // The ACP mode is a vendor preview behind this gate, which a release may remove.
  env: { MUSE_EXPERIMENTAL_ACP: 'on' },
  launch: { kind: 'binary', command: 'muse', args: ['acp'] },
  install: {
    hint: 'detect.hint.muse',
    url: 'https://dev.meta.ai/docs',
  },
  // The vendor's own native builds, which the registry does not list; Kettu bundles their files.
  installs: {
    archive: { fromVendor: true },
  },
}
