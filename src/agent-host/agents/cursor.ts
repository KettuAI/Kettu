import type { AgentDefinition } from '../catalog'

const LAB = 'https://downloads.cursor.com/lab/2026.10.22-27dcf5f'

export const CURSOR: AgentDefinition = {
  id: 'cursor',
  name: 'Cursor',
  registryId: 'cursor',
  launch: { kind: 'binary', command: 'cursor-agent', args: ['acp'] },
  install: {
    hint: 'detect.hint.cursor',
    url: 'https://cursor.com/docs/cli/acp',
  },
  // The registry ships Cursor only as a platform archive, with no SHA-256 (checked 2026-10-28).
  installs: {
    archive: {
      version: '2026.10.22',
      entries: {
        'darwin-aarch64': {
          url: `${LAB}/darwin/arm64/agent-cli-package.tar.gz`,
          cmd: './dist-package/cursor-agent',
          args: ['acp'],
        },
        'darwin-x86_64': {
          url: `${LAB}/darwin/x64/agent-cli-package.tar.gz`,
          cmd: './dist-package/cursor-agent',
          args: ['acp'],
        },
        'linux-aarch64': {
          url: `${LAB}/linux/arm64/agent-cli-package.tar.gz`,
          cmd: './dist-package/cursor-agent',
          args: ['acp'],
        },
        'linux-x86_64': {
          url: `${LAB}/linux/x64/agent-cli-package.tar.gz`,
          cmd: './dist-package/cursor-agent',
          args: ['acp'],
        },
        'windows-aarch64': {
          url: `${LAB}/windows/arm64/agent-cli-package.zip`,
          cmd: './dist-package\\cursor-agent.cmd',
          args: ['acp'],
        },
        'windows-x86_64': {
          url: `${LAB}/windows/x64/agent-cli-package.zip`,
          cmd: './dist-package\\cursor-agent.cmd',
          args: ['acp'],
        },
      },
    },
  },
}
