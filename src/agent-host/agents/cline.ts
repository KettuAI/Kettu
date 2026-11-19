import type { AgentDefinition } from '../catalog'

export const CLINE: AgentDefinition = {
  id: 'cline',
  name: 'Cline',
  registryId: 'cline',
  // The package brings the SDK its CLI is built on; `--acp` is the launch a start falls back to.
  protocol: 'cline-sdk',
  launch: { kind: 'package', package: 'cline', args: ['--acp'] },
  requiresNode: '>=22',
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}
