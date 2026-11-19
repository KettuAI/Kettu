import type { AgentDefinition } from '../catalog'
import { OPENCODE_CLI } from '../installed-cli'

export const OPENCODE: AgentDefinition = {
  id: 'opencode',
  name: 'OpenCode',
  registryId: 'opencode',
  launch: { kind: 'binary', command: 'opencode', args: ['acp'] },
  // Its own server, which OpenCode marks experimental: checked on 2.3.2.
  preferred: { protocol: 'opencode-server', checked: '>=2.3.2 <2.4.0' },
  // Seen in OpenCode 2.0.32: every attach adds its servers to the folder, replacing a same name,
  // and every tool call carries `_meta["ai.opencode/sessionID"]`.
  mcpServersByName: true,
  mcpConfig: { project: 'opencode.json' },
  install: {
    hint: 'detect.hint.opencode',
    url: 'https://opencode.ai/v2/docs/',
    notice: 'detect.opencodeInstallNotice',
  },
  // The routes https://opencode.ai/v2/docs lists for OpenCode 2, checked on 2026-11-17. The
  // plain `opencode` formula, `opencode.ai/install` and `opencode-ai` all install OpenCode 1.
  installs: {
    brew: 'anomalyco/tap/opencode-v2',
    script: 'https://opencode.ai/v2/install',
    scriptBin: ['.opencode', 'bin'],
    // OpenCode 1's script installs here too, and running this script again replaces it.
    scriptHome: ['.opencode', 'bin'],
    npm: '@opencode/cli',
  },
  cli: OPENCODE_CLI,
}
