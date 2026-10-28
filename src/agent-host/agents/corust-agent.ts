import type { AgentDefinition } from '../catalog'

// The registry's archive, 0.6.0, checked on 2026-10-28; it lists no sha256.
const BASE = 'https://github.com/Corust-ai/corust-agent-release/releases/download/v0.6.0'

export const CORUST_AGENT: AgentDefinition = {
  id: 'corust-agent',
  name: 'Corust Agent',
  registryId: 'corust-agent',
  launch: { kind: 'binary', command: 'corust-agent-acp', args: [] },
  install: {
    hint: 'detect.hint.archive',
    url: 'https://corust.ai',
  },
  installs: {
    archive: {
      version: '0.6.0',
      entries: {
        'darwin-aarch64': {
          url: `${BASE}/agent-darwin-arm64.tar.gz`,
          cmd: './corust-agent-acp',
        },
        'darwin-x86_64': {
          url: `${BASE}/agent-darwin-x64.tar.gz`,
          cmd: './corust-agent-acp',
        },
        'linux-x86_64': {
          url: `${BASE}/agent-linux-x64.tar.gz`,
          cmd: './corust-agent-acp',
        },
        'windows-x86_64': {
          url: `${BASE}/agent-windows-x64.zip`,
          cmd: './corust-agent-acp.exe',
        },
      },
    },
  },
}
