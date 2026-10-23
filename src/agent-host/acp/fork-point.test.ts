import { describe, expect, it } from 'vitest'
import { forkPointMeta, forksAtMessage } from './fork-point'

describe('forksAtMessage', () => {
  it('knows the adapters that fork at a message, from the version that does', () => {
    const claude = '@agentclientprotocol/claude-agent-acp'
    const codex = '@agentclientprotocol/codex-acp'
    expect(forksAtMessage({ name: claude, version: '0.94.0' })).toBe(true)
    expect(forksAtMessage({ name: claude, version: '0.95.1' })).toBe(true)
    expect(forksAtMessage({ name: claude, version: '0.93.2' })).toBe(false)
    expect(forksAtMessage({ name: codex, version: '2.2.2' })).toBe(true)
    expect(forksAtMessage({ name: codex, version: '2.2.1' })).toBe(false)
  })

  it('leaves out every other agent and one that names no version', () => {
    expect(forksAtMessage({ name: 'opencode', version: '2.0.32' })).toBe(false)
    expect(forksAtMessage({ name: '@agentclientprotocol/codex-acp', version: 'next' })).toBe(false)
    expect(forksAtMessage({ name: 'constructor', version: '1.0.0' })).toBe(false)
    expect(forksAtMessage(null)).toBe(false)
  })
})

describe('forkPointMeta', () => {
  it('names the message with its text fingerprint and occurrence', () => {
    expect(forkPointMeta({ messageId: 'msg_1', text: 'Done.', occurrence: 2 })).toEqual({
      jetbrains: {
        air: {
          fork: {
            version: 1,
            messageId: 'msg_1',
            messageFingerprint:
              'sha256:ed251864987c367e9641fbdc89c1d83e9bf0fa2e3eecef8f301c79f619bfac81',
            messageOccurrence: 2,
          },
        },
      },
    })
  })
})
