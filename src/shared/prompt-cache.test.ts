import { describe, expect, it } from 'vitest'
import type { AgentAccount } from './agent-host'
import { cacheExpiry, cachePhase, nextPhaseIn } from './prompt-cache'
import type { ConfigOption, SessionView } from './thread'

const MINUTE = 60_000

const chatGpt: AgentAccount = { kind: 'account', label: 'ChatGPT Plus', email: null }

const model = (value: string): ConfigOption => ({
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  value,
  choices: [{ value, name: value }],
})

function session(
  agentId: SessionView['agentId'],
  cache: { lastRequestAt: number; ttl: number | null } | undefined,
  config: ConfigOption[] = [],
): Pick<SessionView, 'agentId' | 'config' | 'usage'> {
  return {
    agentId,
    config,
    usage: { used: 10, size: 100, cost: null, tokens: null, ...(cache ? { cache } : {}) },
  }
}

describe('cacheExpiry', () => {
  it('is unknown before the first request', () => {
    expect(cacheExpiry(session('claude-code', undefined), null)).toBeNull()
    expect(cacheExpiry({ agentId: 'codex', config: [], usage: null }, chatGpt)).toBeNull()
  })

  it("adds the lifetime the agent's transcript gave to the last request", () => {
    expect(
      cacheExpiry(session('claude-code', { lastRequestAt: 1_000, ttl: 60 * MINUTE }), null),
    ).toEqual({
      lastRequestAt: 1_000,
      ttl: 60 * MINUTE,
      expiresAt: 1_000 + 60 * MINUTE,
      estimate: false,
    })
    expect(
      cacheExpiry(session('claude-code', { lastRequestAt: 1_000, ttl: 5 * MINUTE }), null),
    ).toEqual({
      lastRequestAt: 1_000,
      ttl: 5 * MINUTE,
      expiresAt: 1_000 + 5 * MINUTE,
      estimate: false,
    })
  })

  it('guesses nothing for Claude Code when its transcript gave no lifetime', () => {
    expect(cacheExpiry(session('claude-code', { lastRequestAt: 1_000, ttl: null }), null)).toEqual({
      lastRequestAt: 1_000,
      ttl: null,
      expiresAt: null,
      estimate: false,
    })
  })

  it("estimates Codex's from OpenAI's shortest documented retention", () => {
    const codex = session('codex', { lastRequestAt: 1_000, ttl: null }, [model('gpt-5.5')])
    const estimate = { lastRequestAt: 1_000, ttl: 5 * MINUTE, expiresAt: 1_000 + 5 * MINUTE }
    expect(cacheExpiry(codex, chatGpt)).toEqual({ ...estimate, estimate: true })
    expect(cacheExpiry(codex, { kind: 'api_key', label: 'OpenAI API key', email: null })).toEqual({
      ...estimate,
      estimate: true,
    })
  })

  it('estimates nothing for Codex on another provider, or before it names its account', () => {
    const codex = session('codex', { lastRequestAt: 1_000, ttl: null }, [model('gpt-oss:20b')])
    const none = { lastRequestAt: 1_000, ttl: null, expiresAt: null, estimate: false }
    for (const account of [
      { kind: 'gateway' as const, label: 'Custom model gateway', email: null },
      { kind: 'external' as const, label: 'AWS Bedrock', email: null },
      null,
    ]) {
      expect(cacheExpiry(codex, account)).toEqual(none)
    }
  })

  it("estimates OpenCode's only for a provider that documents one", () => {
    const at = { lastRequestAt: 1_000, ttl: null }
    for (const value of [
      'openai/gpt-5.5',
      'anthropic/claude-sonnet-5',
      'Anthropic/claude-opus-5',
    ]) {
      expect(cacheExpiry(session('opencode', at, [model(value)]), null)).toMatchObject({
        ttl: 5 * MINUTE,
        expiresAt: 1_000 + 5 * MINUTE,
        estimate: true,
      })
    }
    for (const config of [
      [model('opencode-go/GLM-5.3')],
      [model('openrouter/openai/gpt-5.5')],
      [model('gpt-5.5')],
      [],
    ]) {
      expect(cacheExpiry(session('opencode', at, config), null)).toEqual({
        lastRequestAt: 1_000,
        ttl: null,
        expiresAt: null,
        estimate: false,
      })
    }
  })

  it('estimates nothing for an agent without a known provider', () => {
    expect(
      cacheExpiry(session('fake-agent', { lastRequestAt: 1_000, ttl: null }), null),
    ).toMatchObject({
      expiresAt: null,
      estimate: false,
    })
  })
})

describe('cachePhase', () => {
  const expiresAt = 10 * MINUTE

  it('is warm, ending in its last minute, then expired', () => {
    expect(cachePhase(expiresAt, 0)).toBe('warm')
    expect(cachePhase(expiresAt, expiresAt - MINUTE - 1)).toBe('warm')
    expect(cachePhase(expiresAt, expiresAt - MINUTE)).toBe('ending')
    expect(cachePhase(expiresAt, expiresAt - 1)).toBe('ending')
    expect(cachePhase(expiresAt, expiresAt)).toBe('expired')
    expect(cachePhase(expiresAt, expiresAt + 60 * MINUTE)).toBe('expired')
  })

  it('names when the phase changes next, and nothing once expired', () => {
    expect(nextPhaseIn(expiresAt, 0)).toBe(9 * MINUTE)
    expect(nextPhaseIn(expiresAt, expiresAt - MINUTE)).toBe(MINUTE)
    expect(nextPhaseIn(expiresAt, expiresAt - 30_000)).toBe(30_000)
    expect(nextPhaseIn(expiresAt, expiresAt)).toBeNull()
  })
})
