import type { AgentDefinition } from '../catalog'

export const NOVA: AgentDefinition = {
  id: 'nova',
  limitsReason: 'not-yet-supported',
  name: 'Nova',
  registryId: 'nova',
  launch: { kind: 'package', package: '@compass-ai/nova', command: 'nova', args: ['acp'] },
  requiresNode: '>=22.13',
  install: {
    hint: 'detect.hint.node',
    url: 'https://nodejs.org/en/download',
    guide: 'https://www.npmjs.com/package/@compass-ai/nova',
  },
  installs: { npm: '@compass-ai/nova' },
}
