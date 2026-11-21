import type { AgentDefinition } from '../catalog'

export const GEMINI: AgentDefinition = {
  id: 'gemini',
  limitsReason: 'vendor-disallows',
  name: 'Gemini CLI',
  registryId: 'gemini',
  launch: { kind: 'package', package: '@google/gemini-cli', command: 'gemini', args: ['--acp'] },
  requiresNode: '>=22',
  install: {
    hint: 'detect.hint.node',
    url: 'https://nodejs.org/en/download',
    guide: 'https://geminicli.com/docs/get-started/installation/',
  },
  // The npm command its install page lists; its Homebrew formula is disabled on 2026-12-18.
  installs: { npm: '@google/gemini-cli' },
  // Since 2026-06-18 Google serves personal accounts in Antigravity; Gemini CLI 0.66.0 passes on
  // the Code Assist server's refusal of them.
  movedAccounts: {
    refusal: /no longer supported for Gemini Code Assist for individuals/i,
    to: 'antigravity',
    audience: 'detect.geminiAudience',
    refused: 'agent.geminiAccountMoved',
  },
}
