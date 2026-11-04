import type { AgentDefinition } from '../catalog'

export const HERMES: AgentDefinition = {
  id: 'hermes',
  name: 'Hermes Agent',
  registryId: 'hermes-agent',
  launch: { kind: 'binary', command: 'hermes', args: ['acp'] },
  install: {
    hint: 'detect.hint.hermes',
    url: 'https://hermes-agent.nousresearch.com/docs/getting-started/installation',
    notice: 'detect.hermesInstallNotice',
  },
  installs: {
    script: 'https://hermes-agent.nousresearch.com/install.sh',
    scriptArgs: ['--non-interactive', '--skip-browser', '--skip-computer-use'],
    scriptBin: ['.local', 'bin'],
    scriptHome: ['.hermes', 'hermes-agent'],
    order: ['script'],
  },
}
