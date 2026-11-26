import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { summarizeParams } from '@shared/log/requests'
import type { MarketServer } from '@shared/marketplace'
import { checkMcp } from './mcp-check'

const server: MarketServer = {
  id: 'manual:example',
  name: 'fixture',
  title: 'Fixture',
  source: 'manual',
  version: null,
  on: true,
  agents: 'all',
  spec: {
    type: 'stdio',
    command: process.execPath,
    args: ['-e', 'process.stderr.write(process.env.FIXTURE_KEY + " failed"); process.exit(1)'],
    env: [{ name: 'FIXTURE_KEY', required: true, secret: true, input: true }],
  },
}

describe('checking a configured MCP server', () => {
  it('masks inputs in stderr and keeps pasted config out of request records', async () => {
    const value = 'demo'
    const out = await checkMcp(server, new Map([['FIXTURE_KEY', value]]), {
      env: process.env,
      home: os.homedir(),
      platform: process.platform as 'darwin' | 'win32' | 'linux',
    })
    expect(out).toMatchObject({ state: 'error', reason: 'exited', detail: '<redacted> failed' })
    expect(
      JSON.stringify(summarizeParams({ text: JSON.stringify({ env: { FIXTURE_KEY: value } }) })),
    ).not.toContain(value)
  })
})
