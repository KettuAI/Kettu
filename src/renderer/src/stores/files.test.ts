import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import type { FileContent } from '@shared/files'

const request = vi.fn()
const setUnsaved = vi.fn()
vi.stubGlobal('window', { overbench: { agents: { request }, app: { setUnsaved } } })

const files = await import('./files')
const { buffers, useFilesStore } = files

const project = '/p'
const text = (path: string, body: string, version: string): FileContent => ({
  kind: 'text',
  path,
  size: body.length,
  text: body,
  version,
  editable: true,
})

/** Answers `files.read` with `reads` in turn and `files.write` with `writes`. */
function host(reads: FileContent[], writes: (() => unknown)[] = []): void {
  request.mockImplementation(async (method: string) => {
    if (method === 'files.read') return reads.shift()
    if (method === 'files.write') return writes.shift()!()
    throw new Error(`unexpected ${method}`)
  })
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const open = () => useFilesStore.getState().open[project]!

/** Opens `a.ts` at v1 and types into it, as the editor would. */
async function edited(): Promise<void> {
  host([text('a.ts', 'one', 'v1')])
  files.openFile(project, 'a.ts')
  await settle()
  const state = EditorState.create({ doc: 'one' })
  buffers.set(project, { path: 'a.ts', version: 'v1', base: state.doc, state })
  const buffer = buffers.get(project)!
  buffer.state = state.update({ changes: { from: 3, insert: ' two' } }).state
  files.setDirty(project, 'a.ts', true)
}

describe('editing a file', () => {
  beforeEach(() => {
    request.mockReset()
    setUnsaved.mockReset()
    buffers.clear()
    useFilesStore.setState({ open: {}, pending: {}, byProject: {} })
  })

  it('saves the edits against the version they started from', async () => {
    await edited()
    expect(setUnsaved).toHaveBeenLastCalledWith([{ projectPath: project, path: 'a.ts' }])
    host([], [() => ({ version: 'v2', size: 7 })])
    expect(await files.saveFile(project)).toBe(true)
    expect(request).toHaveBeenCalledWith('files.write', {
      projectPath: project,
      path: 'a.ts',
      text: 'one two',
      version: 'v1',
    })
    expect(open()).toMatchObject({ dirty: false, content: { text: 'one two', version: 'v2' } })
    expect(buffers.get(project)?.version).toBe('v2')
    expect(setUnsaved).toHaveBeenLastCalledWith([])
  })

  it('keeps the edits when the file changes on disk, and says so', async () => {
    await edited()
    host([text('a.ts', 'agent', 'v9')])
    const listed = { paths: ['a.ts'], known: new Set(['a.ts']), truncated: false, error: null }
    useFilesStore.setState({ byProject: { [project]: listed } })
    files.refreshFiles(project)
    await settle()
    expect(open()).toMatchObject({ dirty: true, changedOnDisk: true, diskVersion: 'v9' })
    expect(open().content).toMatchObject({ version: 'v1' })
  })

  it('shows the change on disk when a save is refused, and overwrites only what was kept', async () => {
    await edited()
    host(
      [text('a.ts', 'agent', 'v9')],
      [
        () => Promise.reject({ code: 'conflict', message: 'a.ts changed since it was read' }),
        () => ({ version: 'v10', size: 7 }),
      ],
    )
    expect(await files.saveFile(project)).toBe(false)
    expect(open()).toMatchObject({ dirty: true, changedOnDisk: true, diskVersion: 'v9' })

    files.keepEdits(project)
    expect(open()).toMatchObject({ changedOnDisk: false, kept: 'v9' })
    expect(await files.saveFile(project)).toBe(true)
    expect(request).toHaveBeenLastCalledWith(
      'files.write',
      expect.objectContaining({ version: 'v9' }),
    )
    expect(open()).toMatchObject({ dirty: false, kept: null })
  })

  it('drops the edits and shows the file as it is on disk', async () => {
    await edited()
    host([text('a.ts', 'agent', 'v9')])
    files.discardEdits(project)
    await settle()
    expect(buffers.has(project)).toBe(false)
    expect(open()).toMatchObject({ dirty: false, resets: 1, content: { version: 'v9' } })
  })

  it('keeps the edits and the error when a save fails', async () => {
    await edited()
    host([], [() => Promise.reject({ code: 'internal', message: 'disk full' })])
    expect(await files.saveFile(project)).toBe(false)
    expect(open()).toMatchObject({ dirty: true, saving: false, saveError: 'disk full' })
  })

  it('asks before another file replaces the edits, and does what the answer says', async () => {
    await edited()
    files.openFile(project, 'b.ts', 3)
    expect(useFilesStore.getState().pending[project]).toEqual({
      kind: 'open',
      path: 'b.ts',
      line: 3,
    })
    expect(open().path).toBe('a.ts')

    await files.answerPending(project, 'cancel')
    expect(useFilesStore.getState().pending[project]).toBeUndefined()
    expect(open()).toMatchObject({ path: 'a.ts', dirty: true })

    files.openFile(project, 'b.ts')
    host([text('b.ts', 'bee', 'b1')])
    await files.answerPending(project, 'discard')
    await settle()
    expect(open()).toMatchObject({ path: 'b.ts', dirty: false, content: { text: 'bee' } })
    expect(buffers.has(project)).toBe(false)
  })

  it('saves before closing when asked to, and stays open when the save fails', async () => {
    await edited()
    files.closeFile(project)
    expect(useFilesStore.getState().pending[project]).toEqual({ kind: 'close' })
    host([], [() => Promise.reject({ code: 'internal', message: 'disk full' })])
    await files.answerPending(project, 'save')
    expect(open()).toMatchObject({ path: 'a.ts', saveError: 'disk full' })

    files.closeFile(project)
    host([], [() => ({ version: 'v2', size: 7 })])
    await files.answerPending(project, 'save')
    expect(useFilesStore.getState().open[project]).toBeUndefined()
  })

  it('moves to a line of the same file without asking', async () => {
    await edited()
    host([text('a.ts', 'one', 'v1')])
    files.openFile(project, 'a.ts', 1)
    expect(useFilesStore.getState().pending[project]).toBeUndefined()
    expect(open()).toMatchObject({ line: 1, dirty: true })
  })
})
