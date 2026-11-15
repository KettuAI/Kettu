import type { AgentDefinition } from '../catalog'
import { CONFIG_VARIABLES } from '@shared/settings'
import { CODEX_CLI } from '../installed-cli'

// Only the user's own `codex` runs, as `codex app-server`; Kettu installs nothing for it.
export const CODEX: AgentDefinition = {
  id: 'codex',
  name: 'Codex',
  registryId: 'codex-acp',
  protocol: 'codex-app-server',
  launch: { kind: 'binary', command: 'codex', args: ['app-server'] },
  install: { hint: 'detect.hint.codex', url: 'https://developers.openai.com/codex/cli' },
  // The routes https://developers.openai.com/codex/cli lists, checked on 2026-10-31.
  installs: {
    script: 'https://chatgpt.com/codex/install.sh',
    scriptShell: 'sh',
    scriptBin: ['.local', 'bin'],
    scriptHome: ['.codex', 'packages', 'standalone'],
    brewCask: 'codex',
    npm: '@openai/codex',
    order: ['script', 'brew', 'npm'],
  },
  reportsAccount: true,
  cli: CODEX_CLI,
  configVariable: CONFIG_VARIABLES.codex,
  mcpConfig: { project: '.codex/config.toml', listCommand: '/mcp' },
  // No confirmed prices: the ranks follow the families' sizes, smallest first.
  modelNotes: [
    {
      match: ['gpt-6-luna', 'gpt-5.6-luna', 'gpt-6-mini', 'gpt-5-mini', 'gpt-5-nano'],
      name: 'Luna and mini models',
      rank: 1,
      note: 'Small and fast; enough for mechanical steps.',
    },
    {
      match: ['gpt-5.6-terra'],
      name: 'Terra',
      rank: 2,
      note: 'Mid-size; fits routine coding.',
    },
    {
      match: ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.5', 'gpt-6'],
      name: 'Sol',
      rank: 3,
      note: 'Strong general coder; fits most building and reviewing.',
    },
    {
      match: ['gpt-6-astra', 'gpt-5.5-pro'],
      name: 'Astra',
      rank: 4,
      note: 'The strongest and slowest; keep it for the hardest steps.',
    },
  ],
}
