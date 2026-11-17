import type { AgentDefinition } from '../catalog'

export const DROID: AgentDefinition = {
  id: 'droid',
  name: 'Factory Droid',
  registryId: 'factory-droid',
  launch: {
    kind: 'package',
    package: 'droid',
    args: ['exec', '--output-format', 'acp-daemon'],
    // The agent would update its own package behind the pin Kettu records.
    env: { DROID_DISABLE_AUTO_UPDATE: 'true', FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false' },
  },
  requiresNode: '>=22',
  // With URL elicitation declared, it sends its pairing page rather than opening a browser (0.251.0).
  pageSignIns: ['device-pairing'],
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}
