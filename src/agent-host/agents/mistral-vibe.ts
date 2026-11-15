import type { AgentDefinition } from '../catalog'

const BASE = 'https://github.com/mistralai/mistral-vibe/releases/download/v3.1.1'

export const MISTRAL_VIBE: AgentDefinition = {
  id: 'mistral-vibe',
  name: 'Mistral Vibe',
  registryId: 'mistral-vibe',
  reportsAccount: true,
  launch: { kind: 'binary', command: 'vibe-acp', args: [] },
  install: {
    hint: 'detect.hint.archive',
    url: 'https://github.com/mistralai/mistral-vibe',
  },
  installs: {
    archive: {
      version: '3.1.1',
      entries: {
        'darwin-aarch64': {
          url: `${BASE}/vibe-acp-darwin-aarch64-3.1.1.tar.gz`,
          sha256: 'c5cec6fb85ca6249e68d6f9a60fbbfba3f0d4740ea97add3208170408fa98315',
          cmd: './vibe-acp',
        },
        'darwin-x86_64': {
          url: `${BASE}/vibe-acp-darwin-x86_64-3.1.1.tar.gz`,
          sha256: 'c229d6d118815c26d1d08ad7ce0afb38d399f90a873ee040f1b4518e4cfd1613',
          cmd: './vibe-acp',
        },
        'linux-aarch64': {
          url: `${BASE}/vibe-acp-linux-aarch64-3.1.1.tar.gz`,
          sha256: 'c2dbf99928f80b368a795af5ae870c6ccf2137ac06ad5478d52c44856ea6a219',
          cmd: './vibe-acp',
        },
        'linux-x86_64': {
          url: `${BASE}/vibe-acp-linux-x86_64-3.1.1.tar.gz`,
          sha256: 'ea3b33b2faebbd5cd2c4bc1c5226e865a8cafeb7486fb7fbd869418b4e4f6fec',
          cmd: './vibe-acp',
        },
        'windows-x86_64': {
          url: `${BASE}/vibe-acp-windows-x86_64-3.1.1.zip`,
          sha256: 'ff827873a0506fdb110c9b6080f7a26bac804d6bdc49c6103b2f36873927f2fd',
          cmd: './vibe-acp.exe',
        },
      },
    },
  },
}
