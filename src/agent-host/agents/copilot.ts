import type { AgentDefinition } from '../catalog'

export const COPILOT: AgentDefinition = {
  id: 'copilot',
  name: 'GitHub Copilot',
  registryId: 'github-copilot-cli',
  reportsAccount: true,
  launch: { kind: 'package', package: '@github/copilot', args: ['--acp'] },
  requiresNode: '>=22',
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}
