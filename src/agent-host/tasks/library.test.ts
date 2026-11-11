import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SOP_FILE_CHARS } from '@shared/tasks'
import { createSopLibrary, parseSopApprovals, type SopLibraryDeps } from './library'
import { hashOf } from './sop'

function sopText(id: string, prompt = 'Do the work.'): string {
  return [
    'format: 1',
    `id: ${id}`,
    'name: { en: Flow, zh-CN: 流程 }',
    'nodes:',
    '  - id: work',
    '    name: Work',
    '    by: standard',
    '    hand-in: note',
    `    prompt: ${prompt}`,
    '    outcomes:',
    '      - { id: finished, name: Finished, end: done }',
    '',
  ].join('\n')
}

let root: string
let libraryDir: string
let approvalsPath: string
let changes: number
let language: string

function library(extra: Partial<SopLibraryDeps> = {}) {
  return createSopLibrary({
    libraryDir,
    approvalsPath,
    language: () => language,
    changed: () => changes++,
    log: () => undefined,
    ...extra,
  })
}

async function put(name: string, text: string): Promise<void> {
  await mkdir(libraryDir, { recursive: true })
  await writeFile(path.join(libraryDir, name), text)
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'kettu-sops-'))
  libraryDir = path.join(root, 'sops')
  approvalsPath = path.join(root, 'state', 'sop-approvals.json')
  changes = 0
  language = 'en'
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('the SOPs Kettu ships', () => {
  it('are always ready, named in the language of the host', async () => {
    const shipped = await library().list()
    expect(shipped.map(({ source, id, status }) => [source, id, status])).toEqual([
      ['official', 'development', 'ready'],
      ['official', 'bug-fix', 'ready'],
      ['official', 'parallel-build', 'ready'],
    ])
    expect(shipped.every((sop) => sop.problem === null && sop.outline !== null)).toBe(true)
    expect(shipped[0]).toMatchObject({ name: 'Development', madeBy: null })
    language = 'zh-CN'
    expect((await library().list())[0]!.name).toBe('开发流程')

    const { sop, hash } = await library().read('official', 'bug-fix')
    expect(sop.nodes.map((node) => node.name)).toEqual(['复现', '修复', '验证'])
    expect(hash).toBe((await library().list())[1]!.hash)
    await expect(library().read('official', 'flow')).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('the library', () => {
  it('keeps what an agent adds pending until the person approves it', async () => {
    const sops = library()
    const text = sopText('flow')
    const added = await sops.add(text, 'agent')
    expect(added).toMatchObject({
      source: 'library',
      id: 'flow',
      name: 'Flow',
      hash: hashOf(text),
      problem: null,
      status: 'pending',
      madeBy: 'agent',
    })
    expect(added.outline?.nodes.map((node) => node.id)).toEqual(['work'])
    expect(await readFile(path.join(libraryDir, 'flow.yaml'), 'utf8')).toBe(text)
    expect(changes).toBe(1)
    await expect(sops.read('library', 'flow')).rejects.toThrow('has not been approved')
    expect((await sops.list()).at(-1)).toEqual(added)

    const approved = await sops.approve('flow', added.hash)
    expect(approved).toEqual({ ...added, status: 'ready' })
    expect(changes).toBe(2)
    const read = await sops.read('library', 'flow')
    expect(read.hash).toBe(added.hash)
    expect(read.sop.id).toBe('flow')
    expect((await sops.list()).at(-1)).toEqual(approved)
  })

  it('keeps an approval across restarts, outside the library folder', async () => {
    const added = await library().add(sopText('flow'), 'user')
    await library().approve('flow', added.hash)
    expect(await readdir(libraryDir)).toEqual(['flow.yaml'])
    expect(JSON.parse(await readFile(approvalsPath, 'utf8'))).toEqual({
      version: 1,
      sops: { flow: { madeBy: 'user', approved: added.hash } },
    })
    expect((await library().list()).at(-1)).toMatchObject({ status: 'ready', madeBy: 'user' })
  })

  it('turns an approved SOP pending when its file changes', async () => {
    const sops = library()
    const added = await sops.add(sopText('flow'), 'user')
    await sops.approve('flow', added.hash)
    const changed = sopText('flow', 'Do something else.')
    await put('flow.yaml', changed)

    expect((await sops.list()).at(-1)).toMatchObject({
      status: 'pending',
      hash: hashOf(changed),
      madeBy: 'user',
    })
    await expect(sops.read('library', 'flow')).rejects.toThrow('has not been approved')
    // The approval was for the old text: it cannot be given again without reading the new.
    await expect(sops.approve('flow', added.hash)).rejects.toMatchObject({ code: 'conflict' })
    await expect(sops.read('library', 'flow')).rejects.toThrow('has not been approved')

    await put('flow.yaml', sopText('flow'))
    expect((await sops.read('library', 'flow')).hash).toBe(added.hash)
  })

  it('never lets an agent make its own SOP ready', async () => {
    const sops = library()
    const text = sopText('flow')
    const added = await sops.add(text, 'agent')
    await sops.approve('flow', added.hash)

    // Adding again, even the approved text, needs the person again.
    expect(await sops.add(text, 'agent')).toMatchObject({ status: 'pending', madeBy: 'agent' })
    await expect(sops.read('library', 'flow')).rejects.toThrow('has not been approved')

    // Nothing an agent can put in the folder counts as an approval.
    await put(
      'sop-approvals.json',
      JSON.stringify({ version: 1, sops: { flow: { approved: added.hash } } }),
    )
    await put('other.yaml', sopText('other'))
    const listed = await library().list()
    expect(listed.filter((sop) => sop.source === 'library')).toMatchObject([
      { id: 'flow', status: 'pending' },
      { id: 'other', status: 'pending', madeBy: null },
    ])
  })

  it("never lets an agent replace the person's SOP", async () => {
    const sops = library()
    const mine = sopText('flow')
    const added = await sops.add(mine, 'user')
    await sops.approve('flow', added.hash)
    await put('dropped-in.yaml', sopText('dropped-in'))

    await expect(sops.add(sopText('flow', 'Do harm.'), 'agent')).rejects.toThrow('already has')
    await expect(sops.add(sopText('dropped-in', 'Do harm.'), 'agent')).rejects.toThrow(
      'already has',
    )
    expect(await readFile(path.join(libraryDir, 'flow.yaml'), 'utf8')).toBe(mine)
    expect((await sops.read('library', 'flow')).hash).toBe(added.hash)

    // The person may replace anything, and approves it again.
    const next = await sops.add(sopText('flow', 'Do better.'), 'user')
    expect(next).toMatchObject({ status: 'pending', madeBy: 'user' })
  })

  it('rejects what does not read, and an id Kettu ships', async () => {
    const sops = library()
    await expect(sops.add('format: 2\n', 'agent')).rejects.toMatchObject({
      code: 'invalid_params',
      message: 'The SOP is not valid: format: must be 1',
    })
    await expect(sops.add(sopText('development'), 'user')).rejects.toThrow('Kettu ships an SOP')
    await expect(sops.add(sopText('../escape'), 'agent')).rejects.toThrow('id: must be lowercase')
    expect(changes).toBe(0)
    await expect(readdir(libraryDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('lists a file that does not read with its problem, and never uses it', async () => {
    await put('broken.yaml', 'format: 1\nid: broken\n')
    await put('renamed.yaml', sopText('flow'))
    await put('bug-fix.yaml', sopText('bug-fix'))
    await put('long.yaml', `${sopText('long')}# ${'x'.repeat(SOP_FILE_CHARS)}\n`)
    await put('huge.yaml', 'x'.repeat(SOP_FILE_CHARS * 3 + 1))
    // Not SOPs of the library: another extension, a name that is no id, a folder.
    await put('notes.txt', 'notes')
    await put('My Flow.yaml', sopText('flow'))
    await mkdir(path.join(libraryDir, 'folder.yaml'))

    const sops = library()
    const listed = (await sops.list()).filter((sop) => sop.source === 'library')
    expect(listed.map(({ id, problem }) => [id, problem])).toEqual([
      ['broken', 'nodes: must list at least one node'],
      ['bug-fix', 'Kettu ships an SOP with the id "bug-fix"'],
      ['huge', `the file is longer than ${SOP_FILE_CHARS} characters`],
      ['long', `the file is longer than ${SOP_FILE_CHARS} characters`],
      ['renamed', 'the file is named "renamed.yaml" but its id is "flow"'],
    ])
    for (const sop of listed) {
      expect(sop).toMatchObject({ name: sop.id, outline: null, status: 'pending' })
      await expect(sops.approve(sop.id, sop.hash)).rejects.toThrow('cannot be approved')
      await expect(sops.read('library', sop.id)).rejects.toThrow('cannot be used')
    }
    await expect(sops.read('library', 'gone')).rejects.toMatchObject({ code: 'not_found' })
    await expect(sops.approve('gone', hashOf(''))).rejects.toMatchObject({ code: 'not_found' })
  })

  it('takes no id that could leave the folder', async () => {
    const outside = path.join(root, 'outside.yaml')
    const text = sopText('outside')
    await writeFile(outside, text)
    await put('flow.yaml', sopText('flow'))
    const sops = library()
    for (const id of [
      '../outside',
      '..',
      'sub/flow',
      'sub\\flow',
      'flow.yaml',
      '',
      'Flow',
      'nul',
    ]) {
      await expect(sops.read('library', id), id).rejects.toMatchObject({ code: 'not_found' })
      await expect(sops.approve(id, hashOf(text)), id).rejects.toMatchObject({ code: 'not_found' })
      await expect(sops.remove(id), id).rejects.toMatchObject({ code: 'not_found' })
    }
    expect(await readFile(outside, 'utf8')).toBe(text)
    expect(await readdir(libraryDir)).toEqual(['flow.yaml'])
    expect(changes).toBe(0)
  })

  it('does not follow a link out of the folder', async () => {
    const outside = path.join(root, 'outside.yaml')
    await writeFile(outside, sopText('linked'))
    await mkdir(libraryDir, { recursive: true })
    await symlink(outside, path.join(libraryDir, 'linked.yaml'))
    const sops = library()
    expect((await sops.list()).filter((sop) => sop.source === 'library')).toEqual([])
    await expect(sops.approve('linked', hashOf(sopText('linked')))).rejects.toThrow(
      'it is not a plain file',
    )
    await expect(sops.read('library', 'linked')).rejects.toThrow('it is not a plain file')
  })

  it('removes the file with its approval', async () => {
    const sops = library()
    const text = sopText('flow')
    const added = await sops.add(text, 'agent')
    await sops.approve('flow', added.hash)
    await sops.remove('flow')
    expect(changes).toBe(3)
    expect((await sops.list()).filter((sop) => sop.source === 'library')).toEqual([])
    await expect(sops.read('library', 'flow')).rejects.toMatchObject({ code: 'not_found' })

    // The same text put back by hand was never approved, and nobody is known to have made it.
    await put('flow.yaml', text)
    expect((await library().list()).at(-1)).toMatchObject({ status: 'pending', madeBy: null })
  })

  it('treats approvals that do not read as none', async () => {
    const added = await library().add(sopText('flow'), 'user')
    await library().approve('flow', added.hash)
    await writeFile(approvalsPath, '{ not json')
    expect((await library().list()).at(-1)).toMatchObject({ status: 'pending', madeBy: null })
  })
})

describe('parseSopApprovals', () => {
  it('drops what does not read and keeps the rest', () => {
    const hash = hashOf('x')
    expect(
      parseSopApprovals({
        version: 1,
        sops: {
          flow: { madeBy: 'agent', approved: hash },
          other: { madeBy: 'robot', approved: 'yes' },
          '../escape': { madeBy: 'user', approved: hash },
          bad: 'ready',
        },
      }),
    ).toEqual({
      version: 1,
      sops: {
        flow: { madeBy: 'agent', approved: hash },
        other: { madeBy: null, approved: null },
      },
    })
    expect(parseSopApprovals({ version: 1 })).toBe('"sops" must be a mapping')
  })
})
