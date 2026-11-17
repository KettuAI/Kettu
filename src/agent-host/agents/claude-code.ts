import type { AgentDefinition } from '../catalog'
import { CONFIG_VARIABLES } from '@shared/settings'
import { CLAUDE_CLI } from '../installed-cli'

// The Claude Agent SDK runs in the agent host, so the user's Node.js only runs npm to install it.
// Its 0.x minor versions may change its interface, so an update stays within the one the mapping
// is written for. The SDK installs without the CLI it would bring: only the user's own `claude`
// runs. The registry lists Claude Code as its ACP adapter, so the SDK's versions are its own.
export const CLAUDE_CODE: AgentDefinition = {
  id: 'claude-code',
  name: 'Claude Code',
  registryId: 'claude-acp',
  protocol: 'claude-sdk',
  launch: {
    kind: 'package',
    package: '@anthropic-ai/claude-agent-sdk',
    library: true,
    fromVendor: true,
    updates: '~0.3.314',
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
  modelNotes: [
    {
      match: ['claude-haiku-5-5', 'haiku'],
      name: 'Haiku 5.5',
      rank: 1,
      price: { input: 0.1, output: 0.5 },
      note: 'Smallest and fastest; enough for mechanical steps such as shipping or small edits.',
    },
    {
      match: ['claude-sonnet-5-5', 'sonnet'],
      name: 'Sonnet 5.5',
      rank: 2,
      price: { input: 2, output: 10 },
      note: 'Strong general coder at a moderate price; fits most building and reviewing.',
    },
    {
      match: ['claude-opus-5-5', 'opus'],
      name: 'Opus 5.5',
      rank: 3,
      price: { input: 4, output: 20 },
      note: 'For hard design, broad changes and careful review.',
    },
    {
      match: ['claude-fable-5-2', 'fable'],
      name: 'Fable 5.2',
      rank: 4,
      price: { input: 8, output: 40 },
      note: 'The strongest; long turns can run many minutes, so keep it for the hardest steps.',
    },
  ],
}
