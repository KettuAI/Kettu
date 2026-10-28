import type { AgentDefinition } from '../catalog'

export const COPILOT: AgentDefinition = {
  id: 'copilot',
  name: 'GitHub Copilot',
  registryId: 'github-copilot-cli',
  launch: { kind: 'package', package: '@github/copilot', version: '1.0.105', args: ['--acp'] },
  requiresNode: '>=22',
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}
