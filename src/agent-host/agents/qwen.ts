import type { AgentDefinition } from '../catalog'

export const QWEN: AgentDefinition = {
  id: 'qwen',
  name: 'Qwen Code',
  registryId: 'qwen-code',
  launch: { kind: 'package', package: '@qwen-code/qwen-code', version: '0.26.2', args: ['--acp'] },
  requiresNode: '>=22',
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}
