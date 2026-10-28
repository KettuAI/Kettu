import type { AgentDefinition } from '../catalog'

// The registry's archive of the ACP server, 1.4.3, checked on 2026-10-28. The Linux builds take
// an empty `--uid` argument.
export const ANTIGRAVITY: AgentDefinition = {
  id: 'antigravity',
  name: 'Google Antigravity',
  registryId: 'antigravity-acp',
  launch: { kind: 'binary', command: 'agy_acp_server', args: [] },
  install: {
    hint: 'detect.hint.archive',
    url: 'https://antigravity.google/docs',
  },
  installs: {
    archive: {
      version: '1.4.3',
      entries: {
        'darwin-aarch64': {
          url: 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.3-darwin-arm64.zip',
          sha256: 'c57db0a9b8b712daa9c3c17cdb990a61842ea569f279e8bd79d7aa85a303b20b',
          cmd: './agy_acp_server.par',
        },
        'darwin-x86_64': {
          url: 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.3-darwin-x86_64.zip',
          sha256: '9392dbbdad7f0663dbfb5a0bf641297b0cf80d2ee9cd2d49a616bbbc7378731d',
          cmd: './agy_acp_server.par',
        },
        'linux-x86_64': {
          url: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.3-linux-x86_64.zip',
          sha256: '0634ce5306ba92c932945455e7a83fda78e2d99c33fa8aa6ee0566206a382714',
          cmd: './agy_acp_server.par',
          args: ['--uid='],
        },
        'linux-aarch64': {
          url: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.3-linux-arm64.zip',
          sha256: '05c153443b0b1175151c760eeddea538950bc9843e317d54786a1f03670182bc',
          cmd: './agy_acp_server.par',
          args: ['--uid='],
        },
        'windows-x86_64': {
          url: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.3-windows-x86_64.zip',
          sha256: '54c2e16378d9a4952e1da70e355f3c33c4f284308d6de48ab3e6e34a127bd325',
          cmd: './agy_acp_server.exe',
        },
        'windows-aarch64': {
          url: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.3-windows-arm64.zip',
          sha256: 'fcd46431ad33d3b510ce0b98fe7b43d095bd8b3f1c363ee2d57faa7ee981c7bb',
          cmd: './agy_acp_server.exe',
        },
      },
    },
  },
}
