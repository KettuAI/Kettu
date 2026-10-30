import type { AgentDefinition } from '../catalog'
import { CONFIG_VARIABLES } from '@shared/settings'
import { CODEX_CLI } from '../installed-cli'

export const CODEX: AgentDefinition = {
  id: 'codex',
  name: 'Codex',
  registryId: 'codex-acp',
  protocol: 'codex-app-server',
  // The user's own `codex` runs when it is new enough; otherwise this one, installed on first use.
  launch: { kind: 'package', package: '@openai/codex', version: '0.166.0', args: ['app-server'] },
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
  reportsAccount: true,
  progressNotes: true,
  cli: CODEX_CLI,
  configVariable: CONFIG_VARIABLES.codex,
  mcpConfig: { project: '.codex/config.toml', listCommand: '/mcp' },
}
