import type { AgentDefinition } from '../catalog'

export function fakeAgent(script: string): AgentDefinition {
  return {
    id: 'fake-agent',
    name: 'Fake agent',
    registryId: 'fake-agent',
    launch: { kind: 'node-script', script },
    install: {
      hint: 'detect.hint.fakeAgent',
      url: 'https://agentclientprotocol.com',
    },
    reportsAccount: true,
  }
}
