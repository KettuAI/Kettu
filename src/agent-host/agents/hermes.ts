import type { AgentDefinition } from '../catalog'

export const HERMES: AgentDefinition = {
  id: 'hermes',
  name: 'Hermes Agent',
  registryId: 'hermes-agent',
  launch: { kind: 'binary', command: 'hermes', args: ['acp'] },
  install: {
    hint: 'detect.hint.hermes',
    url: 'https://hermes-agent.nousresearch.com',
  },
}
