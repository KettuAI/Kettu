import type { AgentDefinition } from '../catalog'
import { CONFIG_VARIABLES } from '@shared/settings'
import { CLAUDE_CLI } from '../installed-cli'

export const CLAUDE_CODE: AgentDefinition = {
  id: 'claude-code',
  name: 'Claude Code',
  registryId: 'claude-acp',
  launch: { kind: 'package', package: '@agentclientprotocol/claude-agent-acp', version: '0.94.0' },
  requiresNode: '>=22',
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
  reportsAccount: true,
  cli: CLAUDE_CLI,
  configVariable: CONFIG_VARIABLES['claude-code'],
  mcpConfig: { project: '.mcp.json', listCommand: '/mcp' },
}
