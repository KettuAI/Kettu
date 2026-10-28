import type { AgentDefinition } from '../catalog'

// The registry's archive, 1.0.73, checked on 2026-10-28: each build's folder names it, and the
// registry lists no sha256.
const BUILD = '1.0.73+180523.e6179a031de9'
const BASE =
  'https://sfc-repo.snowflakecomputing.com/cortex-code-cli/a4643c4278/1.0.73%2B180523.e6179a031de9'

function entry(platform: string, executable: string) {
  const urlFolder = `coco-${BUILD.replace('+', '%2B')}-${platform}`
  return {
    url: `${BASE}/${urlFolder}.tar.gz`,
    cmd: `./coco-${BUILD}-${platform}/${executable}`,
    args: ['acp', 'serve'],
  }
}

export const CORTEX_CODE: AgentDefinition = {
  id: 'cortex-code',
  name: 'Cortex Code',
  registryId: 'cortex-code',
  launch: { kind: 'binary', command: 'cortex', args: ['acp', 'serve'] },
  install: {
    hint: 'detect.hint.archive',
    url: 'https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-cli',
  },
  installs: {
    archive: {
      version: '1.0.73',
      entries: {
        'darwin-aarch64': entry('darwin-arm64', 'cortex'),
        'darwin-x86_64': entry('darwin-amd64', 'cortex'),
        'linux-x86_64': entry('linux-amd64', 'cortex'),
        'linux-aarch64': entry('linux-arm64', 'cortex'),
        'windows-x86_64': entry('windows-amd64', 'cortex.exe'),
        'windows-aarch64': entry('windows-arm64', 'cortex.exe'),
      },
    },
  },
}
