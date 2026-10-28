import type { AgentDefinition } from '../catalog'

const RELEASE = 'https://github.com/Kilo-Org/kilocode/releases/download/v7.8.18'

export const KILO: AgentDefinition = {
  id: 'kilo',
  name: 'Kilo Code',
  registryId: 'kilo',
  launch: { kind: 'binary', command: 'kilo', args: ['acp'] },
  install: {
    hint: 'detect.hint.kilo',
    url: 'https://kilo.ai/docs/code-with-ai/platforms/cli',
  },
  // The archive needs no Node.js, so it comes first, then npm's global install (checked 2026-10-28).
  installs: {
    archive: {
      version: '7.8.18',
      entries: {
        'darwin-aarch64': {
          url: `${RELEASE}/kilo-darwin-arm64.zip`,
          sha256: '1ea2285a2f45ec27b7fa3b644f92700adf4a91fd671aaf18ba0cb8f26c795df5',
          cmd: './kilo',
          args: ['acp'],
        },
        'darwin-x86_64': {
          url: `${RELEASE}/kilo-darwin-x64.zip`,
          sha256: '00f6ac8fb49368e5726dc23780ee1c18fd1fd89a817e8cc38c1fe9d7db6232d2',
          cmd: './kilo',
          args: ['acp'],
        },
        'linux-aarch64': {
          url: `${RELEASE}/kilo-linux-arm64.tar.gz`,
          sha256: '55a1c13fca09eb96e5de6ec8206e1e47e5f9ec0dbf02bd1316be737bfd0666ae',
          cmd: './kilo',
          args: ['acp'],
        },
        'linux-x86_64': {
          url: `${RELEASE}/kilo-linux-x64.tar.gz`,
          sha256: '503561fb8c4b8ede26703457a912b98cf18c9c9e8961649f3718cf7676b5c02a',
          cmd: './kilo',
          args: ['acp'],
        },
        'windows-x86_64': {
          url: `${RELEASE}/kilo-windows-x64.zip`,
          sha256: '4d13c566a3e7d91ceb6986ea037a4eee6aa145918a75b38f8208034c07e74780',
          cmd: './kilo.exe',
          args: ['acp'],
        },
      },
    },
    npm: '@kilocode/cli',
  },
}
