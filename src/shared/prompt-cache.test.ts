import { describe, expect, it } from 'vitest'
import type { AgentAccount } from './agent-host'
import { cacheExpiry, cachePhase, endingWindow, expiryOf, nextPhaseIn } from './prompt-cache'
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

  it("estimates Codex's from OpenAI's shortest documented retention for its model", () => {
    const at = { lastRequestAt: 1_000, ttl: null }
    const apiKey: AgentAccount = { kind: 'api_key', label: 'OpenAI API key', email: null }
    for (const value of ['gpt-5.5', 'gpt-5.6-sol/high', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-5.10']) {
      const codex = session('codex', at, [model(value)])
      for (const account of [chatGpt, apiKey]) {
        expect(cacheExpiry(codex, account)).toEqual({
          lastRequestAt: 1_000,
          ttl: 30 * MINUTE,
          expiresAt: 1_000 + 30 * MINUTE,
          estimate: true,
        })
      }
    }
    for (const config of [[model('gpt-5.4')], [model('gpt-5')], [model('o3')], []]) {
      expect(cacheExpiry(session('codex', at, config), chatGpt)).toMatchObject({
        ttl: 5 * MINUTE,
        expiresAt: 1_000 + 5 * MINUTE,
        estimate: true,
      })
    }
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
    for (const value of ['openai/gpt-5.5', 'OpenAI/gpt-6-astra']) {
      expect(cacheExpiry(session('opencode', at, [model(value)]), null)).toMatchObject({
        ttl: 30 * MINUTE,
        expiresAt: 1_000 + 30 * MINUTE,
        estimate: true,
      })
    }
    for (const value of [
      'openai/gpt-5.4',
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

describe('expiryOf', () => {
  it('takes the model by name, as a session summary carries it', () => {
    const cache = { lastRequestAt: 1_000, ttl: null }
    expect(expiryOf('opencode', cache, 'anthropic/claude-opus-5-5', null)).toEqual({
      lastRequestAt: 1_000,
      ttl: 5 * MINUTE,
      expiresAt: 1_000 + 5 * MINUTE,
      estimate: true,
    })
    expect(expiryOf('opencode', cache, null, null)?.expiresAt).toBeNull()
    expect(expiryOf('claude-code', null, null, null)).toBeNull()
  })
})

describe('endingWindow', () => {
  it('is the last five minutes of an hour-long cache and the last minute of a shorter one', () => {
    expect(endingWindow(60 * MINUTE)).toBe(5 * MINUTE)
    expect(endingWindow(30 * MINUTE)).toBe(MINUTE)
    expect(endingWindow(5 * MINUTE)).toBe(MINUTE)
  })
})

describe('cachePhase', () => {
  const expiresAt = 10 * MINUTE

  it('is warm, ending in its last minutes, then expired', () => {
    expect(cachePhase(expiresAt, MINUTE, 0)).toBe('warm')
    expect(cachePhase(expiresAt, MINUTE, expiresAt - MINUTE - 1)).toBe('warm')
    expect(cachePhase(expiresAt, MINUTE, expiresAt - MINUTE)).toBe('ending')
    expect(cachePhase(expiresAt, MINUTE, expiresAt - 1)).toBe('ending')
    expect(cachePhase(expiresAt, MINUTE, expiresAt)).toBe('expired')
    expect(cachePhase(expiresAt, MINUTE, expiresAt + 60 * MINUTE)).toBe('expired')
    expect(cachePhase(expiresAt, 5 * MINUTE, expiresAt - 5 * MINUTE)).toBe('ending')
    expect(cachePhase(expiresAt, 5 * MINUTE, expiresAt - 5 * MINUTE - 1)).toBe('warm')
  })

  it('names when the phase changes next, and nothing once expired', () => {
    expect(nextPhaseIn(expiresAt, MINUTE, 0)).toBe(9 * MINUTE)
    expect(nextPhaseIn(expiresAt, MINUTE, expiresAt - MINUTE)).toBe(MINUTE)
    expect(nextPhaseIn(expiresAt, MINUTE, expiresAt - 30_000)).toBe(30_000)
    expect(nextPhaseIn(expiresAt, MINUTE, expiresAt)).toBeNull()
    expect(nextPhaseIn(expiresAt, 5 * MINUTE, 0)).toBe(5 * MINUTE)
  })
})
