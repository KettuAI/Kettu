import type { AgentDefinition } from '../catalog'

export const AMP: AgentDefinition = {
  id: 'amp',
  limitsReason: 'not-yet-supported',
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
    archive: {},
  },
}
