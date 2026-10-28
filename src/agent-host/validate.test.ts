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

  it('takes positions as whole numbers from 0', () => {
    expect(posix['sessions.snapshot']({ sessionId: 's' })).toEqual({ sessionId: 's' })
    expect(posix['sessions.snapshot']({ sessionId: 's', from: 0 })).toEqual({
      sessionId: 's',
      from: 0,
    })
    expect(posix['sessions.page']({ sessionId: 's', before: 140 })).toEqual({
      sessionId: 's',
      before: 140,
    })
    rejects(() => posix['sessions.page']({ sessionId: 's' }))
    rejects(() => posix['sessions.page']({ sessionId: 's', before: -1 }))
    rejects(() => posix['sessions.page']({ sessionId: 's', before: 1.5 }))
    rejects(() => posix['sessions.snapshot']({ sessionId: 's', from: '3' }))
  })

  it('takes the session ids the removal of empty sessions keeps', () => {
    expect(posix['sessions.removeEmpty']({ keep: [] })).toEqual({ keep: [] })
    expect(posix['sessions.removeEmpty']({ keep: ['a', 'b'], other: 1 })).toEqual({
      keep: ['a', 'b'],
    })
    rejects(() => posix['sessions.removeEmpty']({}))
    rejects(() => posix['sessions.removeEmpty']({ keep: 'a' }))
    rejects(() => posix['sessions.removeEmpty']({ keep: [''] }))
    rejects(() => posix['sessions.removeEmpty']({ keep: [3] }))
    rejects(() => posix['sessions.removeEmpty']({ keep: ['x'.repeat(257)] }))
    const ids = (count: number) => Array.from({ length: count }, (_, i) => `s${i}`)
    expect(posix['sessions.removeEmpty']({ keep: ids(10_000) }).keep).toHaveLength(10_000)
    rejects(() => posix['sessions.removeEmpty']({ keep: ids(10_001) }))
  })

  it('takes the sessions a window shows in front, up to nine', () => {
    expect(posix['sessions.show']({ sessionIds: [] })).toEqual({ sessionIds: [] })
    expect(posix['sessions.show']({ sessionIds: ['a', 'b'], other: 1 })).toEqual({
      sessionIds: ['a', 'b'],
    })
    const ids = Array.from({ length: 10 }, (_, i) => `s${i}`)
    expect(posix['sessions.show']({ sessionIds: ids.slice(0, 9) }).sessionIds).toHaveLength(9)
    rejects(() => posix['sessions.show']({ sessionIds: ids }))
    rejects(() => posix['sessions.show']({}))
    rejects(() => posix['sessions.show']({ sessionIds: 's1' }))
    rejects(() => posix['sessions.show']({ sessionIds: [1] }))
    rejects(() => posix['sessions.show']({ sessionIds: [''] }))
  })

  it('takes a pin and an unread mark as booleans', () => {
    const sessionId = 's1'
    expect(posix['sessions.pin']({ sessionId, pinned: true })).toEqual({ sessionId, pinned: true })
    expect(posix['sessions.markUnread']({ sessionId, unread: false })).toEqual({
      sessionId,
      unread: false,
    })
    rejects(() => posix['sessions.pin']({ sessionId }))
    rejects(() => posix['sessions.pin']({ sessionId, pinned: 'yes' }))
    rejects(() => posix['sessions.markUnread']({ sessionId, unread: 1 }))
    expect(posix['sessions.archive']({ sessionId, extra: 1 })).toEqual({ sessionId })
    rejects(() => posix['sessions.unarchive']({}))
  })

  it('forks at an entry only when one is named', () => {
    expect(posix['sessions.fork']({ sessionId: 's' })).toEqual({ sessionId: 's' })
    expect(posix['sessions.fork']({ sessionId: 's', entryId: 'm:msg_1' })).toEqual({
      sessionId: 's',
      entryId: 'm:msg_1',
    })
    rejects(() => posix['sessions.fork']({ sessionId: 's', entryId: '' }))
    rejects(() => posix['sessions.fork']({ sessionId: 's', entryId: 3 }))
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

  it('takes a first message as prompt content', () => {
    const prompt = [{ type: 'text', text: 'Fix the build' }]
    expect(posix['sessions.create']({ agentId: 'codex', projectPath: null, prompt })).toEqual({
      agentId: 'codex',
      projectPath: null,
      prompt,
    })
    rejects(() => posix['sessions.create']({ agentId: 'codex', projectPath: null, prompt: [] }))
    rejects(() => posix['sessions.create']({ agentId: 'codex', projectPath: null, prompt: 'hi' }))
  })

  it('takes start values as strings or booleans by option id', () => {
    const options = { model: 'opus', fast: true }
    expect(
      posix['sessions.create']({ agentId: 'codex', projectPath: null, options, extra: 1 }),
    ).toEqual({ agentId: 'codex', projectPath: null, options })
    rejects(() => posix['sessions.create']({ agentId: 'codex', projectPath: null, options: [] }))
    rejects(() =>
      posix['sessions.create']({ agentId: 'codex', projectPath: null, options: { model: 3 } }),
    )
    rejects(() =>
      posix['sessions.create']({ agentId: 'codex', projectPath: null, options: { model: '' } }),
    )
  })

  it('takes returned messages for a session, for New session, or for all', () => {
    expect(posix['sessions.takeReturned']({ sessionId: null })).toEqual({ sessionId: null })
    expect(posix['sessions.takeReturned']({ sessionId: 's1', other: 1 })).toEqual({
      sessionId: 's1',
    })
    expect(posix['sessions.takeReturned']({})).toEqual({})
    rejects(() => posix['sessions.takeReturned']({ sessionId: 1 }))
    rejects(() => posix['sessions.takeReturned']({ sessionId: '' }))
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

  it('takes an install method by name, or none', () => {
    expect(posix['agents.install']({ agentId: 'opencode' })).toEqual({ agentId: 'opencode' })
    expect(posix['agents.install']({ agentId: 'opencode', method: 'script', x: 1 })).toEqual({
      agentId: 'opencode',
      method: 'script',
    })
    rejects(() => posix['agents.install']({ agentId: 'opencode', method: 'choco' }))
    rejects(() => posix['agents.install']({ agentId: 'opencode', method: null }))
    rejects(() => posix['agents.install']({ method: 'brew' }))
    expect(posix['agents.update']({ agentId: 'codex' })).toEqual({ agentId: 'codex' })
    expect(posix['agents.skipUpdate']({ agentId: 'codex' })).toEqual({ agentId: 'codex' })
    expect(posix['agents.cancelTask']({ agentId: 'codex' })).toEqual({ agentId: 'codex' })
    rejects(() => posix['agents.update']({ agentId: 'gemini' }))
    rejects(() => posix['agents.skipUpdate']({ agentId: 'gemini' }))
    rejects(() => posix['agents.skipUpdate']({}))
    expect(posix['agents.checkUpdates'](undefined)).toBeUndefined()
    rejects(() => posix['agents.checkUpdates']({ agentId: 'codex' }))
  })

  it('takes only GitHub pull request URLs', () => {
    const v = posix['git.pullRequest']
    expect(v({ url: 'https://github.com/a/b/pull/12' })).toEqual({
      url: 'https://github.com/a/b/pull/12',
    })
    rejects(() => v({ url: 'https://example.com/a/b/pull/12' }))
    rejects(() => v({ url: 'javascript:alert(1)' }))
  })

  it("takes only a GitHub user's login or a bot's", () => {
    const v = posix['git.avatarUrl']
    for (const login of ['mirachen', 'octocat_acme', 'a-b-c', 'overbench-builder[bot]']) {
      expect(v({ login })).toEqual({ login })
    }
    for (const login of ['', '-h', 'app/bot', '../x', 'users/x', 'a b', 'x[bot', 'a'.repeat(101)]) {
      rejects(() => v({ login }))
    }
    rejects(() => v({}))
    rejects(() => v({ login: 7 }))
  })

  it('checks the git writes', () => {
    const push = posix['git.push']
    const target = { projectPath: '/p', remote: 'origin', branch: 'feat/login' }
    expect(push(target)).toEqual(target)
    rejects(() => push({ projectPath: '/p' }))
    rejects(() => push({ ...target, remote: '--receive-pack=evil' }))
    rejects(() => push({ ...target, branch: 'main:refs/heads/other' }))
    rejects(() => push({ ...target, branch: '' }))

    const publish = posix['git.publish']
    expect(publish({ projectPath: '/p', name: 'my-app.v2', visibility: 'private' })).toEqual({
      projectPath: '/p',
      name: 'my-app.v2',
      visibility: 'private',
    })
    rejects(() => publish({ projectPath: '/p', name: '-x', visibility: 'private' }))
    rejects(() => publish({ projectPath: '/p', name: 'a/b', visibility: 'private' }))
    rejects(() => publish({ projectPath: '/p', name: '..', visibility: 'public' }))
    rejects(() => publish({ projectPath: '/p', name: 'app', visibility: 'internal' }))

    const create = posix['git.createPullRequest']
    const draft = { projectPath: '/p', title: 'Fix it', body: '', base: 'main', draft: false }
    expect(create(draft)).toEqual(draft)
    rejects(() => create({ ...draft, title: '   ' }))
    rejects(() => create({ ...draft, base: '--force' }))
    rejects(() => create({ ...draft, base: 'a b' }))
    rejects(() => create({ ...draft, draft: 'yes' }))
    rejects(() => create({ ...draft, body: 'x'.repeat(65_537) }))
  })

  it('checks the git reads', () => {
    expect(posix['git.commit']({ projectPath: '/p', oid: '3f2a1c1' })).toEqual({
      projectPath: '/p',
      oid: '3f2a1c1',
    })
    rejects(() => posix['git.commit']({ projectPath: '/p', oid: 'HEAD~1' }))
    rejects(() => posix['git.commit']({ projectPath: '/p', oid: '--all' }))
    rejects(() => posix['git.incoming']({ projectPath: '/p', from: 'origin' }))

    const diff = posix['git.fileDiff']
    expect(diff({ projectPath: '/p', path: 'src/a.ts', oldPath: null, ref: null })).toEqual({
      projectPath: '/p',
      path: 'src/a.ts',
      oldPath: null,
      ref: null,
    })
    expect(
      diff({ projectPath: '/p', path: 'b.ts', oldPath: 'a.ts', ref: 'abc1234' }),
    ).toMatchObject({ oldPath: 'a.ts', ref: 'abc1234' })
    rejects(() => diff({ projectPath: '/p', path: '../x', oldPath: null, ref: null }))
    rejects(() => diff({ projectPath: '/p', path: '/etc/hosts', oldPath: null, ref: null }))
    rejects(() => diff({ projectPath: '/p', path: 'a', oldPath: 'x/../../y', ref: null }))
    rejects(() => diff({ projectPath: '/p', path: 'a', oldPath: null, ref: 'main' }))
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

  it('checks the artifact requests', () => {
    const id = 'art_01JBX3Q0R5K8V2M7N4P6S9T1WZ'
    expect(posix['artifacts.list'](undefined)).toEqual({})
    expect(posix['artifacts.list']({ deleted: true, extra: 1 })).toEqual({ deleted: true })
    rejects(() => posix['artifacts.list']({ deleted: 'yes' }))

    for (const method of ['artifacts.versions', 'artifacts.watch', 'artifacts.undelete'] as const) {
      expect(posix[method]({ id, extra: 1 })).toEqual({ id })
      rejects(() => posix[method]({}))
      rejects(() => posix[method]({ id: 'art_01jbx3q0r5k8v2m7n4p6s9t1wz' }))
      rejects(() => posix[method]({ id: 'art_01JBX3Q0R5K8V2M7N4P6S9T1W' }))
      rejects(() => posix[method]({ id: 'art_01JBX3Q0R5K8V2M7N4P6S9T1WI' }))
      rejects(() => posix[method]({ id: '../art_01JBX3Q0R5K8V2M7N4P6S9T1WZ' }))
    }

    const read = posix['artifacts.read']
    expect(read({ id })).toEqual({ id })
    expect(read({ id, version: 3 })).toEqual({ id, version: 3 })
    rejects(() => read({ id, version: 0 }))
    rejects(() => read({ id, version: 1.5 }))
    rejects(() => read({ id, version: '2' }))

    const rename = posix['artifacts.rename']
    expect(rename({ id, title: 'Traffic report' })).toEqual({ id, title: 'Traffic report' })
    expect(rename({ id, title: 'x'.repeat(120) }).title).toHaveLength(120)
    rejects(() => rename({ id, title: 'x'.repeat(121) }))
    // Counted in code points, as the agents' tools count a title.
    expect(rename({ id, title: '\u{1F600}'.repeat(120) }).title).toHaveLength(240)
    rejects(() => rename({ id, title: '\u{1F600}'.repeat(121) }))
    rejects(() => rename({ id, title: '   ' }))
    rejects(() => rename({ id }))

    expect(posix['artifacts.delete']({ id })).toEqual({ id })
    expect(posix['artifacts.delete']({ id, permanently: true })).toEqual({ id, permanently: true })
    rejects(() => posix['artifacts.delete']({ id, permanently: 1 }))

    const restore = posix['artifacts.restoreVersion']
    expect(restore({ id, version: 1, baseVersion: 3, extra: 1 })).toEqual({
      id,
      version: 1,
      baseVersion: 3,
    })
    rejects(() => restore({ id, version: 1 }))
    rejects(() => restore({ id, version: -1, baseVersion: 3 }))
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

  it('checks a routine draft, its changes, and the requests on it', () => {
    const draft = {
      name: 'Morning briefing',
      prompt: 'Summarize the open pull requests',
      agentId: 'claude-code',
      projectPath: '/work/app',
      options: [
        { id: 'model', value: 'fable' },
        { id: 'fast', value: true },
      ],
      trigger: {
        kind: 'schedule',
        schedule: { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' },
      },
      scope: { level: 'read', web: false },
      timeLimitMinutes: 60,
    }
    expect(posix['routines.create'](draft)).toEqual(draft)
    expect(posix['routines.create']({ ...draft, name: undefined })).toEqual({ ...draft, name: '' })
    expect(posix['routines.create']({ ...draft, projectPath: null })).toMatchObject({
      projectPath: null,
    })
    expect(windows['routines.create']({ ...draft, projectPath: 'C:\\work\\app' })).toMatchObject({
      projectPath: 'C:\\work\\app',
    })
    for (const broken of [
      { ...draft, name: 'x'.repeat(121) },
      { ...draft, name: 7 },
      { ...draft, prompt: '   ' },
      { ...draft, prompt: 'x'.repeat(100_001) },
      { ...draft, agentId: 'gemini' },
      { ...draft, projectPath: 'app' },
      { ...draft, projectPath: undefined },
      { ...draft, options: Array.from({ length: 21 }, () => ({ id: 'x', value: true })) },
      { ...draft, options: [{ id: '', value: true }] },
      { ...draft, options: [{ id: 'x', value: 'y'.repeat(201) }] },
      { ...draft, options: [{ id: 'x', value: 1 }] },
      { ...draft, trigger: { kind: 'later' } },
      {
        ...draft,
        trigger: { kind: 'schedule', schedule: { kind: 'weekly', days: [], time: '09:00' } },
      },
      {
        ...draft,
        trigger: { kind: 'schedule', schedule: { kind: 'weekly', days: [1], time: '24:00' } },
      },
      { ...draft, scope: { level: 'all', web: false } },
      { ...draft, timeLimitMinutes: 45 },
    ]) {
      rejects(() => posix['routines.create'](broken))
    }

    expect(
      posix['routines.update']({
        routineId: 'r-0123456789ab',
        changes: { enabled: false, prompt: 'Another prompt' },
      }),
    ).toEqual({
      routineId: 'r-0123456789ab',
      changes: { enabled: false, prompt: 'Another prompt' },
    })
    rejects(() => posix['routines.update']({ routineId: 'r-1', changes: {} }))
    rejects(() =>
      posix['routines.update']({ routineId: 'r-0123456789ab', changes: { later: true } }),
    )
    rejects(() =>
      posix['routines.update']({ routineId: 'r-0123456789ab', changes: { enabled: 'yes' } }),
    )
    rejects(() =>
      posix['routines.update']({ routineId: 'r-0123456789ab', changes: { projectPath: 'app' } }),
    )

    expect(posix['routines.runs']({ routineId: 'r-0123456789ab' })).toEqual({
      routineId: 'r-0123456789ab',
    })
    expect(posix['routines.runs']({ routineId: 'r-0123456789ab', before: 5 })).toEqual({
      routineId: 'r-0123456789ab',
      before: 5,
    })
    rejects(() => posix['routines.runs']({ routineId: 'r-0123456789ab', before: -1 }))
    rejects(() => posix['routines.runNow']({ routineId: 'run-1' }))
    rejects(() => posix['routines.delete']({}))
    rejects(() => posix['routines.cancelRun']({}))
    expect(posix['routines.cancelRun']({ runId: 'run-1' })).toEqual({ runId: 'run-1' })
    expect(posix['routines.list'](undefined)).toBeUndefined()
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
