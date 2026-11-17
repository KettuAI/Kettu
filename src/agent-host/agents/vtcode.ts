import type { AgentDefinition } from '../catalog'

export const VTCODE: AgentDefinition = {
  id: 'vtcode',
  limitsReason: 'model-provider-managed',
  name: 'VT Code',
  registryId: 'vtcode',
  launch: { kind: 'binary', command: 'vtcode', args: ['acp'] },
  // The ACP bridge is off by default, so the launch turns it on with the variable the registry
  // gives.
  env: { VT_ACP_ENABLED: '1' },
  install: {
    hint: 'detect.hint.archive',
    url: 'https://github.com/vinhnx/VTCode',
  },
  installs: {
    archive: {},
  },
}
