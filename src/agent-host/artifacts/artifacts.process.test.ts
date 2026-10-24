// Process test: the fake agent as a process of its own reaches the artifacts service over
// 127.0.0.1 with the official MCP client, from two sessions in two projects.

import { mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { processLauncher } from '../agents'
import { startTestHost, type TestPort } from '../testing/harness'

function turnEnds(port: TestPort, sessionId: string): number {
  return port.entries(sessionId).filter((entry) => entry.kind === 'turn_end').length
}

async function run(port: TestPort, sessionId: string, text: string): Promise<string> {
  const before = turnEnds(port, sessionId)
  await port.request('sessions.prompt', { sessionId, content: [{ type: 'text', text }] })
  await port.until(() => turnEnds(port, sessionId) > before, 15_000)
  const reply = port.entries(sessionId).findLast((entry) => entry.kind === 'agent')
  return reply?.kind === 'agent' ? reply.markdown : ''
}

describe('the artifacts service with the fake agent as a process', () => {
  it('creates, updates and reads artifacts from two sessions in two projects', async () => {
    const t = await startTestHost({
      launcher: processLauncher(process.platform),
      agentEnv: { FAKE_AGENT_DELAY_SCALE: '0' },
    })
    try {
      const port = t.connect()
      const otherDir = path.join(t.dir, 'other')
      await mkdir(otherDir)
      const other = await realpath(otherDir)
      await port.request('projects.add', { path: other })
      const open = async (projectPath: string) => {
        const summary = await port.request('sessions.create', {
          agentId: 'fake-agent',
          projectPath,
        })
        await port.open(summary.id)
        return summary.id
      }
      const a = await open(t.project)
      const b = await open(other)

      expect(await run(port, a, '/artifacts')).toMatch(
        /create_artifact: Created (art_\w+) version 1, a canvas of 2 pages\.[\s\S]*html: revision 1$/,
      )
      expect(await run(port, b, '/artifacts')).toMatch(/create_artifact: Created art_\w+ version 1/)
      const updated = await run(port, a, '/artifacts')
      expect(updated).toMatch(/update_artifact: Updated art_\w+ to version 2/)
      expect(updated).toMatch(/read_artifact: art_\w+, "Fake canvas", version 2 of 2/)
      expect(updated).toMatch(/html: revision 2$/)

      const listed = await port.request('artifacts.list', {})
      const inA = listed.find((artifact) => artifact.sessionId === a)!
      const inB = listed.find((artifact) => artifact.sessionId === b)!
      expect(inA).toMatchObject({ project: t.project, version: 2, pages: 2 })
      expect(inB).toMatchObject({ project: other, version: 1, pages: 2 })
      expect(await run(port, b, `/artifacts --read ${inA.id}`)).toBe(
        `read_artifact: No artifact ${inA.id} in this project. ` +
          'list_artifacts shows the ones you can use.',
      )
      expect(await run(port, a, `/artifacts --read ${inB.id}`)).toMatch(
        /^read_artifact: No artifact/,
      )
      const read = await port.request('artifacts.read', { id: inA.id })
      expect(read.html).toContain('revision 2')
    } finally {
      await t.stop()
    }
  })
})
