import type { AgentDefinition } from '../catalog'

export const GEMINI: AgentDefinition = {
  id: 'gemini',
  limitsReason: 'Google does not allow other apps to read this plan usage.',
  name: 'Gemini CLI',
  registryId: 'gemini',
  launch: { kind: 'package', package: '@google/gemini-cli', version: '0.66.0', args: ['--acp'] },
  requiresNode: '>=22',
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}
