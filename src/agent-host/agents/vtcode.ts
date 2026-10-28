import type { AgentDefinition } from '../catalog'

// The registry's archive, 0.96.14, checked on 2026-10-28; it lists no sha256. Its Windows entry
// is the only command written without `./`. The ACP bridge is off by default, so the launch
// turns it on with the variable the registry gives.
const BASE = 'https://github.com/vinhnx/VTCode/releases/download/0.96.14'

export const VTCODE: AgentDefinition = {
  id: 'vtcode',
  name: 'VT Code',
  registryId: 'vtcode',
  launch: { kind: 'binary', command: 'vtcode', args: ['acp'] },
  env: { VT_ACP_ENABLED: '1' },
  install: {
    hint: 'detect.hint.archive',
    url: 'https://github.com/vinhnx/VTCode',
  },
  installs: {
    archive: {
      version: '0.96.14',
      entries: {
        'darwin-aarch64': {
          url: `${BASE}/vtcode-0.96.14-aarch64-apple-darwin.tar.gz`,
          cmd: './vtcode',
          args: ['acp'],
        },
        'darwin-x86_64': {
          url: `${BASE}/vtcode-0.96.14-x86_64-apple-darwin.tar.gz`,
          cmd: './vtcode',
          args: ['acp'],
        },
        'linux-x86_64': {
          url: `${BASE}/vtcode-0.96.14-x86_64-unknown-linux-gnu.tar.gz`,
          cmd: './vtcode',
          args: ['acp'],
        },
        'windows-x86_64': {
          url: `${BASE}/vtcode-0.96.14-x86_64-pc-windows-msvc.zip`,
          cmd: 'vtcode.exe',
          args: ['acp'],
        },
      },
    },
  },
}
