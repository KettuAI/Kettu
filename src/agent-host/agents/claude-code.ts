import type { AgentDefinition } from '../catalog'
import { CONFIG_VARIABLES } from '@shared/settings'
import { CLAUDE_CLI } from '../installed-cli'

const SDK_VERSION = '0.3.314'

// The Claude Agent SDK runs in the agent host, so the user's Node.js only runs npm to install it.
// Its 0.x minor versions may change its interface, so an update stays within the pinned one.
export const CLAUDE_CODE: AgentDefinition = {
  id: 'claude-code',
  name: 'Claude Code',
  registryId: 'claude-acp',
  protocol: 'claude-sdk',
  launch: {
    kind: 'package',
    package: '@anthropic-ai/claude-agent-sdk',
    version: SDK_VERSION,
    library: true,
    updates: `~${SDK_VERSION}`,
  },
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
  reportsAccount: true,
  cli: CLAUDE_CLI,
  configVariable: CONFIG_VARIABLES['claude-code'],
  mcpConfig: { project: '.mcp.json', listCommand: '/mcp' },
}
