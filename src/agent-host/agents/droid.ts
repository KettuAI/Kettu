import type { AgentDefinition } from '../catalog'

export const DROID: AgentDefinition = {
  id: 'droid',
  name: 'Factory Droid',
  registryId: 'factory-droid',
  launch: {
    kind: 'package',
    package: 'droid',
    command: 'droid',
    args: ['exec', '--output-format', 'acp-daemon'],
    // The agent would update its own package behind the pin Kettu records.
    env: { DROID_DISABLE_AUTO_UPDATE: 'true', FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false' },
    // Its install script's folder, which it asks the user to add to PATH by hand.
    installedAt: ['.local/bin/droid'],
  },
  requiresNode: '>=22',
  // With URL elicitation declared, it sends its pairing page rather than opening a browser (0.251.0).
  pageSignIns: ['device-pairing'],
  install: {
    hint: 'detect.hint.node',
    url: 'https://nodejs.org/en/download',
    guide: 'https://docs.factory.com/droid-cli/quickstart',
  },
  // The routes its quickstart lists, checked on 2026-11-21.
  installs: {
    brewCask: 'droid',
    script: 'https://app.factory.ai/cli',
    scriptShell: 'sh',
    scriptBin: ['.local', 'bin'],
    scriptHome: ['.local', 'bin'],
    npm: 'droid',
  },
}
