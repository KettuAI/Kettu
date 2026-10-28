import type { AgentDefinition } from '../catalog'

export const GEMINI: AgentDefinition = {
  id: 'gemini',
  name: 'Gemini CLI',
  registryId: 'gemini',
  launch: { kind: 'package', package: '@google/gemini-cli', version: '0.66.0', args: ['--acp'] },
  requiresNode: '>=22',
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}
