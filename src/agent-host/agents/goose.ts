import type { AgentDefinition } from '../catalog'

const RELEASE = 'https://github.com/block/goose/releases/download/v1.56.0'

export const GOOSE: AgentDefinition = {
  id: 'goose',
  name: 'goose',
  registryId: 'goose',
  launch: { kind: 'binary', command: 'goose', args: ['acp'] },
  install: {
    hint: 'detect.hint.goose',
    url: 'https://block.github.io/goose/',
  },
  // macOS and Linux ship .tar.bz2, Windows .zip, each with its SHA-256 (checked 2026-10-28).
  installs: {
    archive: {
      version: '1.56.0',
      entries: {
        'darwin-aarch64': {
          url: `${RELEASE}/goose-aarch64-apple-darwin.tar.bz2`,
          sha256: '62d806417b19be167474297eaaec7783ff9917f4fa772e781e977f2bdc155163',
          cmd: './goose',
          args: ['acp'],
        },
        'darwin-x86_64': {
          url: `${RELEASE}/goose-x86_64-apple-darwin.tar.bz2`,
          sha256: '0dabf1bc691a1855bc06d2bb5445d27d9c7c08f7ea5af49d32e460a85b98a2ad',
          cmd: './goose',
          args: ['acp'],
        },
        'linux-aarch64': {
          url: `${RELEASE}/goose-aarch64-unknown-linux-gnu.tar.bz2`,
          sha256: '30b60a49a534ca7af062ec94b752367494ad3a2824744a6d1e8ec3e1040d9922',
          cmd: './goose',
          args: ['acp'],
        },
        'linux-x86_64': {
          url: `${RELEASE}/goose-x86_64-unknown-linux-gnu.tar.bz2`,
          sha256: 'e29544421a6e698aab0fe4becda96096218ff36abe85b83785519d41c555c714',
          cmd: './goose',
          args: ['acp'],
        },
        'windows-x86_64': {
          url: `${RELEASE}/goose-x86_64-pc-windows-msvc.zip`,
          sha256: '76fbb942579f5851b6593ab0f97b7bd7317d700132443dfa37aa1cddb8af04da',
          cmd: './goose-package\\goose.exe',
          args: ['acp'],
        },
      },
    },
  },
}
