import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectMcpAnswers } from './project-mcp'
import { namesDigest, serverDigest } from './project-settings'
import { migrate, parseProjectMcpFile, PROJECT_MCP_MIGRATIONS, projectMcpFile } from './storage'

let dir: string
const stores: ProjectMcpAnswers[] = []

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kettu-project-mcp-'))
})

afterEach(async () => {
  // An answer's write may still be on its way to the folder.
  await Promise.all(stores.splice(0).map((store) => store.flush()))
  await rm(dir, { recursive: true, force: true })
})

async function answers(): Promise<ProjectMcpAnswers> {
  const store = new ProjectMcpAnswers(projectMcpFile(dir, () => {}))
  stores.push(store)
  await store.load()
  return store
}

const command = (name: string, args: string[] = [], env: string[] = []) => ({
  name,
  digest: serverDigest({
    type: 'stdio',
    command: 'npx',
    args,
    env: env.map((key) => ({ name: key, input: true as const, secret: true, required: true })),
  }),
})

const db = command('db', ['db-server'])
const webSpec = { type: 'stdio' as const, command: 'npx', args: ['web-server'], env: [] }
const web = command('web', ['web-server'])

describe("a folder's own MCP servers", () => {
  it('hold every server nobody answered for', async () => {
    const store = await answers()
    expect(store.allowed('/repo', db)).toBeNull()
    expect(store.held('/repo', [db, web])).toEqual([db, web])
  })

  it('let the servers the user allowed start, in that folder only', async () => {
    const store = await answers()
    store.answer('/repo', [db], 'use')
    expect(store.held('/repo', [db, web])).toEqual([web])
    expect(store.allowed('/repo', web)).toBeNull()
    expect(store.held('/other', [db])).toEqual([db])
  })

  it('ask again once a command, an argument, a variable name, a URL or a header name changes', async () => {
    const store = await answers()
    const remote = (url: string, headers: string[]) => ({
      name: 'api',
      digest: serverDigest({
        type: 'http',
        url,
        transport: 'streamable-http',
        headers: headers.map((key) => ({ name: key, value: 'x' })),
      }),
    })
    const allowed = [command('db', ['a'], ['TOKEN']), remote('https://a.example/mcp', ['X-Key'])]
    store.answer('/repo', allowed, 'use')
    expect(store.held('/repo', allowed)).toEqual([])
    expect(store.allowed('/repo', command('db', ['b'], ['TOKEN']))).toBeNull()
    expect(store.allowed('/repo', command('db', ['a'], ['TOKEN', 'MORE']))).toBeNull()
    expect(store.allowed('/repo', remote('https://b.example/mcp', ['X-Key']))).toBeNull()
    expect(store.allowed('/repo', remote('https://a.example/mcp', ['X-Other']))).toBeNull()
    // The name alone does not make it another server.
    expect(store.allowed('/repo', { ...allowed[0]!, name: 'renamed' })).toBe(true)
  })

  it('ask again once only the value of a variable or a header changes', async () => {
    const store = await answers()
    const spec = {
      type: 'stdio' as const,
      command: 'node',
      args: ['server.js'],
      env: [{ name: 'NODE_OPTIONS', input: true as const, secret: true, required: true }],
    }
    const server = (value: string) => ({
      name: 'db',
      digest: serverDigest(spec, { NODE_OPTIONS: value }),
    })
    store.answer('/repo', [server('--max-old-space-size=4096')], 'use')
    expect(store.allowed('/repo', server('--max-old-space-size=4096'))).toBe(true)
    expect(store.allowed('/repo', server('--require /tmp/evil.js'))).toBeNull()
    const remote = (value: string) =>
      serverDigest({
        type: 'http',
        url: 'https://a.example/mcp',
        transport: 'streamable-http',
        headers: [{ name: 'X-Key', value }],
      })
    expect(remote('one')).not.toBe(remote('two'))
  })

  it('keep only a hash of the values, never a value', async () => {
    const repo = path.join(dir, 'repo')
    await mkdir(repo)
    const store = await answers()
    const spec = {
      type: 'stdio' as const,
      command: 'x',
      args: [],
      env: [{ name: 'TOKEN', input: true as const, secret: true, required: true }],
    }
    store.answer(
      repo,
      [{ name: 'db', digest: serverDigest(spec, { TOKEN: 'sk-secret-value' }) }],
      'use',
    )
    await store.flush()
    const saved = await readFile(path.join(dir, 'state', 'project-mcp.json'), 'utf8')
    expect(saved).not.toContain('sk-secret-value')
  })

  it('let every server of the folder start after all, later ones too, but not a refused one', async () => {
    const store = await answers()
    const old = command('old', ['old'])
    store.answer('/repo', [old], 'skip')
    store.answer('/repo', [db], 'all')
    expect(store.held('/repo', [db, command('added-later', ['x']), old])).toEqual([old])
  })

  it('keep a refused server off, and an answer replaces the one before it', async () => {
    const store = await answers()
    store.answer('/repo', [db], 'skip')
    expect(store.allowed('/repo', db)).toBe(false)
    store.answer('/repo', [db], 'use')
    expect(store.allowed('/repo', db)).toBe(true)
    store.answer('/repo', [db], 'skip')
    expect(store.allowed('/repo', db)).toBe(false)
  })

  it('keep the answers on disk, in Kettu’s data and not in the project', async () => {
    const repo = path.join(dir, 'repo')
    await mkdir(repo)
    const store = await answers()
    store.answer(repo, [db], 'use')
    store.answer(repo, [web], 'skip')
    await store.flush()
    const again = await answers()
    expect(again.allowed(repo, db)).toBe(true)
    expect(again.allowed(repo, web)).toBe(false)
    const saved = JSON.parse(await readFile(path.join(dir, 'state', 'project-mcp.json'), 'utf8'))
    expect(saved).toEqual({
      version: 3,
      folders: { [repo]: { servers: { [db.digest]: true, [web.digest]: false } } },
    })
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(repo)).toEqual([])
  })

  it('take over the answers an older version kept by name, once for the server seen then', async () => {
    await mkdir(path.join(dir, 'state'))
    await writeFile(
      path.join(dir, 'state', 'project-mcp.json'),
      JSON.stringify({ version: 1, folders: { '/repo': { use: ['db'], skip: ['web'] } } }),
    )
    const store = await answers()
    expect(store.allowed('/repo', db)).toBe(true)
    expect(store.allowed('/repo', web)).toBe(false)
    // Taken over by content: the same name with another command asks again.
    expect(store.allowed('/repo', command('db', ['changed']))).toBeNull()
    expect(store.allowed('/repo', db)).toBe(true)
    await store.flush()
    const saved = JSON.parse(await readFile(path.join(dir, 'state', 'project-mcp.json'), 'utf8'))
    expect(saved).toEqual({
      version: 3,
      folders: { '/repo': { servers: { [db.digest]: true, [web.digest]: false } } },
    })
  })

  it('take over the answers kept by a digest of names alone, once for the server seen then', async () => {
    const spec = {
      type: 'stdio' as const,
      command: 'npx',
      args: ['db-server'],
      env: [{ name: 'TOKEN', input: true as const, secret: true, required: true }],
    }
    const seen = {
      name: 'db',
      digest: serverDigest(spec, { TOKEN: 'a' }),
      namesDigest: namesDigest(spec),
    }
    const refused = command('web', ['web-server'])
    await mkdir(path.join(dir, 'state'))
    await writeFile(
      path.join(dir, 'state', 'project-mcp.json'),
      JSON.stringify({
        version: 2,
        folders: {
          '/repo': {
            servers: { [namesDigest(spec)]: true, [namesDigest(webSpec)]: false },
          },
        },
      }),
    )
    const store = await answers()
    expect(store.allowed('/repo', seen)).toBe(true)
    expect(store.allowed('/repo', { ...refused, namesDigest: namesDigest(webSpec) })).toBe(false)
    // Taken over by the full digest: another value now asks again.
    const changed = { ...seen, digest: serverDigest(spec, { TOKEN: 'b' }) }
    expect(store.allowed('/repo', changed)).toBeNull()
    expect(store.allowed('/repo', seen)).toBe(true)
    await store.flush()
    const saved = JSON.parse(await readFile(path.join(dir, 'state', 'project-mcp.json'), 'utf8'))
    expect(saved).toEqual({
      version: 3,
      folders: { '/repo': { servers: { [seen.digest]: true, [refused.digest]: false } } },
    })
  })

  it('migrate a file another version wrote, keeping every answer and all', () => {
    const migrated = migrate(
      { version: 1, folders: { '/repo': { all: true, use: ['db'], skip: [] }, '/none': {} } },
      3,
      PROJECT_MCP_MIGRATIONS,
    )
    expect(migrated).toEqual({
      kind: 'ok',
      from: 1,
      data: {
        version: 3,
        folders: {
          '/repo': { all: true, servers: {}, named: { use: ['db'], skip: [] } },
          '/none': { servers: {} },
        },
      },
    })
    expect(
      migrate(
        { version: 2, folders: { '/repo': { all: true, servers: { d: true, e: false } } } },
        3,
        PROJECT_MCP_MIGRATIONS,
      ),
    ).toEqual({
      kind: 'ok',
      from: 2,
      data: {
        version: 3,
        folders: { '/repo': { all: true, servers: {}, earlier: { d: true, e: false } } },
      },
    })
  })

  it('read a file without trusting what it cannot read', async () => {
    expect(
      parseProjectMcpFile({
        folders: {
          '/repo': { all: true, servers: { a: true, b: 'yes' }, named: { use: ['db', 3] } },
          '/bad': 'yes',
          '/other': { all: 'yes', servers: { c: false } },
        },
      }),
    ).toEqual({
      version: 3,
      folders: {
        '/repo': { all: true, servers: { a: true }, named: { use: ['db'], skip: [] } },
        '/other': { servers: { c: false } },
      },
    })
    expect(typeof parseProjectMcpFile({ folders: [] })).toBe('string')
  })

  it('never let a folder or a digest named like an object property through', async () => {
    const store = await answers()
    expect(store.allowed('constructor', { name: 'x', digest: 'toString' })).toBeNull()
    expect(store.held('__proto__', [db])).toEqual([db])
    store.answer('/repo', [db], 'use')
    expect(store.allowed('/repo', { name: 'x', digest: 'hasOwnProperty' })).toBeNull()
  })
})
