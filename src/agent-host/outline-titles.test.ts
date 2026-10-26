import { describe, expect, it } from 'vitest'
import type { ConfigOption } from '@shared/thread'
import { parseTitles, pickModel, summaryPrompt, SUMMARY_MESSAGES } from './outline-titles'

const models = (...choices: [string, string][]): ConfigOption[] => [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    value: choices[0]![0],
    choices: choices.map(([value, name]) => ({ value, name })),
  },
]

describe('the outline titles', () => {
  it('picks the first small model, by name or value, else the session model', () => {
    expect(
      pickModel(
        models(['default', 'Default (Opus)'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku 4.5']),
        'sonnet',
      ),
    ).toBe('haiku')
    expect(pickModel(models(['gpt-5', 'GPT-5'], ['gpt-5-mini', 'GPT-5']), null)).toBe('gpt-5-mini')
    expect(pickModel(models(['a', 'Gemini 2.5 Flash']), null)).toBe('a')
    // Gemini holds "mini", but not as a word.
    expect(pickModel(models(['google/gemini-2.5-pro', 'Gemini 2.5 Pro']), 'x')).toBe('x')
    expect(pickModel([], 'sonnet')).toBe('sonnet')
    expect(pickModel([], null)).toBeNull()
  })

  it('asks for the newest messages first, each cut and named by its position', () => {
    const messages = Array.from({ length: SUMMARY_MESSAGES + 20 }, (_, pos) => ({
      pos,
      text: pos === 119 ? 'y'.repeat(700) : `message ${pos}`,
    }))
    const { positions, prompt } = summaryPrompt(messages)
    expect(positions).toHaveLength(SUMMARY_MESSAGES)
    expect(positions[0]).toBe(119)
    expect(positions.at(-1)).toBe(20)
    expect(prompt).toMatch(/^Write a title of at most six words/)
    const list = JSON.parse(prompt.slice(prompt.indexOf('['))) as { id: string; text: string }[]
    expect(list[0]).toEqual({ id: '119', text: 'y'.repeat(500) })
    expect(list[1]).toEqual({ id: '118', text: 'message 118' })
  })

  it('cuts each message at the cut it is given', () => {
    const { prompt } = summaryPrompt([{ pos: 0, text: 'z'.repeat(300) }], 120)
    const list = JSON.parse(prompt.slice(prompt.indexOf('['))) as { id: string; text: string }[]
    expect(list).toEqual([{ id: '0', text: 'z'.repeat(120) }])
  })

  it('reads the titles from plain or fenced JSON, for the ids asked, cut to 60 characters', () => {
    const asked = new Set([3, 7])
    expect(parseTitles('{"3": "Fix login", "7": "Add tests"}', asked)).toEqual([
      { pos: 3, title: 'Fix login' },
      { pos: 7, title: 'Add tests' },
    ])
    expect(
      parseTitles('Here you go:\n```json\n{"3": " Fix\\nlogin ", "9": "Unasked"}\n```', asked),
    ).toEqual([{ pos: 3, title: 'Fix login' }])
    expect(parseTitles(`{"7": "${'z'.repeat(80)}", "3": 4, "x": "No"}`, asked)).toEqual([
      { pos: 7, title: 'z'.repeat(60) },
    ])
    expect(parseTitles('I cannot do that.', asked)).toBeNull()
    expect(parseTitles('{not json}', asked)).toBeNull()
    expect(parseTitles('["Fix login"]', asked)).toBeNull()
  })
})
