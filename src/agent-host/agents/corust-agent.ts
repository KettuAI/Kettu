import type { AgentDefinition } from '../catalog'

export const CORUST_AGENT: AgentDefinition = {
  id: 'corust-agent',
  limitsReason: 'not-yet-supported',
  name: 'Corust Agent',
  registryId: 'corust-agent',
  launch: { kind: 'binary', command: 'corust-agent-acp', args: [] },
  install: {
    hint: 'detect.hint.archive',
    url: 'https://corust.ai',
  },
  installs: {
    archive: {},
  },
}
