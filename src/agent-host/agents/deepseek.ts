import type { AgentDefinition } from '../catalog'
import { CONFIG_VARIABLES } from '@shared/settings'

// DeepSeek Harness runs through its own SDK interface, `dsh --profile sdk`, one process per
// session. Its wire has no version to negotiate and changes between releases, so Kettu installs
// `@deepseek-ai/dsh` from npm and an update stays within the minor version the mapping is written
// for. The registry does not list it.
export const DEEPSEEK: AgentDefinition = {
  id: 'deepseek',
  name: 'DeepSeek Harness',
  registryId: 'deepseek-harness',
  protocol: 'dsh-sdk',
  launch: {
    kind: 'package',
    package: '@deepseek-ai/dsh',
    fromVendor: true,
    updates: '~0.2.2-rc.2',
  },
  requiresNode: '>=24.9.0',
  install: {
    hint: 'detect.hint.deepseek',
    url: 'https://github.com/deepseek-ai/deepseek-harness',
  },
  configVariable: CONFIG_VARIABLES.deepseek,
}
