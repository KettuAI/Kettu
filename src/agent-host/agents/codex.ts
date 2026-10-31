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
  progressNotes: true,
  cli: CODEX_CLI,
  configVariable: CONFIG_VARIABLES.codex,
  mcpConfig: { project: '.codex/config.toml', listCommand: '/mcp' },
}
