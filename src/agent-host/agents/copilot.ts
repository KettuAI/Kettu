import type { AgentDefinition } from '../catalog'

export const COPILOT: AgentDefinition = {
  id: 'copilot',
  name: 'GitHub Copilot',
  registryId: 'github-copilot-cli',
  reportsAccount: true,
  launch: { kind: 'package', package: '@github/copilot', command: 'copilot', args: ['--acp'] },
  requiresNode: '>=22',
  install: {
    hint: 'detect.hint.node',
    url: 'https://nodejs.org/en/download',
    guide:
      'https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli',
  },
  // The routes its install page lists, checked on 2026-11-21. Its script may stop to ask about the
  // shell profile, so it is left out.
  installs: { brewCask: 'copilot-cli', winget: 'GitHub.Copilot', npm: '@github/copilot' },
}
