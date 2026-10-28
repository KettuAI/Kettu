import type { AgentDefinition } from '../catalog'

// The registry's archive, 0.3.88, checked on 2026-10-28; it lists no sha256.
const BASE = 'https://github.com/stakpak/agent/releases/download/v0.3.88'

export const STAKPAK: AgentDefinition = {
  id: 'stakpak',
  name: 'Stakpak',
  registryId: 'stakpak',
  launch: { kind: 'binary', command: 'stakpak', args: ['acp'] },
  install: {
    hint: 'detect.hint.archive',
    url: 'https://stakpak.dev',
  },
  installs: {
    archive: {
      version: '0.3.88',
      entries: {
        'darwin-aarch64': {
          url: `${BASE}/stakpak-darwin-aarch64.tar.gz`,
          cmd: './stakpak',
          args: ['acp'],
        },
        'darwin-x86_64': {
          url: `${BASE}/stakpak-darwin-x86_64.tar.gz`,
          cmd: './stakpak',
          args: ['acp'],
        },
        'linux-aarch64': {
          url: `${BASE}/stakpak-linux-aarch64.tar.gz`,
          cmd: './stakpak',
          args: ['acp'],
        },
        'linux-x86_64': {
          url: `${BASE}/stakpak-linux-x86_64.tar.gz`,
          cmd: './stakpak',
          args: ['acp'],
        },
        'windows-x86_64': {
          url: `${BASE}/stakpak-windows-x86_64.zip`,
          cmd: './stakpak.exe',
          args: ['acp'],
        },
      },
    },
  },
}
