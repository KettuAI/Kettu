import type { AgentDefinition } from '../catalog'

const RELEASE = 'https://github.com/burin-labs/harn/releases/download/v0.10.180'

export const HARN: AgentDefinition = {
  id: 'harn',
  name: 'Harn',
  registryId: 'harn',
  launch: { kind: 'binary', command: 'harn', args: ['serve', 'acp'] },
  install: {
    hint: 'detect.hint.harn',
    url: 'https://harnlang.com',
  },
  // Each platform ships a .tar.gz, or .zip on Windows, with its SHA-256 (checked 2026-10-28).
  installs: {
    archive: {
      version: '0.10.180',
      entries: {
        'darwin-aarch64': {
          url: `${RELEASE}/harn-aarch64-apple-darwin.tar.gz`,
          sha256: '54f7f21189b4d5f52add969e9cb09aedf91a57379b472f45331118bb639f34ac',
          cmd: './harn',
          args: ['serve', 'acp'],
        },
        'darwin-x86_64': {
          url: `${RELEASE}/harn-x86_64-apple-darwin.tar.gz`,
          sha256: '4947c9c3f1840f2cdd158f425547c0d891902d7988f82e30565b1244587dd6a5',
          cmd: './harn',
          args: ['serve', 'acp'],
        },
        'linux-aarch64': {
          url: `${RELEASE}/harn-aarch64-unknown-linux-gnu.tar.gz`,
          sha256: '13b552530eb689b602bc82b6e75f8bf1f8466e99c0285353ed64d1312ceb3e49',
          cmd: './harn',
          args: ['serve', 'acp'],
        },
        'linux-x86_64': {
          url: `${RELEASE}/harn-x86_64-unknown-linux-gnu.tar.gz`,
          sha256: '084ddf93a0f6a9dba909267db5c55c82266f9aecab924fe004b19c5274868b77',
          cmd: './harn',
          args: ['serve', 'acp'],
        },
        'windows-x86_64': {
          url: `${RELEASE}/harn-x86_64-pc-windows-msvc.zip`,
          sha256: '8ab68f926cbabe79c9124aa6180267d41851ff2b0af62850211f421fc3f6fb8d',
          cmd: 'harn.exe',
          args: ['serve', 'acp'],
        },
      },
    },
  },
}
