import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { declaredServers } from './project-mcp'

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'kettu-mcp-json-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function mcpJson(dir: string, value: unknown): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, '.mcp.json'), JSON.stringify(value))
}

describe("the servers a folder's .mcp.json files declare", () => {
  it('reads the folder and every folder above it, the nearer file winning a name', async () => {
    const repo = path.join(root, 'repo')
    const sub = path.join(repo, 'packages', 'app')
    await mcpJson(root, {
      mcpServers: {
        shared: { type: 'http', url: 'https://example.com/mcp' },
        db: { command: 'old-db' },
      },
    })
    await mcpJson(repo, { mcpServers: { db: { command: 'npx', args: ['-y', 'db-mcp', 7] } } })
    await mkdir(sub, { recursive: true })
    expect(await declaredServers(sub)).toEqual([
      { name: 'db', target: 'npx -y db-mcp' },
      { name: 'shared', target: 'https://example.com/mcp' },
    ])
  })

  it('takes a file with a byte order mark, and none from a file it cannot parse', async () => {
    const logged: string[] = []
    await mkdir(path.join(root, 'a'), { recursive: true })
    await writeFile(
      path.join(root, 'a', '.mcp.json'),
      '﻿' + JSON.stringify({ mcpServers: { x: { command: 'x' } } }),
    )
    await writeFile(path.join(root, '.mcp.json'), '{ not json')
    expect(await declaredServers(path.join(root, 'a'), (m) => logged.push(m))).toEqual([
      { name: 'x', target: 'x' },
    ])
    expect(logged).toHaveLength(1)
  })

  it('names a server whose config it cannot read, and cuts a long command', async () => {
    await mcpJson(root, { mcpServers: { odd: 'yes', long: { command: 'a'.repeat(500) } } })
    const servers = await declaredServers(root)
    expect(servers[0]).toEqual({ name: 'odd', target: '' })
    expect(servers[1]?.target.length).toBeLessThanOrEqual(300)
  })

  it('declares none where no file is', async () => {
    expect(await declaredServers(root)).toEqual([])
  })
})
