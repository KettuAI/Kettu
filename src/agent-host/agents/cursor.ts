import type { AgentDefinition } from '../catalog'

export const CURSOR: AgentDefinition = {
  id: 'cursor',
  name: 'Cursor',
  reportsAccount: true,
  registryId: 'cursor',
  launch: { kind: 'binary', command: 'cursor-agent', args: ['acp'] },
  install: {
    hint: 'detect.hint.cursor',
    url: 'https://cursor.com/docs/cli/acp',
  },
  // The registry ships Cursor only as a platform archive.
  installs: {
    archive: {},
  },
}
