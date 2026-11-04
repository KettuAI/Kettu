import type { AgentDefinition } from '../catalog'

const VERSION = '1.4.14-R7309.1'
const RELEASE = `https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=${VERSION}&file=`

export const MUSE: AgentDefinition = {
  id: 'muse',
  name: 'Muse Code',
  registryId: 'muse',
  // The ACP mode is a vendor preview behind this gate, which a release may remove.
  env: { MUSE_EXPERIMENTAL_ACP: 'on' },
  launch: { kind: 'binary', command: 'muse', args: ['acp'] },
  install: {
    hint: 'detect.hint.muse',
    url: 'https://dev.meta.ai/docs',
  },
  installs: {
    archive: {
      version: VERSION,
      entries: {
        'darwin-aarch64': {
          url: `${RELEASE}muse-aarch64-macos`,
          sha256: '1c96114408acbeade9a8fb79e3b4425e5b64d50425938568aef01bdc04ce2e03',
          cmd: 'muse',
          args: ['acp'],
          bare: true,
        },
        'darwin-x86_64': {
          url: `${RELEASE}muse-x86-macos`,
          sha256: '6da5a12d3298afba45afec929fc385b516084ed28e9504ae29354dbcdfc4089d',
          cmd: 'muse',
          args: ['acp'],
          bare: true,
        },
        'linux-aarch64': {
          url: `${RELEASE}muse-aarch64-linux`,
          sha256: '3dc39b8fa26f9963cc2038f2966c0932ed5a39f0f9efb39cc0266a261cbbcf76',
          cmd: 'muse',
          args: ['acp'],
          bare: true,
        },
        'linux-x86_64': {
          url: `${RELEASE}muse-x86-linux`,
          sha256: '0809aac7cb58d18f5022b6d05e02aa1974683c0ec430e5f04d25b60ed17de2da',
          cmd: 'muse',
          args: ['acp'],
          bare: true,
        },
        'windows-aarch64': {
          url: `${RELEASE}muse-aarch64-windows.exe`,
          sha256: '64cef76cb210de993d31478ee582ef4639bbb212df8912b74f45d40431e66e82',
          cmd: 'muse.exe',
          args: ['acp'],
          bare: true,
        },
        'windows-x86_64': {
          url: `${RELEASE}muse-x86-windows.exe`,
          sha256: '20d18c426cc26e9e4b3cc07008ec07ec97e12e466a2be8cd2797b2e0e2018382',
          cmd: 'muse.exe',
          args: ['acp'],
          bare: true,
        },
      },
    },
  },
}
