import type { AgentDefinition } from '../catalog'

export const MINIMAX: AgentDefinition = {
  id: 'minimax',
  name: 'MiniMax Code',
  registryId: 'minimax-code',
  launch: { kind: 'package', package: '@minimax-ai/code', version: '0.2.7', args: ['acp'] },
  // The package allows 22.19 up to 22.x or 24 up to 26; detection reads the lower bound.
  requiresNode: '>=22.19',
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}
