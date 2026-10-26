import { describe, expect, it } from 'vitest'
import { chooseScenario, delayScale } from './options.ts'

describe('chooseScenario', () => {
  it('runs basic-turn for plain text', () => {
    const choice = chooseScenario('Why does the login test fail?', {})
    expect(choice.scenario).toBe('basic-turn')
    expect(choice.text).toBe('Why does the login test fail?')
  })

  it('reads /scenario <name> and /<name> with flags', () => {
    expect(chooseScenario('/scenario long-stream --rate 500', {})).toMatchObject({
      scenario: 'long-stream',
      options: { rate: 500 },
      text: '',
    })
    expect(chooseScenario('/long-stream --rate=50 --size 10k', {}).options).toMatchObject({
      rate: 50,
      size: 10 * 1024,
    })
    expect(chooseScenario('/cancel --ignore-cancel', {}).options.ignoreCancel).toBe(true)
    expect(chooseScenario('/usage --plain', {}).options.plain).toBe(true)
    expect(chooseScenario('/usage', {}).options.plain).toBe(false)
    expect(chooseScenario('/compact', {}).scenario).toBe('compact')
  })

  it('falls back to the environment, and flags win over it', () => {
    const env = { FAKE_AGENT_SCENARIO: 'tool-storm', FAKE_AGENT_COUNT: '20', FAKE_AGENT_RATE: '9' }
    expect(chooseScenario('anything', env)).toMatchObject({
      scenario: 'tool-storm',
      options: { count: 20, rate: 9 },
    })
    expect(chooseScenario('/tool-storm --count 3', env).options.count).toBe(3)
  })

  it('treats unknown commands as text', () => {
    expect(chooseScenario('/nope', {}).scenario).toBe('basic-turn')
  })

  it('defaults a bare --withdraw to 1.5 s', () => {
    expect(chooseScenario('/permission --withdraw', {}).options.withdrawMs).toBe(1500)
    expect(chooseScenario('/permission --withdraw 10', {}).options.withdrawMs).toBe(10)
    expect(chooseScenario('/permission', {}).options.withdrawMs).toBeNull()
  })

  it('reads how long requests holds its turn and when it answers by itself', () => {
    expect(chooseScenario('/requests --hold 300 --then 50', {}).options).toMatchObject({
      holdMs: 300,
      thenMs: 50,
    })
    expect(chooseScenario('/requests', {}).options).toMatchObject({
      holdMs: 0,
      thenMs: null,
      atEnd: false,
    })
    expect(chooseScenario('/requests --at-end', {}).options.atEnd).toBe(true)
  })

  it('reads whether error writes anything before it fails', () => {
    expect(chooseScenario('/error', {}).options.silent).toBe(false)
    expect(chooseScenario('/error --silent', {}).options.silent).toBe(true)
    expect(chooseScenario('/crash --silent', {}).options.silent).toBe(true)
    expect(chooseScenario('/error --silent --hold 500', {}).options.holdMs).toBe(500)
  })

  it('reads whether reasoning sends short summaries', () => {
    expect(chooseScenario('/reasoning --summaries', {}).options.summaries).toBe(true)
    expect(chooseScenario('/reasoning', {}).options.summaries).toBe(false)
  })

  it('sizes a large history from --entries, else the environment, else 1,000', () => {
    const env = { FAKE_AGENT_HISTORY_ENTRIES: '2000' }
    expect(chooseScenario('/large-history --entries 4000', env).options.entries).toBe(4000)
    expect(chooseScenario('/large-history', env).options.entries).toBe(2000)
    expect(chooseScenario('/large-history', {}).options.entries).toBe(1000)
  })
})

describe('delayScale', () => {
  it('defaults to 1 and accepts 0', () => {
    expect(delayScale({})).toBe(1)
    expect(delayScale({ FAKE_AGENT_DELAY_SCALE: '0' })).toBe(0)
  })
})
