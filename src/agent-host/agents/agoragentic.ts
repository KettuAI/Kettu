import type { AgentDefinition } from '../catalog'

export const AGORAGENTIC: AgentDefinition = {
  id: 'agoragentic',
  limitsReason: 'not-yet-supported',
  name: 'Agoragentic',
  registryId: 'agoragentic-acp',
  launch: {
    kind: 'package',
    package: 'agoragentic-mcp',
    args: ['--acp'],
  },
  requiresNode: '>=18',
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}
