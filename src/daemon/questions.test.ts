import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { terminalQuestions, type Questions } from './questions'

let open: Questions[] = []

function questions(): { input: PassThrough; output: () => string; questions: Questions } {
  const input = new PassThrough()
  const output = new PassThrough()
  let written = ''
  output.on('data', (chunk: Buffer) => (written += chunk.toString()))
  const asked = terminalQuestions(input, output)
  open.push(asked)
  return { input, output: () => written, questions: asked }
}

afterEach(() => {
  for (const asked of open) asked.close()
  open = []
})

describe('terminalQuestions', () => {
  it('keeps answers that arrive ahead of their questions', async () => {
    const { input, questions: asked } = questions()
    input.write('y\nPhone\n')
    expect(await asked.ask('Add this device? [y/N] ')).toBe('y')
    expect(await asked.ask('Name: ', 'iPhone')).toBe('Phone')
  })

  it('waits for an answer typed after the question', async () => {
    const { input, output, questions: asked } = questions()
    const answer = asked.ask('Add this device? [y/N] ')
    setTimeout(() => input.write('yes\n'), 10)
    expect(await answer).toBe('yes')
    expect(output()).toBe('Add this device? [y/N] ')
  })

  it('shows what would be typed when input is not a terminal', async () => {
    const { input, output, questions: asked } = questions()
    input.write('\n')
    expect(await asked.ask('Name: ', 'iPhone')).toBe('')
    expect(output()).toBe('Name: [iPhone] ')
  })

  it('answers the lines left, then null once input ends', async () => {
    const { input, questions: asked } = questions()
    input.end('y\n')
    expect(await asked.ask('Add this device? [y/N] ')).toBe('y')
    expect(await asked.ask('Name: ', 'iPhone')).toBeNull()
  })

  it('answers null when closed with a question pending', async () => {
    const { questions: asked } = questions()
    const answer = asked.ask('Add this device? [y/N] ')
    asked.close()
    expect(await answer).toBeNull()
  })
})
