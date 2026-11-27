import { parseJsonVersion } from '../agent-updates'
import type { AgentDefinition } from '../catalog'

export const OMP: AgentDefinition = {
  id: 'omp',
  limitsReason: 'not-yet-supported',
  name: 'OMP',
  registryId: 'omp',
  launch: { kind: 'binary', command: 'omp', args: ['acp'] },
  install: {
    hint: 'detect.hint.omp',
    url: 'https://omp.sh',
  },
  // The routes its README lists for macOS and Linux, checked on 2026-11-03. The Windows script is
  // PowerShell, which is not a route.
  installs: {
    script: 'https://omp.sh/install',
    scriptShell: 'sh',
    scriptBin: ['.local', 'bin'],
    scriptHome: ['.local', 'bin'],
    brew: 'can1357/tap/omp',
    // The same stable release API the official omp.sh/install script queries.
    versionCheck: {
      urls: (platform, arch) => {
        const osName = platform === 'darwin' ? 'macos' : platform === 'linux' ? 'linux' : null
        const machine = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'arm64' : null
        if (!osName || !machine) return []
        return [
          `https://build.stencil.so/api/products/omp/latest/${osName}-${machine}?channel=stable`,
        ]
      },
      parse: (body) => parseJsonVersion(body, ['build', 'version']),
    },
    order: ['script', 'brew'],
  },
}
