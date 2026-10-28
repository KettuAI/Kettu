import type { AgentDefinition } from '../catalog'

// The registry's archive, 1.0.16, checked on 2026-10-28, with a sha256 for every platform. Each
// build is named after its platform and ships as a plain .tar.gz, Windows included.
const BASE = 'https://downloads.poolside.ai/pool/v1.0.16'

function entry(platform: string, executable: string, sha256: string) {
  return {
    url: `${BASE}/pool-${platform}.tar.gz`,
    sha256,
    cmd: `./pool-${platform}${executable}`,
    args: ['acp'],
  }
}

export const POOLSIDE: AgentDefinition = {
  id: 'poolside',
  name: 'Poolside',
  registryId: 'poolside',
  launch: { kind: 'binary', command: 'pool', args: ['acp'] },
  install: {
    hint: 'detect.hint.archive',
    url: 'https://poolside.ai',
  },
  installs: {
    archive: {
      version: '1.0.16',
      entries: {
        'darwin-aarch64': entry(
          'darwin-arm64',
          '',
          '0932af3eb2b57a863acacb664ec8b2b1d3a76c2570a788b086001608cc585f74',
        ),
        'darwin-x86_64': entry(
          'darwin-amd64',
          '',
          '6d75fae2d7de6c35b6b467b5f682935e3ecde8ff611cb620c56b7bd607e0afde',
        ),
        'linux-aarch64': entry(
          'linux-arm64',
          '',
          '466343b66b03ee4e66476fcc69be1eb5bf8e9155a4ab73e0e72a232d1f8d2a12',
        ),
        'linux-x86_64': entry(
          'linux-amd64',
          '',
          'e86aa8c9feef003540673ab494e91bfadc273218d531c43d662cafb69e464146',
        ),
        'windows-aarch64': entry(
          'windows-arm64',
          '.exe',
          '8dc7d014ced3e9d3ced240bbc7dabaf696bf59f118bd271d9f4e8561e415d75b',
        ),
        'windows-x86_64': entry(
          'windows-amd64',
          '.exe',
          '3e324f1a4b5855ba5363232c06461ec9d6d2ae1a341c827221e79779f8f2bc6f',
        ),
      },
    },
  },
}
