import type { AgentDefinition } from '../catalog'

export const GEMINI: AgentDefinition = {
  id: 'gemini',
  limitsReason: 'vendor-disallows',
  name: 'Gemini CLI',
  registryId: 'gemini',
  launch: { kind: 'package', package: '@google/gemini-cli', args: ['--acp'] },
  requiresNode: '>=22',
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
  // Since 2026-06-18 Google serves personal accounts in Antigravity; Gemini CLI 0.66.0 passes on
  // the Code Assist server's refusal of them.
  movedAccounts: {
    refusal: /no longer supported for Gemini Code Assist for individuals/i,
    to: 'antigravity',
    audience: 'detect.geminiAudience',
    refused: 'agent.geminiAccountMoved',
  },
}
