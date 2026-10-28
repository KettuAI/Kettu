import type { AgentDefinition } from '../catalog'

export const DROID: AgentDefinition = {
  id: 'droid',
  name: 'Factory Droid',
  registryId: 'factory-droid',
  launch: {
    kind: 'package',
    package: 'droid',
    version: '0.251.0',
    args: ['exec', '--output-format', 'acp-daemon'],
    // The agent would update its own package behind the pin OverBench records.
    env: { DROID_DISABLE_AUTO_UPDATE: 'true', FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false' },
  },
  requiresNode: '>=22',
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}
