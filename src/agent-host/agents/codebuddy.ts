import type { AgentDefinition } from '../catalog'
import { CONFIG_VARIABLES } from '@shared/settings'

export const CODEBUDDY: AgentDefinition = {
  id: 'codebuddy',
  limitsReason: 'harness-does-not-offer',
  name: 'Codebuddy Code',
  registryId: 'codebuddy-code',
  launch: {
    kind: 'package',
    package: '@tencent-ai/codebuddy-code',
    command: 'codebuddy',
    args: ['--acp'],
  },
  install: {
    hint: 'detect.hint.node',
    url: 'https://nodejs.org/en/download',
    guide: 'https://cnb.cool/codebuddy/codebuddy-code',
  },
  // The package managers its install page lists, checked on 2026-11-21; its scripts differ by site.
  installs: { brew: 'Tencent-CodeBuddy/tap/codebuddy-code', npm: '@tencent-ai/codebuddy-code' },
  configVariable: CONFIG_VARIABLES.codebuddy,
  // Its browser and WeChat sign-in lives in a file under the user's application data, not in the
  // agent's folder. In memory, the process never reads it, so an added agent uses only its own key.
  addedEnv: { CODEBUDDY_CREDENTIALS_IN_MEMORY: '1' },
}
