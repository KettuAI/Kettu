import { describe, expect, it } from 'vitest'
import type { CapabilityContext } from './dispatcher'
import {
  answerJson,
  IMAGES,
  PER_MINUTE,
  sampleCapability,
  type SampleDeps,
  type SampleQuestion,
} from './sample-capability'

const ID = 'art_01J9Z3K4V5W6X7Y8Z9A0B1C2D3'
const PNG = 'data:image/png;base64,iVBORw0KGgo='

function setup(answer: (q: SampleQuestion) => Promise<string> = async () => 'Hi', now = () => 0) {
  const asked: SampleQuestion[] = []
  const deps: SampleDeps = {
    agentFor: async (project) => (project ? { id: 'fake-agent', name: 'Fake Agent' } : null),
    answer: async (_, question) => {
      asked.push(question)
      return answer(question)
    },
    now,
  }
  const sample = sampleCapability(deps)
  const ask = async (args: unknown, project: string | null = '/p') => {
    const events: unknown[] = []
    const ctx: CapabilityContext = {
      artifactId: ID,
      project,
      version: 1,
      declared: ['sample'],
      client: 'desktop',
      signal: new AbortController().signal,
    }
    await sample.stream!(ctx, 'ask', args, (event) => events.push(event))
    return events
  }
  const code = (args: unknown) =>
    ask(args).then(
      () => 'ok',
      (error: { code: string }) => error.code,
    )
  return { sample, ask, code, asked }
}

describe('the sample capability', () => {
  it("streams the agent's text, then the whole answer", async () => {
    const { ask, asked } = setup(async (q) => {
      q.onText('H')
      q.onText('i')
      return 'Hi'
    })
    expect(await ask({ prompt: 'Say hi', images: [PNG] })).toEqual([
      { type: 'text', text: 'H' },
      { type: 'text', text: 'i' },
      { type: 'answer', text: 'Hi' },
    ])
    expect(asked[0]!.prompt).toEqual([
      { type: 'text', text: 'Say hi' },
      { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
    ])
  })

  it('gives the parsed JSON for a json question, and fails when the answer holds none', async () => {
    const fenced = setup(async () => 'Here:\n```json\n{"a": [1]}\n```')
    expect(await fenced.ask({ prompt: 'List', format: 'json' })).toEqual([
      { type: 'answer', text: 'Here:\n```json\n{"a": [1]}\n```', json: { a: [1] } },
    ])
    expect(fenced.asked[0]!.prompt[0]).toMatchObject({ text: expect.stringMatching(/List$/) })
    expect(await setup(async () => 'no').code({ prompt: 'List', format: 'json' })).toBe('failed')
    expect(answerJson('  [1, 2] ')).toEqual([1, 2])
  })

  it('refuses what is not a question it takes', async () => {
    const { code, asked } = setup()
    expect(await code({})).toBe('invalid')
    expect(await code({ prompt: '  ' })).toBe('invalid')
    expect(await code({ prompt: 'x'.repeat(100_001) })).toBe('too_large')
    expect(await code({ prompt: 'q', format: 'xml' })).toBe('invalid')
    expect(await code({ prompt: 'q', images: ['https://example.com/a.png'] })).toBe('invalid')
    expect(await code({ prompt: 'q', images: ['data:image/svg+xml;base64,PHN2Zz4='] })).toBe(
      'invalid',
    )
    expect(await code({ prompt: 'q', images: Array(IMAGES + 1).fill(PNG) })).toBe('invalid')
    expect(
      await code({ prompt: 'q', images: [`data:image/png;base64,${'A'.repeat(7_000_000)}`] }),
    ).toBe('too_large')
    expect(asked).toEqual([])
  })

  it('is not there without an agent that can answer, as under No project', async () => {
    const { sample } = setup()
    const ctx = (project: string | null) =>
      ({ artifactId: ID, project, version: 1, declared: [], client: 'desktop' }) as never
    expect(await sample.available!(ctx(null))).toBe(false)
    expect(await sample.available!(ctx('/p'))).toBe(true)
  })

  it('takes at most two questions at once and ten a minute from an artifact', async () => {
    let at = 0
    const waiting: (() => void)[] = []
    const slow = setup(
      () => new Promise<string>((resolve) => waiting.push(() => resolve('ok'))),
      () => at,
    )
    const first = slow.ask({ prompt: 'a' })
    const second = slow.ask({ prompt: 'b' })
    expect(await slow.code({ prompt: 'c' })).toBe('rate_limited')
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (const done of waiting) done()
    await Promise.all([first, second])
    const quick = setup(undefined, () => at)
    for (let i = 0; i < PER_MINUTE; i++) await quick.ask({ prompt: 'q' })
    expect(await quick.code({ prompt: 'q' })).toBe('rate_limited')
    at += 60_001
    expect(await quick.code({ prompt: 'q' })).toBe('ok')
  })
})
