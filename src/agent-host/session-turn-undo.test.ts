import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ToolEntry } from '@shared/thread'
import { FakeAppServer, turn } from './testing/fake-app-server'
import { startTestHost, type TestHost } from './testing/harness'
import { tempFolder } from './testing/temp'

vi.setConfig({ testTimeout: 60_000 })

const hosts: TestHost[] = []
let userData: string | null = null

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
  if (userData) {
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    userData = null
  }
})

function fakeCodex() {
  const server = new FakeAppServer()
  const started = new Map<string, { threadId: string; turnId: string }>()
  server.on('turn/start', (params, self) => {
    const turnId = self.nextTurnId()
    const text = (params.input as { text?: string }[])[0]?.text
    if (text) started.set(text, { threadId: params.threadId as string, turnId })
    return { turn: turn(turnId) }
  })
  return { server, started }
}

it('previews, detects stale files, applies turn undo, marks entries undone, and persists across restart', async () => {
  userData = await tempFolder('kettu-session-undo-')
  const { server, started } = fakeCodex()
  const host = await startTestHost({
    userDataPath: userData,
    fakeAppServer: server,
    sessionTimings: { checkpointMs: 10 },
  })
  hosts.push(host)

  const fileA = path.join(host.project, 'a.ts')
  const fileB = path.join(host.project, 'b.ts')
  await writeFile(fileA, 'const a = 1\n', 'utf8')

  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'codex',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')

  // Run turn 1 modifying a.ts and creating b.ts.
  await window.request('sessions.queue', {
    sessionId: id,
    content: [{ type: 'text', text: 'turn 1' }],
  })
  await vi.waitFor(() => expect(started.has('turn 1')).toBe(true))
  const t1 = started.get('turn 1')!

  await writeFile(fileA, 'const a = 2\n', 'utf8')
  await writeFile(fileB, 'export const b = true\n', 'utf8')
  server.notify('item/completed', {
    threadId: t1.threadId,
    turnId: t1.turnId,
    item: {
      type: 'fileChange',
      id: 'fc-1',
      status: 'completed',
      changes: [
        {
          path: fileA,
          kind: { type: 'update', move_path: null },
          diff: '@@ -1 +1 @@\n-const a = 1\n+const a = 2\n',
        },
        {
          path: fileB,
          kind: { type: 'add' },
          diff: 'export const b = true\n',
        },
      ],
    },
  })

  // While the session is actively running, preview and apply must be rejected as busy.
  await expect(
    window.request('sessions.previewUndoTurn', { sessionId: id, toolIds: ['t:fc-1'] }),
  ).rejects.toThrow()

  server.notify('turn/completed', { threadId: t1.threadId, turn: turn(t1.turnId, 'completed') })
  await window.until(() => window.summary(id)?.status === 'ready')

  const toolEntries = window
    .entries(id)
    .filter((entry): entry is ToolEntry => entry.kind === 'tool')
  expect(toolEntries).toHaveLength(1)
  const toolId = toolEntries[0]!.id

  // Run turn 2 touching another file to verify cross-turn validation too.
  await window.request('sessions.queue', {
    sessionId: id,
    content: [{ type: 'text', text: 'turn 2' }],
  })
  await vi.waitFor(() => expect(started.has('turn 2')).toBe(true))
  const t2 = started.get('turn 2')!
  const fileC = path.join(host.project, 'c.ts')
  await writeFile(fileC, 'export const c = 1\n', 'utf8')
  server.notify('item/completed', {
    threadId: t2.threadId,
    turnId: t2.turnId,
    item: {
      type: 'fileChange',
      id: 'fc-2',
      status: 'completed',
      changes: [{ path: fileC, kind: { type: 'add' }, diff: 'export const c = 1\n' }],
    },
  })
  server.notify('turn/completed', { threadId: t2.threadId, turn: turn(t2.turnId, 'completed') })
  await window.until(() => window.summary(id)?.status === 'ready')
  const toolId2 = window
    .entries(id)
    .filter((entry): entry is ToolEntry => entry.kind === 'tool')[1]!.id

  // Cross-turn toolIds must be rejected.
  await expect(
    window.request('sessions.previewUndoTurn', { sessionId: id, toolIds: [toolId, toolId2] }),
  ).rejects.toThrow()

  // Preview turn 1 cleanly.
  const preview = await window.request('sessions.previewUndoTurn', {
    sessionId: id,
    toolIds: [toolId],
  })
  expect(preview.canApply).toBe(true)
  expect(preview.affectedFiles.map((f) => [f.path, f.action])).toEqual([
    ['a.ts', 'revert'],
    ['b.ts', 'delete'],
  ])

  // Modify a.ts on disk after preview opened -> undoTurn detects stale and writes nothing.
  await writeFile(fileA, 'const a = 2\n// user note\n', 'utf8')
  const stale = await window.request('sessions.undoTurn', {
    sessionId: id,
    toolIds: [toolId],
    expectedDigests: preview.fileDigests,
  })
  expect(stale.status).toBe('stale')
  if (stale.status !== 'stale') throw new Error('expected stale')
  expect(stale.changedPaths).toEqual(['a.ts'])
  expect(await readFile(fileB, 'utf8')).toBe('export const b = true\n')

  // Apply using the freshly re-verified digests -> reverts a.ts (keeping user note) and deletes b.ts.
  const applied = await window.request('sessions.undoTurn', {
    sessionId: id,
    toolIds: [toolId],
    expectedDigests: stale.preview.fileDigests,
  })
  expect(applied).toEqual({
    status: 'applied',
    revertedFiles: ['a.ts'],
    deletedFiles: ['b.ts'],
    restoredFiles: [],
  })
  expect(await readFile(fileA, 'utf8')).toBe('const a = 1\n// user note\n')
  await expect(readFile(fileB, 'utf8')).rejects.toThrow()
  // Turn 2's file stays untouched.
  expect(await readFile(fileC, 'utf8')).toBe('export const c = 1\n')

  // Tool entry is marked undone in the live thread and persists across restart.
  await window.until(
    () =>
      (window.entries(id).find((entry) => entry.id === toolId) as ToolEntry | undefined)?.undone ===
      true,
  )

  await host.stop()
  hosts.splice(0)

  const restarted = await startTestHost({
    userDataPath: userData,
    fakeAppServer: fakeCodex().server,
    sessionTimings: { checkpointMs: 10 },
  })
  hosts.push(restarted)
  const reopened = restarted.connect()
  const snap = await reopened.open(id)
  const persistedTool = snap.entries.find((entry) => entry.id === toolId) as ToolEntry | undefined
  expect(persistedTool?.undone).toBe(true)

  const previewAgain = await reopened.request('sessions.previewUndoTurn', {
    sessionId: id,
    toolIds: [toolId],
  })
  expect(previewAgain.alreadyUndone).toBe(true)
  expect(previewAgain.canApply).toBe(false)
})
