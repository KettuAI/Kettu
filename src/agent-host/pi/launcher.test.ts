// Kettu's extension for Pi: where a session's token goes, and which of Kettu's tools Pi reaches.

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { MEMORY_TOOL_NAMES } from '../memory/tools'
import { piLauncher } from './launcher'

const HELD = Symbol.for('kettu.mcp')
const dirs: string[] = []

afterEach(async () => {
  delete (globalThis as Record<symbol, unknown>)[HELD]
  delete process.env.KETTU_MCP_URL
  delete process.env.KETTU_MCP_TOKEN
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function written() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-pi-'))
  dirs.push(dir)
  const files = await piLauncher(dir, 'darwin')
  // A query string makes each test load the module afresh.
  const url = `${pathToFileURL(files.extension).href}?${dirs.length}`
  const extension = ((await import(url)) as { default: (pi: unknown) => void }).default
  return { files, extension }
}

describe("Kettu's extension for Pi", () => {
  it('registers only the memory tools, and takes the token out of the environment', async () => {
    process.env.KETTU_MCP_URL = 'http://127.0.0.1:4100/mcp'
    process.env.KETTU_MCP_TOKEN = 'session-token'
    const { files, extension } = await written()
    const registered: unknown[] = []
    extension({ registerMcpServer: (...args: unknown[]) => registered.push(args) })
    expect(registered).toEqual([
      [
        'kettu',
        {
          url: 'http://127.0.0.1:4100/mcp',
          headers: { Authorization: 'Bearer session-token' },
          exposure: 'hidden',
          toolExposure: Object.fromEntries(MEMORY_TOOL_NAMES.map((name) => [name, 'direct'])),
        },
      ],
    ])
    expect(process.env.KETTU_MCP_URL).toBeUndefined()
    expect(process.env.KETTU_MCP_TOKEN).toBeUndefined()
    expect((await stat(files.command)).mode & 0o111).not.toBe(0)
    expect(await readFile(files.command, 'utf8')).toContain(
      'exec "$KETTU_PI_COMMAND" -e "$KETTU_PI_EXTENSION" "$@"',
    )
  })

  it('does nothing in a Pi without MCP, and still takes the token out', async () => {
    process.env.KETTU_MCP_URL = 'http://127.0.0.1:4100/mcp'
    process.env.KETTU_MCP_TOKEN = 'session-token'
    const { extension } = await written()
    expect(() => extension({})).not.toThrow()
    expect(process.env.KETTU_MCP_TOKEN).toBeUndefined()
  })

  it('registers nothing for a session without the service', async () => {
    const { extension } = await written()
    const registered: unknown[] = []
    extension({ registerMcpServer: (...args: unknown[]) => registered.push(args) })
    expect(registered).toEqual([])
  })
})
