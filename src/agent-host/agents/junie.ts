import type { AgentDefinition } from '../catalog'

// The registry's archive, 3893.5.0, checked on 2026-10-28; every platform ships a .zip and the
// registry lists no sha256. macOS carries a full .app bundle, so the command is its executable.
const BASE = 'https://github.com/JetBrains/junie-acp-release/releases/download/3893.5'

export const JUNIE: AgentDefinition = {
  id: 'junie',
  name: 'Junie',
  registryId: 'junie',
  launch: { kind: 'binary', command: 'junie', args: ['--acp=true'] },
  install: {
    hint: 'detect.hint.archive',
    url: 'https://junie.jetbrains.com',
  },
  installs: {
    archive: {
      version: '3893.5.0',
      entries: {
        'darwin-aarch64': {
          url: `${BASE}/junie-release-3893.5-macos-aarch64.zip`,
          cmd: './Applications/junie.app/Contents/MacOS/junie',
          args: ['--acp=true'],
        },
        'darwin-x86_64': {
          url: `${BASE}/junie-release-3893.5-macos-amd64.zip`,
          cmd: './Applications/junie.app/Contents/MacOS/junie',
          args: ['--acp=true'],
        },
        'linux-aarch64': {
          url: `${BASE}/junie-release-3893.5-linux-aarch64.zip`,
          cmd: './junie-app/bin/junie',
          args: ['--acp=true'],
        },
        'linux-x86_64': {
          url: `${BASE}/junie-release-3893.5-linux-amd64.zip`,
          cmd: './junie-app/bin/junie',
          args: ['--acp=true'],
        },
        'windows-x86_64': {
          url: `${BASE}/junie-release-3893.5-windows-amd64.zip`,
          cmd: './junie/junie.exe',
          args: ['--acp=true'],
        },
        'windows-aarch64': {
          url: `${BASE}/junie-release-3893.5-windows-aarch64.zip`,
          cmd: './junie/junie.exe',
          args: ['--acp=true'],
        },
      },
    },
  },
}
