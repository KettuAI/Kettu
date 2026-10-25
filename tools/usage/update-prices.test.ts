import { describe, expect, it } from 'vitest'
import { cutPrices } from './update-prices.mjs'

const chat = (input: number, output: number, more: Record<string, unknown> = {}) => ({
  mode: 'chat',
  input_cost_per_token: input,
  output_cost_per_token: output,
  ...more,
})

describe('cutPrices', () => {
  it('keeps the chat models with both an input and an output price', () => {
    const cut = cutPrices(
      {
        chat: chat(1e-6, 2e-6),
        embedding: { mode: 'embedding', input_cost_per_token: 1e-7, output_cost_per_token: 0 },
        'no-output': { mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: null },
      },
      '2026-10-25',
    )
    expect(cut).toEqual({
      asOf: '2026-10-25',
      models: {
        chat: { input: 1e-6, output: 2e-6, cacheRead: 0, cacheWrite: 0 },
      },
    })
  })

  it('keys by normalizeModel and lets an unprefixed name win', () => {
    const cut = cutPrices(
      {
        'openai/gpt-5': chat(9e-6, 9e-6),
        'gpt-5': chat(1e-6, 2e-6),
        'anthropic/claude-opus-4-8': chat(3e-6, 4e-6),
        'claude-opus-4-8-20260101': chat(5e-6, 6e-6),
        'claude-opus-4-8[1m]': chat(7e-6, 8e-6),
      },
      '2026-10-25',
    )
    // The date and the context tag come off; the unprefixed `claude-opus-4-8` is the dated name.
    expect(cut.models['gpt-5']?.input).toBe(1e-6)
    expect(cut.models['claude-opus-4-8']?.input).toBe(5e-6)
    expect(Object.keys(cut.models).sort()).toEqual(['claude-opus-4-8', 'gpt-5'])
  })

  it('takes the four prices and the hour where LiteLLM gives one', () => {
    const cut = cutPrices(
      {
        priced: chat(1e-6, 2e-6, {
          cache_read_input_token_cost: 1e-7,
          cache_creation_input_token_cost: 1.25e-6,
          cache_creation_input_token_cost_above_1hr: 2e-6,
        }),
        plain: chat(3e-6, 4e-6),
      },
      '2026-10-25',
    )
    expect(cut.models.priced).toEqual({
      input: 1e-6,
      output: 2e-6,
      cacheRead: 1e-7,
      cacheWrite: 1.25e-6,
      cacheWrite1h: 2e-6,
    })
    expect(cut.models.plain).toEqual({
      input: 3e-6,
      output: 4e-6,
      cacheRead: 0,
      cacheWrite: 0,
    })
  })

  it('sorts the models, so the same list cuts the same file', () => {
    const cut = cutPrices({ b: chat(1e-6, 1e-6), a: chat(2e-6, 2e-6) }, '2026-10-25')
    expect(Object.keys(cut.models)).toEqual(['a', 'b'])
  })
})
