import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProgramRun } from '../adapter-install'
import type { McpServer } from '../connection'
import { TextRing } from '../ring'
import {
  AgyContextEstimator,
  estimateAgySkills,
  estimateMcpToolList,
  parseAgySkillsReply,
  type FetchFn,
} from './agy-context'

function finished(stdout: string, extra: Partial<ProgramRun> = {}): ProgramRun {
  return {
    code: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    output: new TextRing(64),
    stdout,
    ...extra,
  }
}

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('agy-context', () => {
  it('解析 /skills JSON 并过滤 model_invocable 为 false 的技能', () => {
    const parsed = parseAgySkillsReply({
      status: 'SUCCESS',
      command: {
        name: 'skills',
        data: {
          skills: [
            {
              name: 'alpha',
              description: 'Alpha skill description',
              path: '/skills/alpha/SKILL.md',
              model_invocable: true,
            },
            {
              name: 'swarm',
              description: 'Hidden from model',
              path: '/skills/swarm/SKILL.md',
              model_invocable: false,
            },
          ],
        },
      },
    })
    expect(parsed).toHaveLength(2)
    const estimates = estimateAgySkills(parsed!)
    expect(estimates.map((item) => item.name)).toEqual(['alpha'])
    expect(estimates[0]!.tokens).toBeGreaterThan(0)
  })

  it('按工具 schema 字节数估算 MCP 工具列表 token', () => {
    const count = estimateMcpToolList([
      {
        name: 'read_artifact',
        description: 'Read an artifact',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
      },
    ])
    expect(count).toBeGreaterThan(10)
    expect(estimateMcpToolList([{ bad: true }])).toBeNull()
  })

  it('结合 CLI /skills、HTTP MCP tools/list 与磁盘 mcp_config.json 生成定义估算，并缓存结果', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'agy-ctx-'))
    tempDirs.push(home)
    await mkdir(path.join(home, '.gemini', 'config'), { recursive: true })
    await writeFile(
      path.join(home, '.gemini', 'config', 'mcp_config.json'),
      JSON.stringify({
        mcpServers: {
          shadcn: { command: 'npx', args: ['shadcn@latest', 'mcp'] },
          disabledOne: { command: 'echo', disabled: true },
        },
      }),
    )

    let cliCalls = 0
    const run = vi.fn(async () => {
      cliCalls++
      return finished(
        JSON.stringify({
          status: 'SUCCESS',
          command: {
            name: 'skills',
            data: {
              skills: [
                {
                  name: 'frontend-design',
                  description: 'Design distinctive UI',
                  path: '/home/.agents/skills/frontend-design/SKILL.md',
                  model_invocable: true,
                },
              ],
            },
          },
        }),
      )
    })

    const fetchMock: FetchFn = vi.fn(async (_url, init) => {
      const method = init?.method ?? 'POST'
      if (method === 'DELETE') return new Response(null, { status: 204 })
      const body = JSON.parse(String(init?.body)) as { method: string }
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'mcp-session-id': 'sid-1' },
        })
      }
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          result: {
            tools: [
              {
                name: 'list_sessions',
                description: 'List active sessions',
                inputSchema: { type: 'object', properties: {} },
              },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })

    const estimator = new AgyContextEstimator({
      program: 'agy',
      args: [],
      home,
      run,
      fetch: fetchMock,
      now: () => 10_000,
    })

    const servers: McpServer[] = [
      {
        type: 'http',
        name: 'kettu',
        url: 'http://127.0.0.1:9999/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer secret' }],
      },
    ]

    const first = await estimator.read('/repo', servers)
    expect(first.skills).toEqual([{ name: 'frontend-design', tokens: expect.any(Number) }])
    expect(first.mcpServers).toEqual([
      { name: 'kettu', tokens: expect.any(Number) },
      { name: 'shadcn', tokens: null },
    ])

    // 缓存命中时不再重复调用 agy CLI。
    await estimator.read('/repo', servers)
    expect(cliCalls).toBe(1)
  })

  it('agy CLI 未登录或失败时自动回退扫描磁盘上的技能目录', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agy-ctx-disk-'))
    tempDirs.push(root)
    const home = path.join(root, 'home')
    const cwd = path.join(root, 'repo')
    await mkdir(path.join(home, '.agents', 'skills', 'demo-skill'), { recursive: true })
    await writeFile(
      path.join(home, '.agents', 'skills', 'demo-skill', 'SKILL.md'),
      '---\nname: demo-skill\ndescription: Local skill fallback\n---\nBody',
    )

    const estimator = new AgyContextEstimator({
      program: 'agy',
      home,
      run: async (options) => {
        options.onOutput?.('Authentication required')
        return finished('', { code: 1, aborted: true })
      },
    })

    const result = await estimator.read(cwd, [])
    expect(result.skills).toEqual([{ name: 'demo-skill', tokens: expect.any(Number) }])
    expect(result.mcpServers).toEqual([])
  })
})
