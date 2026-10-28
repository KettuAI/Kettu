import type { AgentDefinition } from '../catalog'

// The registry's archive, 3000.11.228, checked on 2026-10-28; it lists no sha256.
export const DEVIN: AgentDefinition = {
  id: 'devin',
  name: 'Devin',
  registryId: 'devin',
  launch: { kind: 'binary', command: 'devin', args: ['acp'] },
  install: {
    hint: 'detect.hint.archive',
    url: 'https://docs.devin.ai/cli',
  },
  installs: {
    archive: {
      version: '3000.11.228',
      entries: {
        'darwin-aarch64': {
          url: 'https://static.devin.ai/cli/3000.11.228/devin-3000.11.228-aarch64-apple-darwin.tar.gz',
          cmd: './bin/devin',
          args: ['acp'],
        },
        'darwin-x86_64': {
          url: 'https://static.devin.ai/cli/3000.11.228/devin-3000.11.228-x86_64-apple-darwin.tar.gz',
          cmd: './bin/devin',
          args: ['acp'],
        },
        'linux-aarch64': {
          url: 'https://static.devin.ai/cli/3000.11.228/devin-3000.11.228-aarch64-unknown-linux.tar.gz',
          cmd: './bin/devin',
          args: ['acp'],
        },
        'linux-x86_64': {
          url: 'https://static.devin.ai/cli/3000.11.228/devin-3000.11.228-x86_64-unknown-linux.tar.gz',
          cmd: './bin/devin',
          args: ['acp'],
        },
        'windows-aarch64': {
          url: 'https://static.devin.ai/cli/3000.11.228/devin-3000.11.228-aarch64-pc-windows.zip',
          cmd: './bin\\devin.exe',
          args: ['acp'],
        },
        'windows-x86_64': {
          url: 'https://static.devin.ai/cli/3000.11.228/devin-3000.11.228-x86_64-pc-windows.zip',
          cmd: './bin\\devin.exe',
          args: ['acp'],
        },
      },
    },
  },
}
