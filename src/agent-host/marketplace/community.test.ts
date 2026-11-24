import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  MarketAccount,
  MarketCall,
  MarketListing,
  MineListing,
  VersionFile,
} from '@shared/market-publish'
import { setLocale } from '../i18n'
import { MarketCommunityService, safeFilePath, writeFolder } from './community'
import { WorkflowLibrary, workflowsFile } from '../workflow/library'
import { WorkflowTools } from '../workflow/tools'
import { MarketCallError } from './publish-tools'
import { MarketSkillsService, skillsCatalogFile } from './skills'

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'kettu-community-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const ACCOUNT: MarketAccount = { name: 'Bea', email: 'b@example.com' }
const log = () => {}

function listing(over: Partial<MarketListing> = {}): MarketListing {
  return {
    id: 'abcdefgh23',
    handle: 'amigoer',
    slug: 'changelog-writer',
    name: 'Changelog writer',
    kind: 'skill',
    description: 'One line per change.',
    visibility: 'public',
    official: false,
    version: '1.0.0',
    versions: ['1.0.0'],
    installs: 12,
    updatedAt: '2026-11-14T00:00:00.000Z',
    mine: false,
    ...over,
  }
}

function mineListing(over: Partial<MineListing> = {}): MineListing {
  return {
    id: 'mineaaaa23',
    handle: 'bea',
    slug: 'notes',
    name: 'Notes',
    kind: 'skill',
    description: 'My notes.',
    visibility: 'private',
    official: false,
    current: '1.0.0',
    versions: [],
    installs: { total: 0, week: 0, days: [] },
    takenDown: null,
    createdAt: 'x',
    updatedAt: 'x',
    ...over,
  }
}

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')

const SKILL = '---\nname: changelog-writer\ndescription: One line per change.\n---\n\nWrite it.\n'

interface Fake {
  calls: MarketCall[]
  listings: Record<string, MarketListing | MarketCallError>
  files: Record<string, string>
  /** What the version lists, by path, when it differs from the files. */
  listed?: VersionFile[]
  /** What the file answer's X-Content-SHA256 says, by path. */
  sent?: Record<string, string>
  mine?: MineListing[]
  directory?: MarketListing[]
  nextDirectoryPage?: MarketListing[]
}

function fake(over: Partial<Fake> = {}): Fake {
  return {
    calls: [],
    listings: { abcdefgh23: listing() },
    files: { 'SKILL.md': SKILL },
    ...over,
  }
}

function service(
  f: Fake,
  extra: {
    account?: MarketAccount | null
    workflows?: WorkflowLibrary
    now?: () => number
  } = {},
) {
  return new MarketCommunityService({
    userDataPath: root,
    log,
    now: extra.now,
    account: () => (extra.account === undefined ? ACCOUNT : extra.account),
    kept: () => [],
    call: (async (call: MarketCall) => {
      f.calls.push(call)
      switch (call.kind) {
        case 'directory':
          return call.cursor
            ? { items: f.nextDirectoryPage ?? [], next: null }
            : { items: f.directory ?? [], next: f.nextDirectoryPage ? 'page-2' : null }
        case 'mine':
          return { publisher: null, listings: f.mine ?? [], storage: { bytes: 0, limit: 1 } }
        case 'listing': {
          const found = f.listings[call.id]
          if (!found) {
            throw new MarketCallError({ code: 'not_found', status: 404, message: 'Not found' })
          }
          if (found instanceof MarketCallError) throw found
          return found
        }
        case 'version':
          return {
            files:
              f.listed ??
              Object.entries(f.files).map(([file, data]) => ({
                path: file,
                size: Buffer.byteLength(data),
                sha256: sha(data),
              })),
          }
        case 'file': {
          const data = f.files[call.path] ?? ''
          return {
            data: Buffer.from(data).toString('base64'),
            sha256: f.sent?.[call.path] ?? sha(data),
          }
        }
        case 'install':
        case 'report':
          return null
        default:
          throw new Error(`unexpected ${call.kind}`)
      }
    }) as never,
    installWorkflow: (text, origin) => {
      if (!extra.workflows) throw new Error('no workflow library')
      return extra.workflows.installListing(text, origin)
    },
  })
}

/** The host's workflow library, kept in its own files under the host's data. */
async function workflowLibrary(): Promise<WorkflowLibrary> {
  const lib = new WorkflowLibrary({
    dir: path.join(root, 'workflows'),
    file: workflowsFile(root, log),
    knownTools: () => ({ mcp: new Set(), skills: new Set() }),
    log,
  })
  await lib.load()
  return lib
}

function skills(community: MarketCommunityService) {
  return new MarketSkillsService({
    userDataPath: root,
    file: skillsCatalogFile(root, log),
    log,
    platform: 'darwin',
    home: root,
    settings: () => [],
    agents: () => [],
    configFolder: () => null,
    codexSkills: () => Promise.resolve(null),
    kettu: (id) => community.download(id, 'skill'),
  })
}

/** Every file under the host's data, by its path there. */
async function written(): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort()
}

describe('safeFilePath', () => {
  it('takes the relative paths a version holds', () => {
    for (const ok of ['SKILL.md', 'scripts/run.sh', 'a/b/c.txt', '.claude-plugin/plugin.json']) {
      expect(safeFilePath(ok)).toBe(true)
    }
  })

  it('refuses every path that could leave the install folder', () => {
    for (const bad of [
      '',
      '/etc/passwd',
      '../outside',
      'a/../../b',
      'a/./b',
      'a//b',
      'a\\..\\b',
      'C:/Windows/x',
      'c:x',
      '.git/config',
      'a/.git/hooks/pre-commit',
      'name.',
      'name ',
      'a\nb',
      `a/${'x'.repeat(600)}`,
    ]) {
      expect(safeFilePath(bad), bad).toBe(false)
    }
  })
})

describe('writeFolder', () => {
  it('writes nothing outside the folder, whatever the path says', async () => {
    const dir = path.join(root, 'plugins', 'x')
    await expect(
      writeFolder(dir, [
        { path: 'ok.txt', data: Buffer.from('ok') },
        { path: '../../escaped.txt', data: Buffer.from('no') },
      ]),
    ).rejects.toThrow()
    expect(await written()).toEqual([])
  })
})

describe('MarketCommunityService', () => {
  it('reads no file and runs nothing before Install', async () => {
    const f = fake({ directory: [listing()] })
    const community = service(f)
    await community.directory({})
    await community.listing('abcdefgh23')
    expect(f.calls.map((call) => call.kind).sort()).toEqual(['directory', 'listing', 'mine'])
    expect(await written()).toEqual([])
  })

  it('finds a server’s bundle from the version’s list alone, downloading nothing', async () => {
    const server = listing({ kind: 'mcp-server', server: { name: 'echo', version: '1.0.0' } })
    const f = fake({ listings: { abcdefgh23: server }, files: { 'echo.mcpb': 'zip' } })
    const page = await service(f).listing('abcdefgh23')
    expect(page).toMatchObject({
      state: 'listed',
      server: null,
      bundle: { from: 'upload', path: 'echo.mcpb', size: 3, sha256: sha('zip') },
    })
    expect(f.calls.map((call) => call.kind)).toEqual(['listing', 'version'])
    expect(await written()).toEqual([])
  })

  it('takes an https mcpb package with its SHA-256, the upload first', async () => {
    const pkg = (over: Record<string, unknown>) => ({
      registryType: 'mcpb',
      identifier: 'https://example.com/echo.mcpb',
      fileSha256: 'a'.repeat(64),
      ...over,
    })
    const page = async (packages: unknown[], files: Record<string, string> = {}) => {
      const server = listing({ kind: 'mcp-server', server: { name: 'echo', packages } })
      const got = await service(fake({ listings: { abcdefgh23: server }, files })).listing(
        'abcdefgh23',
      )
      return got.state === 'listed' ? got.bundle : undefined
    }
    expect(await page([pkg({})])).toEqual({
      from: 'url',
      url: 'https://example.com/echo.mcpb',
      sha256: 'a'.repeat(64),
    })
    expect(await page([pkg({ identifier: 'http://example.com/echo.mcpb' })])).toBeNull()
    expect(await page([pkg({ fileSha256: undefined })])).toBeNull()
    expect(await page([pkg({ fileSha256: 'abc' })])).toBeNull()
    expect(await page([pkg({})], { 'echo.mcpb': 'zip' })).toMatchObject({ from: 'upload' })
  })

  it('lists only public listings, and the account’s own Only me ones as Yours', async () => {
    const f = fake({
      directory: [
        listing(),
        listing({ id: 'privateaa2', visibility: 'private', mine: false }),
        listing({ id: 'unlistedaa', visibility: 'unlisted' }),
      ],
      mine: [
        mineListing(),
        mineListing({ id: 'publicaaa2', visibility: 'public' }),
        mineListing({ id: 'downaaaaa2', takenDown: { reason: 'x', at: 'x' } }),
        mineListing({ id: 'emptyaaaa2', current: null }),
      ],
    })
    const result = await service(f).directory({})
    expect(result.items.map((item) => item.id)).toEqual(['abcdefgh23'])
    expect(result.yours.map((item) => item.id)).toEqual(['mineaaaa23'])
    expect(result.yours[0]!.installs).toBeNull()
  })

  it('reads a group’s later pages again once its first page is refreshed', async () => {
    const f = fake({ directory: [listing()] })
    const community = service(f)
    await community.directory({ kind: 'skill' })
    await community.directory({ kind: 'skill', cursor: 'c2' })
    await community.directory({ kind: 'plugin', cursor: 'c2' })
    const pages = () => f.calls.filter((call) => call.kind === 'directory').length
    await community.directory({ kind: 'skill', cursor: 'c2' })
    expect(pages()).toBe(3)
    await community.directory({ kind: 'skill' }, true)
    expect(pages()).toBe(4)
    await community.directory({ kind: 'skill', cursor: 'c2' })
    expect(pages()).toBe(5)
    await community.directory({ kind: 'plugin', cursor: 'c2' })
    expect(pages()).toBe(5)
  })

  it('lists nothing while signed out, and asks the service nothing', async () => {
    const f = fake()
    const result = await service(f, { account: null }).directory({})
    expect(result.signedIn).toBe(false)
    expect(f.calls).toEqual([])
  })

  it('never offers another account’s Only me listing', async () => {
    const f = fake({
      listings: { abcdefgh23: listing({ visibility: 'private', mine: false }) },
    })
    const community = service(f)
    expect(await community.listing('abcdefgh23')).toEqual({ state: 'gone' })
    await expect(community.download('abcdefgh23', 'skill')).rejects.toThrow()
    expect(f.calls.some((call) => call.kind === 'version' || call.kind === 'file')).toBe(false)
  })

  it('installs the account’s own Only me listing', async () => {
    const f = fake({ listings: { abcdefgh23: listing({ visibility: 'private', mine: true }) } })
    const skill = await skills(service(f)).add({ kind: 'kettu', id: 'abcdefgh23' })
    expect(skill).toMatchObject({
      id: 'kettu:abcdefgh23',
      name: 'changelog-writer',
      source: 'kettu',
      origin: '@amigoer/changelog-writer',
      version: '1.0.0',
    })
    const files = await written()
    expect(files).toHaveLength(1)
    expect(await readFile(path.join(root, files[0]!), 'utf8')).toBe(SKILL)
  })

  it('says a taken-down listing is taken down', async () => {
    const f = fake({
      listings: {
        abcdefgh23: new MarketCallError({ code: 'taken_down', status: 410, message: 'Gone' }),
      },
    })
    expect(await service(f).listing('abcdefgh23')).toEqual({ state: 'taken-down' })
  })

  it('refuses a file whose SHA-256 does not match, and keeps nothing', async () => {
    const f = fake({
      files: { 'SKILL.md': SKILL, 'notes.md': 'tampered' },
      listed: [
        { path: 'SKILL.md', size: Buffer.byteLength(SKILL), sha256: sha(SKILL) },
        { path: 'notes.md', size: 8, sha256: sha('original') },
      ],
    })
    await expect(skills(service(f)).add({ kind: 'kettu', id: 'abcdefgh23' })).rejects.toThrow(
      /notes\.md/,
    )
    expect(await written()).toEqual([])
  })

  it('refuses a file whose answer names another SHA-256 than the version', async () => {
    const f = fake({ sent: { 'SKILL.md': sha('something else') } })
    await expect(skills(service(f)).add({ kind: 'kettu', id: 'abcdefgh23' })).rejects.toThrow()
    expect(await written()).toEqual([])
  })

  it('downloads nothing of a version that names a path outside its folder', async () => {
    const f = fake({
      listed: [
        { path: 'SKILL.md', size: Buffer.byteLength(SKILL), sha256: sha(SKILL) },
        { path: '../../evil.sh', size: 1, sha256: sha('x') },
      ],
    })
    await expect(skills(service(f)).add({ kind: 'kettu', id: 'abcdefgh23' })).rejects.toThrow()
    expect(f.calls.some((call) => call.kind === 'file')).toBe(false)
    expect(await written()).toEqual([])
  })

  it('offers no plugin listing: it is neither listed nor downloaded', async () => {
    const plugin = listing({ kind: 'plugin', harness: 'claude-code', slug: 'hello' })
    const f = fake({ listings: { abcdefgh23: plugin }, directory: [plugin] })
    const community = service(f)
    expect((await community.directory({})).items).toEqual([])
    expect(await community.listing('abcdefgh23')).toEqual({ state: 'gone' })
    await expect(community.download('abcdefgh23', 'plugin')).rejects.toThrow()
    expect(f.calls.some((call) => call.kind === 'version' || call.kind === 'file')).toBe(false)
  })

  describe('workflows', () => {
    const WORKFLOW = `format: 1
name: Release notes
description: Draft the release notes, then let you review them.
steps:
  - id: draft
    name: Draft
    prompt: Draft the notes.
    you_review: true
    outcomes:
      - name: Done
        end: done
`
    const workflowListing = (over: Partial<MarketListing> = {}) =>
      listing({ kind: 'workflow', slug: 'release-notes', name: 'Release notes', ...over })
    const published = (over: Partial<Fake> = {}) =>
      fake({
        listings: { abcdefgh23: workflowListing() },
        files: { 'workflow.yaml': WORKFLOW, 'README.md': '# Release notes\n' },
        ...over,
      })

    async function listTool(community: MarketCommunityService) {
      const library = await workflowLibrary()
      const entry = await library.create(WORKFLOW, { sessionId: 'draft', agentId: 'codex' })
      if (!('id' in entry)) throw new Error('The test workflow did not parse')
      await library.approve(entry.id, entry.hash)
      await library.create(WORKFLOW.replace('Release notes', 'Unapproved draft'), {
        sessionId: 'draft',
        agentId: 'codex',
      })
      await library.flush()
      const tools = new WorkflowTools({
        library,
        marketplace: community,
        isStep: () => false,
        agentOf: () => 'codex',
        report: () => Promise.reject(new Error('Unexpected report')),
        pick: () => Promise.reject(new Error('Unexpected pick')),
        suggestions: {
          suggest: () => Promise.reject(new Error('Unexpected suggestion')),
          draft: () => Promise.reject(new Error('Unexpected draft')),
          keep: () => Promise.reject(new Error('Unexpected workflow to keep')),
        },
      })
      return (input: unknown = {}) =>
        tools.call({ sessionId: 'chat', project: '/test' }, 'list_workflows', input)
    }

    it('lists approved library workflows and explains why the signed-out host cannot list the Marketplace', async () => {
      const f = published()
      const list = await listTool(service(f, { account: null }))
      const response = await list()
      expect(response.structuredContent).toMatchObject({
        library: [{ id: 'release-notes', name: 'Release notes' }],
        marketplace: [],
        marketplace_status: 'signed_out',
      })
      expect(response.content[0]).toMatchObject({ text: expect.stringContaining('Sign in') })
      expect(f.calls).toEqual([])
    })

    it('lists both groups in the interface language without sending any search or user text', async () => {
      const official = workflowListing({ id: 'official23', official: true, installs: 2 })
      const popular = workflowListing({ id: 'populara23', installs: 80 })
      const f = published({
        directory: [popular, workflowListing({ visibility: 'private' }), listing()],
        nextDirectoryPage: [official],
        files: {
          'workflow.yaml': WORKFLOW.replace(
            'steps:\n',
            `when: Use for release notes that need approval.
locales:
  zh-CN:
    name: 发布说明
    description: 起草并审阅发布说明。
    when: 发布说明需要审批时使用。
    steps:
      draft: 起草
steps:
`,
          ),
        },
      })
      const list = await listTool(service(f))
      const refused = await list({ q: 'Private request', task: 'Private context' })
      expect(refused.structuredContent).toMatchObject({ code: 'invalid' })
      expect(f.calls).toEqual([])
      setLocale('zh-CN')
      try {
        expect((await list()).structuredContent).toMatchObject({
          library: [{ id: 'release-notes', name: 'Release notes' }],
          marketplace: [
            {
              id: `kettu:${official.id}`,
              name: '发布说明',
              description: '起草并审阅发布说明。',
              when: '发布说明需要审批时使用。',
              steps: [{ id: 'draft', name: '起草' }],
              publisher: official.handle,
              official: true,
              installs: 2,
              version: '1.0.0',
            },
            { id: `kettu:${popular.id}`, official: false, installs: 80 },
          ],
          marketplace_status: 'available',
        })
      } finally {
        setLocale('en')
      }
      expect(f.calls).toEqual([
        { kind: 'directory', listingKind: 'workflow' },
        { kind: 'directory', listingKind: 'workflow', cursor: 'page-2' },
        { kind: 'version', id: official.id, version: '1.0.0' },
        { kind: 'version', id: popular.id, version: '1.0.0' },
        { kind: 'file', id: official.id, version: '1.0.0', path: 'workflow.yaml' },
        { kind: 'file', id: popular.id, version: '1.0.0', path: 'workflow.yaml' },
      ])
    })

    it('refreshes the directory but reads workflow text again only for a new version', async () => {
      const f = published({ directory: [workflowListing()] })
      let now = 0
      const community = service(f, { now: () => now })
      await Promise.all([community.publicWorkflows(), community.publicWorkflows()])
      expect(f.calls.map(({ kind }) => kind)).toEqual(['directory', 'version', 'file'])
      now += 5 * 60_000
      await community.publicWorkflows()
      expect(f.calls.map(({ kind }) => kind)).toEqual(['directory', 'version', 'file', 'directory'])
      f.directory = [workflowListing({ version: '1.0.1' })]
      f.files['workflow.yaml'] = WORKFLOW.replace('steps:\n', 'when: Use before release.\nsteps:\n')
      now += 5 * 60_000
      expect(await community.publicWorkflows()).toMatchObject({
        items: [{ version: '1.0.1', workflow: { when: 'Use before release.' } }],
      })
      expect(f.calls.slice(-3)).toEqual([
        { kind: 'directory', listingKind: 'workflow' },
        { kind: 'version', id: 'abcdefgh23', version: '1.0.1' },
        { kind: 'file', id: 'abcdefgh23', version: '1.0.1', path: 'workflow.yaml' },
      ])
    })

    it('keeps an installed listing in the library unapproved, with its listing and version', async () => {
      const f = published()
      const lib = await workflowLibrary()
      const entry = await service(f, { workflows: lib }).installWorkflow('abcdefgh23')
      expect(entry).toMatchObject({
        id: 'release-notes',
        source: 'community',
        approval: 'pending',
        origin: {
          kind: 'community',
          listingId: 'abcdefgh23',
          version: '1.0.0',
          handle: 'amigoer',
          slug: 'release-notes',
        },
      })
      await lib.flush()
      const stored = JSON.parse(
        await readFile(path.join(root, 'state', 'workflows.json'), 'utf8'),
      ) as { entries: Record<string, unknown> }
      expect(stored.entries['release-notes']).toEqual({
        source: 'community',
        origin: {
          kind: 'community',
          listingId: 'abcdefgh23',
          version: '1.0.0',
          handle: 'amigoer',
          slug: 'release-notes',
          official: false,
        },
        addedAt: expect.any(Number) as number,
        approved: null,
      })
      expect(await readFile(path.join(root, 'workflows', 'release-notes.yaml'), 'utf8')).toBe(
        WORKFLOW,
      )
      const again = await workflowLibrary()
      expect(again.listingIds()).toEqual(['abcdefgh23'])
      expect((await again.read('release-notes')).entry).toMatchObject({
        source: 'community',
        approval: 'pending',
      })
      expect(f.calls).toContainEqual({
        kind: 'install',
        id: 'abcdefgh23',
        version: '1.0.0',
        reason: 'install',
      })
    })

    it('replaces the installed version on update, which waits for approval again', async () => {
      const f = published()
      const lib = await workflowLibrary()
      const community = service(f, { workflows: lib })
      const first = await community.installWorkflow('abcdefgh23')
      await lib.approve(first.id, first.hash)
      const next = WORKFLOW.replace('Draft the notes.', 'Draft the notes from the merged PRs.')
      f.listings.abcdefgh23 = workflowListing({ version: '1.0.1', versions: ['1.0.0', '1.0.1'] })
      f.files['workflow.yaml'] = next
      const updated = await community.installWorkflow('abcdefgh23')
      expect(updated).toMatchObject({
        id: first.id,
        approval: 'changed',
        origin: { kind: 'community', version: '1.0.1' },
      })
      await expect(lib.resolve(first.id)).rejects.toMatchObject({ code: 'restricted' })
      expect((await lib.list()).filter((entry) => entry.source === 'community')).toHaveLength(1)
      expect(f.calls).toContainEqual({
        kind: 'install',
        id: 'abcdefgh23',
        version: '1.0.1',
        reason: 'update',
      })
    })

    it('refuses a file whose SHA-256 does not match, and writes nothing', async () => {
      const f = published({ sent: { 'README.md': sha('something else') } })
      const lib = await workflowLibrary()
      await expect(service(f, { workflows: lib }).installWorkflow('abcdefgh23')).rejects.toThrow(
        /README\.md/,
      )
      expect(await written()).toEqual([])
      expect(f.calls.some((call) => call.kind === 'install')).toBe(false)
    })

    it('refuses a workflow.yaml the workflow format refuses, saying why', async () => {
      const f = published({
        files: { 'workflow.yaml': WORKFLOW.replace('end: done', 'to: nowhere') },
      })
      const lib = await workflowLibrary()
      await expect(service(f, { workflows: lib }).installWorkflow('abcdefgh23')).rejects.toThrow(
        /nowhere/,
      )
      expect(await written()).toEqual([])
    })

    it('installs a workflow by the name of one Kettu once shipped, under the id it had', async () => {
      const lib = await workflowLibrary()
      const f = published({
        listings: { abcdefgh23: workflowListing({ handle: 'kettu-labs', official: true }) },
        files: { 'workflow.yaml': WORKFLOW.replace('Release notes', 'Fix a bug') },
      })
      const entry = await service(f, { workflows: lib }).installWorkflow('abcdefgh23')
      expect(entry).toMatchObject({
        id: 'fix-a-bug',
        source: 'community',
        approval: 'pending',
        origin: { handle: 'kettu-labs', official: true },
      })
    })

    it('reads only workflow.yaml for a listing page, keeps nothing and counts no install', async () => {
      const f = published()
      const lib = await workflowLibrary()
      const preview = await service(f, { workflows: lib }).workflow('abcdefgh23')
      expect(preview).toMatchObject({
        version: '1.0.0',
        problem: null,
        workflow: { name: 'Release notes', steps: [{ id: 'draft', youReview: true }] },
      })
      expect(f.calls.filter((call) => call.kind === 'file')).toEqual([
        { kind: 'file', id: 'abcdefgh23', version: '1.0.0', path: 'workflow.yaml' },
      ])
      expect(f.calls.some((call) => call.kind === 'install')).toBe(false)
      expect(await written()).toEqual([])
      expect(await lib.list()).toEqual([])
    })

    it('shows no flow of a workflow.yaml whose SHA-256 does not match', async () => {
      const f = published({ sent: { 'workflow.yaml': sha('something else') } })
      await expect(service(f).workflow('abcdefgh23')).rejects.toThrow(/workflow\.yaml/)
    })

    it('says why a workflow.yaml the format refuses has no flow to show', async () => {
      const f = published({
        files: { 'workflow.yaml': WORKFLOW.replace('end: done', 'to: nowhere') },
      })
      expect(await service(f).workflow('abcdefgh23')).toMatchObject({
        workflow: null,
        problem: expect.stringMatching(/nowhere/) as string,
      })
    })

    it('reads no file of a listing that is not a workflow', async () => {
      const f = fake()
      await expect(service(f).workflow('abcdefgh23')).rejects.toThrow()
      expect(f.calls.some((call) => call.kind === 'file' || call.kind === 'version')).toBe(false)
    })

    it('lists a workflow with its steps and those that wait for you', async () => {
      const f = published({
        directory: [
          workflowListing({
            adds: [
              { label: 'steps', items: ['Draft', 'Ship'] },
              { label: 'waits', items: ['Draft'] },
            ],
          }),
        ],
      })
      const page = await service(f).directory({}, true)
      expect(page.items[0]).toMatchObject({ steps: ['Draft', 'Ship'], waits: ['Draft'] })
    })

    it('refuses a listing without workflow.yaml', async () => {
      const lib = await workflowLibrary()
      const none = published({ files: { 'README.md': '# Release notes\n' } })
      await expect(service(none, { workflows: lib }).installWorkflow('abcdefgh23')).rejects.toThrow(
        /workflow\.yaml/,
      )
      expect(await written()).toEqual([])
    })

    it('installs nothing of a listing of another kind', async () => {
      const f = fake()
      const lib = await workflowLibrary()
      await expect(service(f, { workflows: lib }).installWorkflow('abcdefgh23')).rejects.toThrow()
      expect(f.calls.some((call) => call.kind === 'file')).toBe(false)
      expect(await written()).toEqual([])
    })
  })
})
