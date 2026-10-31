import type { AgentDefinition } from '../catalog'
import { CONFIG_VARIABLES } from '@shared/settings'
import { CLAUDE_CLI } from '../installed-cli'

const SDK_VERSION = '0.3.314'

// The Claude Agent SDK runs in the agent host, so the user's Node.js only runs npm to install it.
// Its 0.x minor versions may change its interface, so an update stays within the pinned one. The
// SDK installs without the CLI it would bring: only the user's own `claude` runs.
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
  install: { hint: 'detect.hint.claudeCode', url: 'https://code.claude.com/docs/en/setup' },
  // The routes https://code.claude.com/docs/en/setup lists, checked on 2026-10-31; apt, dnf and
  // apk need an administrator, so the page links the docs for them instead.
  installs: {
    script: 'https://claude.ai/install.sh',
    scriptBin: ['.local', 'bin'],
    scriptHome: ['.local', 'share', 'claude'],
    selfUpdate: ['update'],
    brewCask: 'claude-code',
    winget: 'Anthropic.ClaudeCode',
    npm: '@anthropic-ai/claude-code',
    order: ['script', 'brew', 'winget', 'npm'],
  },
  reportsAccount: true,
  cli: CLAUDE_CLI,
  configVariable: CONFIG_VARIABLES['claude-code'],
  mcpConfig: { project: '.mcp.json' },
}
