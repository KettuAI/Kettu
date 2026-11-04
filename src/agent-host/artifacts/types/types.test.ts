import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import decompress from 'decompress'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startThreadService } from '../../threads/service'
import { ThreadStoreError, type ThreadStore } from '../../threads/store'
import { RuntimeDispatcher, type CapabilityContext } from '../runtime/dispatcher'
import { ArtifactStore } from '../store'
import { ArtifactTools, type Caller } from '../tools'
import { contentCapability, ContentCapabilityError } from './capability'
import { exportVersion } from './export'
import { ArtifactTypes, BUILT_IN_TYPES, type TypePackage } from './registry'
import { upgradeContent } from './writes'

// A 4 by 2 PNG: the signature and the header's size are all a check reads.
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 4,
  0, 0, 0, 2,
])

const DOCUMENT = [
  '# Quarterly report',
  '',
  'Sales **rose** in *every* region; see [the data](https://example.com/data).',
  '',
  '![Sales by month](images/chart.png)',
  '',
  '## Next steps',
  '',
  '1. Hire',
  '2. Ship',
  '   - [x] Beta',
  '',
  '| Region | Sales |',
  '| --- | --- |',
  '| North | 12 |',
  '',
  '```ts',
  'const total = 12',
  '```',
  '',
].join('\n')

const DECK = JSON.stringify({
  title: 'Q3',
  slides: [
    { layout: 'title', title: 'Q3 review', subtitle: 'October', notes: 'Welcome' },
    {
      layout: 'bullets',
      title: 'Why',
      bullets: ['Faster', { text: 'Cheaper', bullets: ['-30%'] }],
    },
    { layout: 'image', title: 'Chart', image: 'images/chart.png', alt: 'Chart' },
    { layout: 'table', columns: ['Plan', 'Price'], rows: [['Free', '$0']] },
  ],
})

let dir: string
let work: string
let store: ArtifactStore
let tools: ArtifactTools
let caller: Caller
const logs: string[] = []

/** The thread service in this thread, answering as the worker would. */
function threadsAt(folder: string): ThreadStore {
  const pending = new Map<number, { resolve(value: unknown): void; reject(e: unknown): void }>()
  let next = 0
  const handle = startThreadService(
    { file: path.join(folder, 'threads.db'), contentDir: path.join(folder, 'content') },
    (reply) => {
      if (reply.type !== 'result' && reply.type !== 'error') return
      const waiting = pending.get(reply.id)
      pending.delete(reply.id)
      if (reply.type === 'result') waiting?.resolve(reply.value)
      else waiting?.reject(new ThreadStoreError(reply.message, reply.code, reply.data))
    },
  )
  const ask =
    (op: 'artifact' | 'runtime') =>
    (name: string, params: unknown): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const id = ++next
        pending.set(id, { resolve, reject })
        handle({ id, op, call: { name, params } as never })
      })
  return { artifact: ask('artifact'), runtime: ask('runtime') } as unknown as ThreadStore
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-artifact-types-'))
  work = path.join(dir, 'work')
  mkdirSync(work, { recursive: true })
  writeFileSync(path.join(work, 'chart.png'), PNG)
  store = new ArtifactStore({
    threads: threadsAt(dir),
    contentDir: path.join(dir, 'content'),
    log: () => {},
    changed: () => {},
    version: () => {},
    activity: () => {},
  })
  tools = new ArtifactTools({ store, sessionTitle: () => 'Session', runningTurn: () => null })
  caller = { sessionId: 's1', project: work }
  logs.length = 0
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function call(name: string, input: unknown, using = tools) {
  const result = await using.call(caller, name, input)
  return {
    error: result.isError ? (result.structuredContent as { code: string; message: string }) : null,
    value: result.structuredContent as Record<string, unknown>,
  }
}

async function makeDocument(text = DOCUMENT): Promise<string> {
  const { error, value } = await call('create_artifact_from_type', {
    type: 'document',
    title: 'Report',
    files: [
      { path: 'document.md', content: text },
      { path: 'images/chart.png', source: 'chart.png' },
    ],
  })
  expect(error).toBeNull()
  return value.id as string
}

function context(artifactId: string, version = 1): CapabilityContext {
  return {
    artifactId,
    project: work,
    version,
    declared: [],
    client: 'test',
    signal: new AbortController().signal,
  }
}

describe('the type tools', () => {
  it('lists the types and gives each one’s guidance and references', async () => {
    const listed = await call('list_artifact_types', {})
    expect(listed.error).toBeNull()
    expect((listed.value.types as { type: string }[]).map((t) => t.type)).toEqual([
      'document',
      'slides',
    ])
    const guide = await call('read_artifact_type', { type: 'slides' })
    expect(guide.value.text).toMatch(/slides\.json/)
    expect((guide.value.references as { name: string }[]).map((r) => r.name)).toEqual([
      'deck',
      'layouts',
      'images',
    ])
    const page = await call('read_artifact_type', { type: 'slides', reference: 'layouts' })
    expect(page.value.text).toMatch(/two-column/)
    const missing = await call('read_artifact_type', { type: 'slides', reference: 'colors' })
    expect(missing.error?.code).toBe('invalid')
    expect(missing.error?.message).toMatch(/it has deck, layouts, images/)
    expect((await call('read_artifact_type', { type: 'sheet' })).error?.code).toBe('invalid')
  })

  it('makes a typed artifact that holds only its content, and records its type', async () => {
    const id = await makeDocument()
    const found = await store.get(id)
    expect(found.type).toEqual({ name: 'document', format: 1 })
    expect(found.files.map((file) => file.path)).toEqual(['document.md', 'images/chart.png'])
    const listed = await store.list({ project: work })
    expect(listed[0]!.type).toBe('document')
    const read = await call('read_artifact', { id })
    expect(read.value).toMatchObject({ path: 'document.md', type: 'document', format: 1 })
    expect(read.value.text).toBe(DOCUMENT)
  })

  it('refuses content that does not fit the format, saying what to fix', async () => {
    const { error } = await call('create_artifact_from_type', {
      type: 'slides',
      title: 'Deck',
      files: [{ path: 'slides.json', content: '{"slides": [{"layout": "bullets"}]}' }],
    })
    expect(error?.code).toBe('invalid')
    expect(error?.message).toMatch(/1\) slides\[0\]\.title is missing/)
    expect(error?.message).toMatch(/read_artifact_type with type slides/)
    expect(await store.list({ project: work })).toHaveLength(0)
  })

  it('checks every update of a typed artifact, and its edits name its content by default', async () => {
    const id = await makeDocument()
    const html = await call('update_artifact', { id, base_version: 1, html: '<p>' })
    expect(html.error?.message).toMatch(/is a document, which has no index\.html/)
    const broken = await call('update_artifact', {
      id,
      base_version: 1,
      edits: [{ old_text: 'images/chart.png', new_text: 'images/gone.png' }],
    })
    expect(broken.error?.message).toMatch(/images\/gone\.png, which the version does not have/)
    const fixed = await call('update_artifact', {
      id,
      base_version: 1,
      edits: [{ old_text: '# Quarterly report', new_text: '# Q3 report' }],
    })
    expect(fixed.error).toBeNull()
    expect((await store.get(id)).type).toEqual({ name: 'document', format: 1 })
    const page = await call('create_artifact', {
      title: 'Page',
      files: [{ path: 'document.md', content: '#' }],
    })
    expect(page.error?.message).toMatch(/needs index\.html/)
  })
})

describe('the content capability', () => {
  it('reads the version a viewer shows and writes the user’s text as a new version', async () => {
    const id = await makeDocument()
    const content = contentCapability({ store, types: new ArtifactTypes() })
    const read = (await content.call(context(id), 'read', { version: 1 })) as Record<
      string,
      unknown
    >
    expect(read).toMatchObject({ type: 'document', version: 1, head: 1, text: DOCUMENT })
    const written = await content.call(context(id), 'write', {
      baseVersion: 1,
      text: DOCUMENT.replace('Quarterly', 'Yearly'),
    })
    expect(written).toEqual({ version: 2 })
    const found = await store.get(id)
    expect(found.version.author).toBeNull()
    expect(found.type).toEqual({ name: 'document', format: 1 })
    expect(found.files.map((file) => file.path)).toEqual(['document.md', 'images/chart.png'])
  })

  it('refuses a stale base, content that does not fit, and plain artifacts', async () => {
    const id = await makeDocument()
    const content = contentCapability({ store, types: new ArtifactTypes() })
    const refused = (args: unknown, of = id) =>
      content.call(context(of), 'write', args).then(
        () => null,
        (error: unknown) => (error as ContentCapabilityError).code,
      )
    expect(await refused({ baseVersion: 2, text: '# A' })).toBe('conflict')
    expect(await refused({ baseVersion: 1, text: '![x](images/none.png)' })).toBe('invalid')
    expect(await refused({ baseVersion: 1, text: '# A', extra: 1 })).toBe('invalid')
    const plain = await call('create_artifact', { title: 'Page', html: '<p>' })
    expect(await refused({ baseVersion: 1, text: '# A' }, String(plain.value.id))).toBe(
      'unsupported',
    )
    const read = await content
      .call(context(String(plain.value.id)), 'read', {})
      .catch((error: ContentCapabilityError) => error.code)
    expect(read).toBe('not_declared')
    expect((await store.get(id)).artifact.head).toBe(1)
  })

  it("gives a page the refusal's own code through the runtime", async () => {
    const id = await makeDocument()
    const handler = contentCapability({ store, types: new ArtifactTypes() })
    const dispatcher = new RuntimeDispatcher({
      artifact: async () => ({
        id,
        project: work,
        title: 'Report',
        head: 1,
        deleted: false,
        capabilities: ['content'],
        runtime: 1,
      }),
      project: (folder) => folder,
      allowed: async () => false,
      ask: async () => 'denied',
      log: () => {},
      handlers: new Map([[handler.name, handler]]),
    })
    const answer = await dispatcher.dispatch({
      artifactId: id,
      message: {
        v: 1,
        id: 'w1',
        kind: 'call',
        cap: 'content',
        op: 'write',
        args: { baseVersion: 2, text: '# A' },
      },
      client: 'test',
      signal: new AbortController().signal,
      emit: () => {},
    })
    expect(answer).toMatchObject({ id: 'w1', ok: false, error: { code: 'conflict' } })
  })
})

describe('format upgrades', () => {
  const document = BUILT_IN_TYPES.find((type) => type.name === 'document')!

  function withFormat2(migrate: (text: string) => string): ArtifactTypes {
    const next: TypePackage = {
      ...document,
      formats: {
        ...document.formats,
        2: {
          check: document.formats[1]!.check,
          migrate: (files) => {
            const text = Buffer.from(files.get('document.md')!).toString('utf8')
            return new Map([...files, ['document.md', Buffer.from(migrate(text), 'utf8')]])
          },
        },
      },
    }
    return new ArtifactTypes([next])
  }

  it('moves an artifact in an older format to the newest as a new version of the user’s', async () => {
    const id = await makeDocument()
    const version = await upgradeContent(
      store,
      withFormat2((text) => text.replace('# Quarterly', '# Moved')),
      id,
      (_, message) => logs.push(message),
    )
    expect(version).toBe(2)
    const found = await store.get(id)
    expect(found.type).toEqual({ name: 'document', format: 2 })
    expect(found.version.author).toBeNull()
    expect(found.version.note).toMatch(/2/)
    const text = (await store.bytes(found, found.files[0]!)).toString('utf8')
    expect(text.startsWith('# Moved')).toBe(true)
    expect(
      await upgradeContent(
        store,
        withFormat2((t) => t),
        id,
        () => {},
      ),
    ).toBeNull()
  })

  it('keeps the old format when the content cannot be moved', async () => {
    const id = await makeDocument()
    const failing = withFormat2(() => {
      throw new Error('Cannot move it')
    })
    expect(await upgradeContent(store, failing, id, (_, message) => logs.push(message))).toBeNull()
    expect((await store.get(id)).type).toEqual({ name: 'document', format: 1 })
    expect(logs.join(' ')).toMatch(/stays in document format 1: Cannot move it/)
    // A move whose result does not fit the new format is refused as well.
    const invalid = withFormat2((text) => `${text}\n![x](images/none.png)\n`)
    expect(await upgradeContent(store, invalid, id, () => {})).toBeNull()
    expect((await store.get(id)).artifact.head).toBe(1)
  })
})

describe('exports', () => {
  async function unzip(bytes: Uint8Array): Promise<string> {
    const file = path.join(dir, `export-${Math.random()}.zip`)
    const out = `${file}.d`
    writeFileSync(file, bytes)
    await decompress(file, out)
    return out
  }

  it('makes a Word file of a document, with its headings, table and picture', async () => {
    const id = await makeDocument()
    const [docx] = await exportVersion(store, await store.get(id), 'docx')
    expect(docx!.path).toBe('document.docx')
    const out = await unzip(docx!.bytes)
    const xml = readFileSync(path.join(out, 'word', 'document.xml'), 'utf8')
    expect(xml).toContain('Quarterly report')
    expect(xml).toMatch(/w:pStyle w:val="Heading1"/)
    expect(xml).toContain('<w:tbl>')
    expect(xml).toContain('const total = 12')
    expect(readFileSync(path.join(out, 'word', '_rels', 'document.xml.rels'), 'utf8')).toContain(
      'https://example.com/data',
    )
    expect((await import('node:fs')).readdirSync(path.join(out, 'word', 'media')).length).toBe(1)
  })

  it('exports a document as Markdown with its pictures', async () => {
    const id = await makeDocument()
    const files = await exportVersion(store, await store.get(id), 'md')
    expect(files.map((file) => file.path)).toEqual(['document.md', 'images/chart.png'])
    expect(Buffer.from(files[0]!.bytes).toString('utf8')).toBe(DOCUMENT)
  })

  it('makes a PowerPoint file of a deck, a slide each, with notes', async () => {
    const { error, value } = await call('create_artifact_from_type', {
      type: 'slides',
      title: 'Deck',
      files: [
        { path: 'slides.json', content: DECK },
        { path: 'images/chart.png', source: 'chart.png' },
      ],
    })
    expect(error).toBeNull()
    const found = await store.get(String(value.id))
    const [pptx] = await exportVersion(store, found, 'pptx')
    const out = await unzip(pptx!.bytes)
    const slides = (await import('node:fs'))
      .readdirSync(path.join(out, 'ppt', 'slides'))
      .filter((name) => name.endsWith('.xml'))
    expect(slides).toHaveLength(4)
    expect(readFileSync(path.join(out, 'ppt', 'slides', 'slide1.xml'), 'utf8')).toContain(
      'Q3 review',
    )
    expect(readFileSync(path.join(out, 'ppt', 'notesSlides', 'notesSlide1.xml'), 'utf8')).toContain(
      'Welcome',
    )
    await expect(exportVersion(store, found, 'docx')).rejects.toThrow(/does not export to docx/)
    await expect(exportVersion(store, found, 'pdf')).rejects.toThrow(/on the host/)
  })
})
