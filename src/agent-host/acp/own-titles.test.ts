import { describe, expect, it } from 'vitest'
import { ownTitles } from './own-titles'

const at = (name: string, version: string) => ownTitles({ name, version })

describe('the titles an agent writes itself', () => {
  it('takes each adapter from the first version that writes one', () => {
    expect(at('@agentclientprotocol/claude-agent-acp', '0.94.0')).toBe('sent')
    expect(at('@agentclientprotocol/claude-agent-acp', '0.97.0')).toBe('sent')
    expect(at('@agentclientprotocol/claude-agent-acp', '0.93.0')).toBeNull()

    // Codex runs through its app-server now, so its adapter is no longer known.
    expect(at('@agentclientprotocol/codex-acp', '2.2.2')).toBeNull()

    expect(at('fake-agent', '0.1.0')).toBe('sent')
    expect(at('fake-agent', '0.0.9')).toBeNull()

    expect(at('OpenCode', '2.0.32')).toBe('listed')
    expect(at('OpenCode', '2.1.0')).toBe('listed')
    expect(at('OpenCode', '2.0.31')).toBeNull()
  })

  it('leaves an agent it does not know, and one that does not name itself, to Kettu', () => {
    expect(at('pi-acp', '0.0.34')).toBeNull()
    expect(ownTitles(null)).toBeNull()
    expect(ownTitles(undefined)).toBeNull()
  })
})
