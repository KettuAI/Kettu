import type { AgentDefinition } from '../catalog'

const RELEASE = 'https://github.com/MoonshotAI/kimi-cli/releases/download/1.52.0'

export const KIMI: AgentDefinition = {
  id: 'kimi',
  name: 'Kimi Code CLI',
  registryId: 'kimi',
  launch: { kind: 'binary', command: 'kimi', args: ['acp'] },
  install: {
    hint: 'detect.hint.kimi',
    url: 'https://moonshotai.github.io/kimi-cli/',
  },
  // The registry publishes no macOS Intel archive, so that platform can only use the user's copy.
  installs: {
    archive: {
      version: '1.52.0',
      entries: {
        'darwin-aarch64': {
          url: `${RELEASE}/kimi-1.52.0-aarch64-apple-darwin.tar.gz`,
          sha256: '43fe091f70bbf8860974200f9021a05689a020857cc9926d56f1505f0d0d5cb8',
          cmd: './kimi',
          args: ['acp'],
        },
        'linux-aarch64': {
          url: `${RELEASE}/kimi-1.52.0-aarch64-unknown-linux-gnu.tar.gz`,
          sha256: '9e06eea96273600aed485b1f0bedda95b7084db4f22cf28614fe20138933507a',
          cmd: './kimi',
          args: ['acp'],
        },
        'linux-x86_64': {
          url: `${RELEASE}/kimi-1.52.0-x86_64-unknown-linux-gnu.tar.gz`,
          sha256: 'a676204f7804ed5dae87652a9d66f578e0718d5026c9cb1bfa32b9a5eace4208',
          cmd: './kimi',
          args: ['acp'],
        },
        'windows-aarch64': {
          url: `${RELEASE}/kimi-1.52.0-aarch64-pc-windows-msvc.zip`,
          sha256: '7c77cd413e7a3a59416c171a45ee4ff50534869b331469138aad84b9e3acb6c0',
          cmd: './kimi.exe',
          args: ['acp'],
        },
        'windows-x86_64': {
          url: `${RELEASE}/kimi-1.52.0-x86_64-pc-windows-msvc.zip`,
          sha256: '2c269e15e152b9f28ac1556795280f90a2c9860ff44c60c628c3fce4dd4c58a7',
          cmd: './kimi.exe',
          args: ['acp'],
        },
      },
    },
  },
}
