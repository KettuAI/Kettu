import type { AgentDefinition } from '../catalog'
import { CONFIG_VARIABLES } from '@shared/settings'
import { codexLaunchEnv } from '../codex-binary'
import { CODEX_CLI } from '../installed-cli'

export const CODEX: AgentDefinition = {
  id: 'codex',
  name: 'Codex',
  registryId: 'codex-acp',
  launch: { kind: 'package', package: '@agentclientprotocol/codex-acp', version: '2.2.2' },
  requiresNode: '>=22',
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
  reportsAccount: true,
  progressNotes: true,
  replaysThoughtParts: true,
  launchEnv: codexLaunchEnv,
  cli: CODEX_CLI,
  configVariable: CONFIG_VARIABLES.codex,
  mcpConfig: { project: '.codex/config.toml', listCommand: '/mcp' },
}
