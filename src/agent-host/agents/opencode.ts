import type { AgentDefinition } from '../catalog'

export const OPENCODE: AgentDefinition = {
  id: 'opencode',
  name: 'OpenCode',
  registryId: 'opencode',
  launch: { kind: 'binary', command: 'opencode', args: ['acp'] },
  // Seen in OpenCode 2.0.32: every attach adds its servers to the folder, replacing a same name,
  // and every tool call carries `_meta["ai.opencode/sessionID"]`.
  mcpServersByName: true,
  mcpConfig: { project: 'opencode.json' },
  install: {
    hint: 'detect.hint.opencode',
    url: 'https://opencode.ai/docs/',
  },
  // The routes https://opencode.ai/docs lists for OpenCode 1, checked on 2026-10-22.
  installs: {
    brew: 'anomalyco/tap/opencode',
    script: 'https://opencode.ai/install',
    scriptBin: ['.opencode', 'bin'],
    npm: 'opencode-ai',
  },
}
