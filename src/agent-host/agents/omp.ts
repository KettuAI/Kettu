import type { AgentDefinition } from '../catalog'

export const OMP: AgentDefinition = {
  id: 'omp',
  name: 'OMP',
  registryId: 'omp',
  launch: { kind: 'binary', command: 'omp', args: ['acp'] },
  install: {
    hint: 'detect.hint.omp',
    url: 'https://omp.sh',
  },
}
