import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { McpSpec } from '@shared/marketplace'
import { Answers, answersFile, MAX_ANSWER_BYTES, parseAnswersFile, specDigest } from './answers'

const spec: McpSpec = {
  type: 'stdio',
  command: 'npx',
  args: ['-y', 'pkg@1.0.0'],
  env: [{ name: 'API_KEY', input: true, secret: true, required: true }],
}
const init = { protocolVersion: '2025-06-18', capabilities: { tools: {} } }

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kettu-answers-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('what a command server answered last', () => {
  it('belongs to what the server runs, not to the values of its keys', () => {
    const digest = specDigest(spec)
    expect(specDigest({ ...spec, env: [{ name: 'API_KEY', value: 'other' }] })).toBe(digest)
    expect(specDigest({ ...spec, args: ['-y', 'pkg@2.0.0'] })).not.toBe(digest)
    expect(specDigest({ ...spec, env: [] })).not.toBe(digest)
  })

  it('is kept on disk without a key, and read back for the same command only', async () => {
    const file = answersFile(dir, () => {})
    const answers = new Answers(file)
    const digest = specDigest(spec)
    answers.opened('srv', digest, 'legacy', init)
    answers.listed('srv', digest, 'tools/list', { tools: [{ name: 'search' }] })
    await answers.flush()
    const text = await readFile(file.file, 'utf8')
    expect(text).not.toContain('API_KEY":"')
    const again = new Answers(answersFile(dir, () => {}))
    await again.load()
    expect(again.get('srv', digest)).toMatchObject({
      era: 'legacy',
      init,
      lists: { 'tools/list': { tools: [{ name: 'search' }] } },
    })
    expect(again.get('srv', specDigest({ ...spec, command: 'uvx' }))).toBeNull()
  })

  it('forgets a list the server said changed, and servers the library no longer has', () => {
    const answers = new Answers(null)
    const digest = specDigest(spec)
    answers.opened('srv', digest, 'legacy', init)
    answers.opened('gone', digest, 'legacy', init)
    answers.listed('srv', digest, 'tools/list', { tools: [] })
    answers.listed('srv', digest, 'prompts/list', { prompts: [] })
    answers.stale('srv', ['tools/list'])
    expect(Object.keys(answers.get('srv', digest)!.lists)).toEqual(['prompts/list'])
    answers.keep(new Set(['srv']))
    expect(answers.get('gone', digest)).toBeNull()
  })

  it('keeps no answer too large to read back quickly', () => {
    const answers = new Answers(null)
    const digest = specDigest(spec)
    answers.opened('srv', digest, 'legacy', init)
    answers.listed('srv', digest, 'tools/list', { tools: ['x'.repeat(MAX_ANSWER_BYTES)] })
    expect(answers.get('srv', digest)!.lists['tools/list']).toBeUndefined()
  })

  it('drops an entry it cannot read on its own, keeping the others', () => {
    const digest = specDigest(spec)
    const good = { spec: digest, era: 'modern', init: {}, lists: { 'tools/list': {} }, at: 1 }
    expect(
      parseAnswersFile({
        servers: {
          good,
          era: { ...good, era: 'future' },
          spec: { ...good, spec: 'short' },
          lists: { ...good, lists: { 'secrets/list': {} } },
        },
      }),
    ).toEqual({
      version: 1,
      servers: { good, era: undefined, spec: undefined, lists: { ...good, lists: {} } },
    } as never)
    expect(parseAnswersFile({ servers: [] })).toBe('servers is not an object')
  })
})
