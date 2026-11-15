import type { AgentDefinition } from '../catalog'

export const KIMI: AgentDefinition = {
  id: 'kimi',
  name: 'Kimi Code',
  registryId: 'kimi-code',
  launch: { kind: 'package', package: '@moonshot-ai/kimi-code', version: '2.6.2', args: ['acp'] },
  requiresNode: '>=22.19.0',
  install: {
    hint: 'detect.hint.kimi',
    url: 'https://github.com/MoonshotAI/kimi-code',
  },
  installs: { npm: '@moonshot-ai/kimi-code' },
}
