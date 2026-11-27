import { parsePlainVersion } from '../agent-updates'
import type { AgentDefinition } from '../catalog'

export const GROK: AgentDefinition = {
  id: 'grok',
  name: 'Grok',
  registryId: 'grok-build',
  reportsAccount: true,
  launch: {
    kind: 'package',
    package: '@xai-official/grok',
    command: 'grok',
    args: ['agent', 'stdio'],
    // Its install script's folder.
    installedAt: ['.grok/bin/grok'],
  },
  requiresNode: '>=20',
  install: {
    hint: 'detect.hint.node',
    url: 'https://nodejs.org/en/download',
    guide: 'https://docs.x.ai/build/overview',
  },
  // The one route its docs list, checked on 2026-11-21. The script links `~/.grok/bin/grok` to a
  // download beside it.
  installs: {
    script: 'https://x.ai/cli/install.sh',
    scriptBin: ['.grok', 'bin'],
    scriptHome: ['.grok'],
    // The same stable version endpoints the official install.sh probes.
    versionCheck: {
      urls: () => [
        'https://x.ai/cli/stable',
        'https://storage.googleapis.com/grok-build-public-artifacts/cli/stable',
      ],
      parse: parsePlainVersion,
    },
  },
}
