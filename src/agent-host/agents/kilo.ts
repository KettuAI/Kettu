import type { AgentDefinition } from '../catalog'

const RELEASE = 'https://github.com/Kilo-Org/kilocode/releases/download/v7.8.28'

export const KILO: AgentDefinition = {
  id: 'kilo',
  name: 'Kilo Code',
  registryId: 'kilo',
  reportsAccount: true,
  launch: { kind: 'binary', command: 'kilo', args: ['acp'] },
  install: {
    hint: 'detect.hint.kilo',
    url: 'https://kilo.ai/docs/code-with-ai/platforms/cli',
  },
  // The archive needs no Node.js, so it comes first, then npm's global install.
  installs: {
    archive: {
      version: '7.8.28',
      entries: {
        'darwin-aarch64': {
          url: `${RELEASE}/kilo-darwin-arm64.zip`,
          sha256: 'ee0cdfb94cc9cf556e1ce734f382e624e76f5432571a0eb5a65c62a84e55a3a9',
          cmd: './kilo',
          args: ['acp'],
        },
        'darwin-x86_64': {
          url: `${RELEASE}/kilo-darwin-x64.zip`,
          sha256: '0f2b54be763d4bdb22264800ffebbfa3aeda58a03467ca3793aa1db8dfb12c98',
          cmd: './kilo',
          args: ['acp'],
        },
        'linux-aarch64': {
          url: `${RELEASE}/kilo-linux-arm64.tar.gz`,
          sha256: '5e0de28e0b660f694ddbf669118133845fc38557a82960548d7b011377f9dd6d',
          cmd: './kilo',
          args: ['acp'],
        },
        'linux-x86_64': {
          url: `${RELEASE}/kilo-linux-x64.tar.gz`,
          sha256: '72fe3cddab04a63226960bf156ace1f0a8d992e17ff8ceb3473d19dca8c369ea',
          cmd: './kilo',
          args: ['acp'],
        },
        'windows-x86_64': {
          url: `${RELEASE}/kilo-windows-x64.zip`,
          sha256: '359caa3293c970dc30e615e987885fdb5836d64a37c2801a6426d57360feabca',
          cmd: './kilo.exe',
          args: ['acp'],
        },
      },
    },
    npm: '@kilocode/cli',
  },
}
