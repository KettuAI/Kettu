import type { AgentDefinition } from '../catalog'
import { CONFIG_VARIABLES } from '@shared/settings'

const DSH_VERSION = '0.2.2-rc.2'

// DeepSeek Harness runs through its own SDK interface, `dsh --profile sdk`, one process per
// session. Its wire has no version to negotiate and changes between releases, so Kettu installs a
// pinned `@deepseek-ai/dsh` from npm and an update stays within the pinned minor version.
export const DEEPSEEK: AgentDefinition = {
  id: 'deepseek',
  name: 'DeepSeek Harness',
  registryId: 'deepseek-harness',
  protocol: 'dsh-sdk',
  launch: {
    kind: 'package',
    package: '@deepseek-ai/dsh',
    version: DSH_VERSION,
    updates: `~${DSH_VERSION}`,
  },
  requiresNode: '>=24.9.0',
  install: {
    hint: 'detect.hint.deepseek',
    url: 'https://github.com/deepseek-ai/deepseek-harness',
  },
  configVariable: CONFIG_VARIABLES.deepseek,
}
