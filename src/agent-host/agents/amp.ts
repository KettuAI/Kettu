import type { AgentDefinition } from '../catalog'

const RELEASE = 'https://github.com/tao12345666333/amp-acp/releases/download/v0.10.0'

export const AMP: AgentDefinition = {
  id: 'amp',
  name: 'Amp',
  registryId: 'amp-acp',
  // The archive holds the adapter itself, which speaks ACP without arguments; `amp` on PATH is
  // Amp's own CLI and speaks none.
  launch: { kind: 'binary', command: 'amp-acp', args: [] },
  install: {
    hint: 'detect.hint.amp',
    url: 'https://ampcode.com/docs/cli',
  },
  installs: {
    archive: {
      version: '0.10.0',
      entries: {
        'darwin-aarch64': {
          url: `${RELEASE}/amp-acp-darwin-aarch64.tar.gz`,
          sha256: '0434cab747e8f655bbf57dba2421dfd4e01f885ded7776d166150547f07385f3',
          cmd: './amp-acp',
        },
        'darwin-x86_64': {
          url: `${RELEASE}/amp-acp-darwin-x86_64.tar.gz`,
          sha256: 'ceb87500641814bf0f5944f028328c45ff2db8205ab51a37cff622e91d7ea6a4',
          cmd: './amp-acp',
        },
        'linux-aarch64': {
          url: `${RELEASE}/amp-acp-linux-aarch64.tar.gz`,
          sha256: '523e03dbf013dd9281aa8aa296691e472d039ed7f47c464ebdc4a6f0a0567ef1',
          cmd: './amp-acp',
        },
        'linux-x86_64': {
          url: `${RELEASE}/amp-acp-linux-x86_64.tar.gz`,
          sha256: '320959bb1de650681413a3fc72febd62fded65c734b9ab3399855e007fcdd1ba',
          cmd: './amp-acp',
        },
        'windows-x86_64': {
          url: `${RELEASE}/amp-acp-windows-x86_64.zip`,
          sha256: 'af3fe51c6b555f25446cb18cc81218d0cc334227289215cacb5a53feb12ff33f',
          cmd: 'amp-acp.exe',
        },
      },
    },
  },
}
