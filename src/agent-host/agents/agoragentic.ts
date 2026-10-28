import type { AgentDefinition } from '../catalog'

export const AGORAGENTIC: AgentDefinition = {
  id: 'agoragentic',
  name: 'Agoragentic',
  registryId: 'agoragentic-acp',
  launch: {
    kind: 'package',
    package: 'agoragentic-mcp',
    version: '1.3.0',
    args: ['--acp'],
  },
  requiresNode: '>=18',
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}
