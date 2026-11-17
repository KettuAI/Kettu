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
    args: ['--acp'],
  },
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
  configVariable: CONFIG_VARIABLES.codebuddy,
  // Its browser and WeChat sign-in lives in a file under the user's application data, not in the
  // agent's folder. In memory, the process never reads it, so an added agent uses only its own key.
  addedEnv: { CODEBUDDY_CREDENTIALS_IN_MEMORY: '1' },
}
