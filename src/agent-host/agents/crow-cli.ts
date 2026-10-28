import type { AgentDefinition } from '../catalog'

// The registry's archive, 0.1.24, checked on 2026-10-28; it lists no sha256.
const BASE = 'https://github.com/crow-cli/crow-cli/releases/download/v0.1.24'

export const CROW_CLI: AgentDefinition = {
  id: 'crow-cli',
  name: 'crow-cli',
  registryId: 'crow-cli',
  launch: { kind: 'binary', command: 'crow-cli', args: ['acp'] },
  install: {
    hint: 'detect.hint.archive',
    url: 'https://github.com/crow-cli/crow-cli',
  },
  installs: {
    archive: {
      version: '0.1.24',
      entries: {
        'darwin-aarch64': {
          url: `${BASE}/crow-cli-darwin-aarch64.tar.gz`,
          cmd: './crow-cli',
          args: ['acp'],
        },
        'darwin-x86_64': {
          url: `${BASE}/crow-cli-darwin-x86_64.tar.gz`,
          cmd: './crow-cli',
          args: ['acp'],
        },
        'linux-aarch64': {
          url: `${BASE}/crow-cli-linux-aarch64.tar.gz`,
          cmd: './crow-cli',
          args: ['acp'],
        },
        'linux-x86_64': {
          url: `${BASE}/crow-cli-linux-x86_64.tar.gz`,
          cmd: './crow-cli',
          args: ['acp'],
        },
        'windows-x86_64': {
          url: `${BASE}/crow-cli-windows-x86_64.zip`,
          cmd: './crow-cli.exe',
          args: ['acp'],
        },
      },
    },
  },
}
