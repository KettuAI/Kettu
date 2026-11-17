import type { AgentDefinition } from '../catalog'

export const CORTEX_CODE: AgentDefinition = {
  id: 'cortex-code',
  limitsReason: 'administrator-managed',
  name: 'Cortex Code',
  registryId: 'cortex-code',
  launch: { kind: 'binary', command: 'cortex', args: ['acp', 'serve'] },
  install: {
    hint: 'detect.hint.archive',
    url: 'https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-cli',
  },
  installs: {
    archive: {},
  },
}
