import type { AgentDefinition } from '../catalog'
import { qwenFolderHold } from '../folder-holds'

export const QWEN: AgentDefinition = {
  id: 'qwen',
  limitsReason: 'harness-does-not-offer',
  name: 'Qwen Code',
  registryId: 'qwen-code',
  launch: { kind: 'package', package: '@qwen-code/qwen-code', command: 'qwen', args: ['--acp'] },
  // A folder's `.env` sends the user's key wherever it says (0.28.0); Qwen reads its trust list
  // once per process, so allowed folders run on a second one.
  protocol: 'acp-folders',
  folderConfigOff: qwenFolderHold,
  requiresNode: '>=22',
  install: {
    hint: 'detect.hint.node',
    url: 'https://nodejs.org/en/download',
    guide: 'https://qwenlm.github.io/qwen-code-docs/en/users/overview/',
  },
  // The package managers its README lists, checked on 2026-11-21; its standalone script is left out.
  installs: { brew: 'qwen-code', npm: '@qwen-code/qwen-code' },
}
