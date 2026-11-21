import type { AgentDefinition } from '../catalog'

export const KIMI: AgentDefinition = {
  id: 'kimi',
  name: 'Kimi Code',
  registryId: 'kimi-code',
  launch: {
    kind: 'package',
    package: '@moonshot-ai/kimi-code',
    command: 'kimi',
    args: ['acp'],
    // Its install script's folder, which it adds to PATH in the shell profiles only.
    installedAt: ['.kimi-code/bin/kimi'],
  },
  requiresNode: '>=22.19.0',
  install: {
    hint: 'detect.hint.kimi',
    url: 'https://github.com/MoonshotAI/kimi-code',
    guide: 'https://moonshotai.github.io/kimi-code/en/guides/getting-started',
  },
  installs: { npm: '@moonshot-ai/kimi-code' },
}
