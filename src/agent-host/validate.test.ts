import { describe, expect, it } from 'vitest'
import { HOST_METHODS } from '@shared/agent-host'
import { createValidators, promptContent } from './validate'

const posix = createValidators('darwin')
const windows = createValidators('win32')

function rejects(run: () => unknown): void {
  expect(run).toThrow(expect.objectContaining({ code: 'invalid_params' }))
}

describe('createValidators', () => {
  it('has a validator for every method', () => {
    expect(Object.keys(posix).sort()).toEqual([...HOST_METHODS].sort())
  })

  it('accepts methods without params with nothing, null or an empty object', () => {
    expect(posix['agents.list'](undefined)).toBeUndefined()
    expect(posix['agents.list'](null)).toBeUndefined()
    expect(posix['agents.list']({})).toBeUndefined()
    rejects(() => posix['agents.list']({ extra: 1 }))
  })

  it('returns only the known fields', () => {
    expect(posix['sessions.open']({ sessionId: 's', other: 'x' })).toEqual({ sessionId: 's' })
    expect(posix['agents.check']({})).toEqual({})
    expect(posix['agents.check']({ agentId: 'codex' })).toEqual({ agentId: 'codex' })
  })

  it('checks types, required fields and lengths', () => {
    rejects(() => posix['sessions.open']({}))
    rejects(() => posix['sessions.open']({ sessionId: 1 }))
    rejects(() => posix['sessions.open']({ sessionId: '' }))
    rejects(() => posix['sessions.open']({ sessionId: 'x'.repeat(257) }))
    rejects(() => posix['sessions.open']('s'))
    rejects(() => posix['sessions.open']([]))
    rejects(() => posix['agents.logout']({ agentId: 'gemini' }))
  })

  it('wants absolute paths by the platform rules', () => {
    expect(posix['projects.add']({ path: '/Users/me/app' })).toEqual({ path: '/Users/me/app' })
    rejects(() => posix['projects.add']({ path: 'app' }))
    rejects(() => posix['projects.add']({ path: 'C:\\app' }))
    rejects(() => posix['projects.add']({ path: '/app\0/x' }))
    expect(windows['projects.add']({ path: 'C:\\app' })).toEqual({ path: 'C:\\app' })
    expect(windows['projects.add']({ path: '\\\\server\\share\\app' })).toMatchObject({})
    rejects(() => windows['projects.add']({ path: '\\app' }))
    rejects(() => windows['sessions.create']({ agentId: 'codex', projectPath: 'app' }))
  })

  it('keeps optional fields out when absent', () => {
    expect(
      posix['sessions.create']({ agentId: 'codex', projectPath: '/p', parentId: undefined }),
    ).toEqual({ agentId: 'codex', projectPath: '/p' })
    expect(
      posix['agents.listSessions']({ agentId: 'codex', projectPath: '/p', cursor: '10' }),
    ).toEqual({ agentId: 'codex', projectPath: '/p', cursor: '10' })
  })

  it('takes a string or a boolean for a config value', () => {
    const v = posix['sessions.setConfigOption']
    expect(v({ sessionId: 's', optionId: 'fast', value: false })).toMatchObject({ value: false })
    expect(v({ sessionId: 's', optionId: 'model', value: 'deep' })).toMatchObject({
      value: 'deep',
    })
    rejects(() => v({ sessionId: 's', optionId: 'model', value: 3 }))
    rejects(() => v({ sessionId: 's', optionId: 'model', value: '' }))
  })

  it('takes only GitHub pull request URLs', () => {
    const v = posix['git.pullRequest']
    expect(v({ url: 'https://github.com/a/b/pull/12' })).toEqual({
      url: 'https://github.com/a/b/pull/12',
    })
    rejects(() => v({ url: 'https://example.com/a/b/pull/12' }))
    rejects(() => v({ url: 'javascript:alert(1)' }))
  })
})

describe('promptContent', () => {
  const png = Buffer.from('fake image').toString('base64')

  it('keeps texts, images and links', () => {
    expect(
      promptContent([
        { type: 'text', text: 'Look' },
        { type: 'ref', ref: { kind: 'image', mimeType: 'image/png', data: png } },
        { type: 'ref', ref: { kind: 'link', uri: 'file:///a.ts', name: 'a.ts', extra: 1 } },
      ]),
    ).toEqual([
      { type: 'text', text: 'Look' },
      { type: 'ref', ref: { kind: 'image', mimeType: 'image/png', data: png } },
      { type: 'ref', ref: { kind: 'link', uri: 'file:///a.ts', name: 'a.ts' } },
    ])
  })

  it('rejects empty prompts and content the agent cannot take', () => {
    rejects(() => promptContent([]))
    rejects(() => promptContent([{ type: 'text', text: '   ' }]))
    rejects(() => promptContent('hello'))
    rejects(() => promptContent([{ type: 'audio' }]))
    rejects(() => promptContent([{ type: 'ref', ref: { kind: 'unsupported', label: 'x' } }]))
    rejects(() =>
      promptContent([{ type: 'ref', ref: { kind: 'image', mimeType: 'text/html', data: png } }]),
    )
    rejects(() =>
      promptContent([{ type: 'ref', ref: { kind: 'image', mimeType: 'image/png', data: '<>' } }]),
    )
  })

  it('limits the prompt to 10 MB in all', () => {
    const half = 'a'.repeat(5 * 1024 * 1024)
    expect(promptContent([{ type: 'text', text: half }])).toHaveLength(1)
    rejects(() =>
      promptContent([
        { type: 'text', text: half },
        { type: 'text', text: half },
        { type: 'text', text: 'one more byte' },
      ]),
    )
    // Counted in UTF-8 bytes, not characters.
    rejects(() => promptContent([{ type: 'text', text: '\u00e9'.repeat(5 * 1024 * 1024 + 1) }]))
  })
})
