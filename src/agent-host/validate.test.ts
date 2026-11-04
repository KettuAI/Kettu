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
    rejects(() => posix['agents.logout']({ agentId: 'unknown-agent' }))
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
    expect(posix['sessions.create']({ agentId: 'codex', projectPath: null })).toEqual({
      agentId: 'codex',
      projectPath: null,
    })
    rejects(() => posix['sessions.create']({ agentId: 'codex' }))
    expect(
      posix['agents.listSessions']({ agentId: 'codex', projectPath: '/p', cursor: '10' }),
    ).toEqual({ agentId: 'codex', projectPath: '/p', cursor: '10' })
  })

  it('checks the file requests', () => {
    expect(posix['files.list']({ projectPath: '/p', extra: 1 })).toEqual({ projectPath: '/p' })
    rejects(() => posix['files.list']({ projectPath: 'p' }))

    const read = posix['files.read']
    expect(read({ projectPath: '/p', path: 'src/a.ts', extra: 1 })).toEqual({
      projectPath: '/p',
      path: 'src/a.ts',
    })
    expect(read({ projectPath: '/p', path: 'logo.svg', asText: true })).toEqual({
      projectPath: '/p',
      path: 'logo.svg',
      asText: true,
    })
    rejects(() => read({ projectPath: '/p', path: 'logo.svg', asText: 'yes' }))
    rejects(() => read({ projectPath: '/p' }))
    rejects(() => read({ projectPath: '/p', path: '' }))
    rejects(() => read({ projectPath: '/p', path: 3 }))
    rejects(() => read({ projectPath: '/p', path: '/etc/hosts' }))
    rejects(() => read({ projectPath: '/p', path: 'a\0b' }))
    rejects(() => read({ projectPath: '/p', path: 'x'.repeat(32_768) }))
    rejects(() => read({ projectPath: 'p', path: 'a.ts' }))
    rejects(() => windows['files.read']({ projectPath: 'C:\\p', path: 'C:\\Windows\\a.ini' }))
    rejects(() => windows['files.read']({ projectPath: 'C:\\p', path: '\\\\server\\share\\a' }))
    rejects(() => windows['files.read']({ projectPath: 'C:\\p', path: '\\Windows\\a.ini' }))
    expect(windows['files.read']({ projectPath: 'C:\\p', path: 'src/a.ts' })).toMatchObject({})

    // A thread may name any path; the host decides what it grants.
    const media = posix['media.open']
    expect(media({ projectPath: '/p', path: '/etc/a b.png', sessionId: 's', extra: 1 })).toEqual({
      projectPath: '/p',
      path: '/etc/a b.png',
      sessionId: 's',
    })
    rejects(() => media({ projectPath: '/p', path: '/a.png' }))
    rejects(() => media({ projectPath: 'p', path: '/a.png', sessionId: 's' }))
    rejects(() => media({ projectPath: '/p', path: 'a\0b.png', sessionId: 's' }))
    rejects(() => media({ projectPath: '/p', path: '', sessionId: 's' }))
    // A device's remote host may ask without a session, for a file in the project only.
    const authorize = posix['media.authorize']
    expect(authorize({ projectPath: '/p', path: 'a.png', extra: 1 })).toEqual({
      projectPath: '/p',
      path: 'a.png',
    })
    expect(authorize({ projectPath: '/p', path: '/a.png', sessionId: 's' })).toEqual({
      projectPath: '/p',
      path: '/a.png',
      sessionId: 's',
    })
    rejects(() => authorize({ projectPath: '/p', path: 'a.png', sessionId: 3 }))
    rejects(() => authorize({ projectPath: '/p', path: 'a.png', sessionId: '' }))
    rejects(() => authorize({ projectPath: '/p', path: 'a\0b.png' }))

    const search = posix['files.search']
    expect(search({ projectPath: '/p', query: 'needle', extra: 1 })).toEqual({
      projectPath: '/p',
      query: 'needle',
    })
    rejects(() => search({ projectPath: '/p', query: '' }))
    rejects(() => search({ projectPath: '/p', query: 'x'.repeat(4_097) }))
    rejects(() => search({ projectPath: '/p' }))
    rejects(() => search({ projectPath: 'p', query: 'x' }))

    const write = posix['files.write']
    expect(write({ projectPath: '/p', path: 'a.ts', text: 'x', version: 'v1', extra: 1 })).toEqual({
      projectPath: '/p',
      path: 'a.ts',
      text: 'x',
      version: 'v1',
    })
    expect(write({ projectPath: '/p', path: 'a.ts', text: '', version: null })).toMatchObject({
      text: '',
      version: null,
    })
    rejects(() => write({ projectPath: '/p', path: 'a.ts', text: 'x' }))
    rejects(() => write({ projectPath: '/p', path: 'a.ts', text: 1, version: null }))
    rejects(() => write({ projectPath: '/p', path: 'a.ts', text: 'x', version: '' }))
    rejects(() => write({ projectPath: '/p', path: '/etc/hosts', text: 'x', version: null }))
    rejects(() =>
      write({ projectPath: '/p', path: 'a.ts', text: 'x'.repeat(1024 * 1024 + 1), version: null }),
    )
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

describe('attachments', () => {
  const ref = (id: string, extra: Record<string, unknown> = {}) => ({
    type: 'ref',
    ref: { kind: 'attachment', attachment: { id, ...extra } },
  })

  it('reads only the id of an attachment ref', () => {
    const [item] = promptContent([ref('a1', { name: 'secret.png', uri: 'file:///etc/passwd' })])
    expect(item).toEqual({
      type: 'ref',
      ref: {
        kind: 'attachment',
        attachment: {
          id: 'a1',
          type: 'image',
          name: '',
          uri: null,
          mimeType: null,
          size: null,
          sent: null,
          thumb: null,
          blob: null,
        },
      },
    })
    // A message of attachments alone can be sent.
    expect(promptContent([ref('a1'), ref('a2')])).toHaveLength(2)
    rejects(() => promptContent([{ type: 'ref', ref: { kind: 'attachment' } }]))
    rejects(() => promptContent([ref('')]))
  })

  it('takes at most 20 attachments in a prompt', () => {
    const refs = Array.from({ length: 20 }, (_, i) => ref(`a${i}`))
    expect(promptContent(refs)).toHaveLength(20)
    rejects(() => promptContent([...refs, ref('a20')]))
  })

  it('checks what attachments.add is handed', () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer
    const source = { bytes, mimeType: 'image/png', name: 'Image 1' }
    const thumb = 'data:image/webp;base64,AAAA'
    expect(posix['attachments.add']({ source: { ...source, path: '/x' }, thumb })).toEqual({
      source,
      thumb,
    })
    expect(posix['attachments.add']({ source, thumb: null })).toEqual({ source, thumb: null })
    rejects(() => posix['attachments.add']({ source: { ...source, bytes: [1, 2, 3] }, thumb }))
    rejects(() => posix['attachments.add']({ source: { ...source, bytes: new ArrayBuffer(0) } }))
    rejects(() =>
      posix['attachments.add']({
        source: { ...source, bytes: new ArrayBuffer(20 * 1024 * 1024 + 1) },
        thumb,
      }),
    )
    rejects(() => posix['attachments.add']({ source, thumb: 'https://example.com/t.png' }))
    rejects(() => posix['attachments.add']({ source, thumb: 'data:image/svg+xml;base64,AAAA' }))
    rejects(() =>
      posix['attachments.add']({ source, thumb: `data:image/webp;base64,${'A'.repeat(300_000)}` }),
    )
  })

  it('takes a grant by its id alone, never a path', () => {
    const thumb = 'data:image/webp;base64,AAAA'
    expect(
      posix['attachments.add']({ source: { grantId: 'g1', path: '/etc/passwd' }, thumb: null }),
    ).toEqual({ source: { grantId: 'g1' }, thumb: null })
    expect(
      posix['attachments.add']({
        source: { grantId: 'g1', bytes: new Uint8Array([1]).buffer },
        thumb,
      }),
    ).toEqual({ source: { grantId: 'g1' }, thumb })
    rejects(() => posix['attachments.add']({ source: { grantId: 7 }, thumb: null }))
    rejects(() => posix['attachments.add']({ source: { path: '/etc/passwd' }, thumb: null }))
  })

  it('takes a mention as a path relative to an absolute project path', () => {
    const source = { projectPath: '/work/app', path: 'src/a.ts' }
    expect(posix['attachments.add']({ source, thumb: null })).toEqual({ source, thumb: null })
    expect(
      posix['attachments.add']({
        source: { ...source, bytes: new Uint8Array([1]).buffer },
        thumb: null,
      }),
    ).toEqual({ source, thumb: null })
    rejects(() =>
      posix['attachments.add']({ source: { ...source, path: '/etc/passwd' }, thumb: null }),
    )
    rejects(() =>
      posix['attachments.add']({ source: { ...source, projectPath: 'app' }, thumb: null }),
    )
    rejects(() => posix['attachments.add']({ source: { projectPath: '/work/app' }, thumb: null }))
  })

  it('checks what attachments.update is handed', () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer
    const thumb = 'data:image/webp;base64,AAAA'
    expect(posix['attachments.update']({ id: 'a1', thumb, scaled: null })).toEqual({
      id: 'a1',
      thumb,
      scaled: null,
    })
    expect(
      posix['attachments.update']({
        id: 'a1',
        thumb: null,
        scaled: { bytes, mimeType: 'image/jpeg', path: '/x' },
      }),
    ).toEqual({ id: 'a1', thumb: null, scaled: { bytes, mimeType: 'image/jpeg' } })
    rejects(() => posix['attachments.update']({ id: 'a1', thumb }))
    rejects(() => posix['attachments.update']({ id: 'a1', thumb: 'x', scaled: null }))
    rejects(() =>
      posix['attachments.update']({
        id: 'a1',
        thumb,
        scaled: { bytes: [1], mimeType: 'image/png' },
      }),
    )
    rejects(() =>
      posix['attachments.update']({
        id: 'a1',
        thumb,
        scaled: { bytes: new ArrayBuffer(20 * 1024 * 1024 + 1), mimeType: 'image/png' },
      }),
    )
  })

  it('reads a sent blob only by its SHA-256', () => {
    const hash = 'ab'.repeat(32)
    expect(posix['sessions.blob']({ sessionId: 's', hash })).toEqual({ sessionId: 's', hash })
    rejects(() => posix['sessions.blob']({ sessionId: 's', hash: '../../etc/passwd' }))
    rejects(() => posix['sessions.blob']({ sessionId: 's', hash: hash.toUpperCase() }))
    rejects(() => posix['sessions.blob']({ hash }))
    expect(posix['attachments.read']({ id: 'a1', more: 1 })).toEqual({ id: 'a1' })
    rejects(() => posix['attachments.remove']({}))
    expect(posix['attachments.held']({ ids: ['a1', 'a2'] })).toEqual({ ids: ['a1', 'a2'] })
    rejects(() => posix['attachments.held']({ ids: 'a1' }))
    rejects(() => posix['attachments.held']({ ids: ['a1', ''] }))
  })
})
