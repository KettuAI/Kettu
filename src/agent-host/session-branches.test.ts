// End-to-end tests for native Pi session branch browsing and switching (#1835):
// - browsing multi-branch imported Pi sessions (closed on disk and live)
// - switching branches via native tree navigation (both direct RPC and extension command fallback)
// - syncing displayed history across connected windows and persisting selection across reopen/restart
// - ensuring subsequent prompts append onto the switched native branch leaf
// - blocking switches while a turn is running
// - full interoperability with #2698 Edit from here rewind and clean rejection on non-Pi harnesses.

import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import type { ThreadEntry } from '@shared/thread'
import type { HostedDriver, HostedSpawnOptions } from './driver'
import { PiConnection } from './pi/connection'
import { NAVIGATE_COMMAND, NAVIGATE_READY_STATUS, NAVIGATE_STATUS } from './pi/extension'
import { readJsonLines } from './pi/jsonl'
import type { PiEntry } from './pi/protocol'
import { folderName } from './pi/session-files'
import { startTestHost, type TestHost, type TestPort } from './testing/harness'
import { tempFolder } from './testing/temp'

vi.setConfig({ testTimeout: 60_000 })

const hosts: TestHost[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
  for (const folder of dirs.splice(0)) {
    await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

const userTexts = (entries: ThreadEntry[]): string[] =>
  entries.flatMap((entry) =>
    entry.kind === 'user' && entry.content[0]?.type === 'text' ? [entry.content[0].text] : [],
  )

const agentTexts = (entries: ThreadEntry[]): string[] =>
  entries.flatMap((entry) => (entry.kind === 'agent' ? [entry.markdown] : []))

function makeEntry(
  id: string,
  parentId: string | null,
  role: 'user' | 'assistant',
  text: string,
  iso: string,
): PiEntry {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: iso,
    message: {
      role,
      content: [{ type: 'text', text }],
      timestamp: Date.parse(iso),
      ...(role === 'assistant' ? { stopReason: 'stop' as const } : {}),
    },
  }
}

interface ScriptedPiOptions {
  /** Custom Pi agent dir where seeded session JSONL files live. */
  piAgentDir: string
  /** When true, omits top-level `navigate_tree` RPC so Kettu uses its extension command fallback. */
  extensionFallback?: boolean
  /** When true, holds each prompt open until `finishTurn()` is invoked. */
  holdTurns?: boolean
}

function scriptedTreePi(options: ScriptedPiOptions) {
  const sessions = new Map<
    string,
    { file: string; cwd: string; entries: PiEntry[]; leafId: string | null }
  >()
  const navigations: { sessionId: string; targetId: string; via: 'rpc' | 'extension' }[] = []
  const forked: { from: string; entryId: string; into: string }[] = []
  let nextSession = 1
  let nextEntry = 100
  let nextTs = 1795200000000
  let heldFinish: (() => void) | null = null
  let notifyTurnStarted: (() => void) | null = null
  let turnStartedPromise = new Promise<void>((resolve) => {
    notifyTurnStarted = resolve
  })

  const persistFile = async (
    file: string,
    id: string,
    cwd: string,
    entries: readonly PiEntry[],
  ): Promise<void> => {
    await mkdir(path.dirname(file), { recursive: true })
    const header = { type: 'session', version: 3, id, cwd }
    const lines = [header, ...entries].map((item) => JSON.stringify(item))
    await writeFile(file, `${lines.join('\n')}\n`)
  }

  const seedBranchedSession = async (
    agentDir: string,
    cwd: string,
    sessionId: string,
  ): Promise<{ file: string; entries: PiEntry[] }> => {
    const realCwd = await realpath(cwd).catch(() => cwd)
    const entries: PiEntry[] = [
      {
        type: 'model_change',
        id: 'm0',
        parentId: null,
        timestamp: '2026-11-20T10:00:00.000Z',
      },
      makeEntry('u1', 'm0', 'user', 'Shared root', '2026-11-20T10:00:01.000Z'),
      makeEntry('a1', 'u1', 'assistant', 'Shared answer', '2026-11-20T10:00:02.000Z'),
      makeEntry('u2a', 'a1', 'user', 'Branch A prompt', '2026-11-20T10:01:00.000Z'),
      makeEntry('a2a', 'u2a', 'assistant', 'Branch A answer', '2026-11-20T10:01:02.000Z'),
      makeEntry('u2b', 'a1', 'user', 'Branch B prompt', '2026-11-20T10:02:00.000Z'),
      makeEntry('a2b', 'u2b', 'assistant', 'Branch B answer', '2026-11-20T10:02:02.000Z'),
    ]
    const file = path.join(
      agentDir,
      'sessions',
      folderName(realCwd),
      `2026-11-20T10-00-00-000Z_${sessionId}.jsonl`,
    )
    await persistFile(file, sessionId, realCwd, entries)
    sessions.set(sessionId, { file, cwd: realCwd, entries, leafId: 'a2b' })
    return { file, entries }
  }

  const spawn = (spawnOptions: HostedSpawnOptions): ChildProcess => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: () => {
        if (child.exitCode === null) {
          child.exitCode = 0
          stdout.end()
          child.emit('exit', 0, null)
        }
        return true
      },
    })

    const args = spawnOptions.args
    const spawnCwd = spawnOptions.cwd ?? ''
    const sessionDir = args[args.indexOf('--session-dir') + 1]!
    const fileIdx = args.indexOf('--session')
    let currentFile = fileIdx >= 0 ? args[fileIdx + 1]! : ''
    let currentId = ''
    // Always initialize each new process's active leaf to the JSONL tail, mirroring real Pi's
    // `SessionManager._buildIndex()` behavior across restarts.
    let procLeafId: string | null = null

    if (currentFile) {
      for (const [id, item] of sessions) {
        if (item.file === currentFile) {
          currentId = id
          procLeafId = item.entries.at(-1)?.id ?? null
          break
        }
      }
    }
    if (!currentId) {
      currentId = `pi-s-${nextSession++}`
      currentFile = path.join(sessionDir, `2026-11-27T00-00-00-000Z_${currentId}.jsonl`)
      sessions.set(currentId, { file: currentFile, cwd: spawnCwd, entries: [], leafId: null })
      procLeafId = null
    }

    const send = (msg: unknown) => void stdout.write(`${JSON.stringify(msg)}\n`)
    const model = { provider: 'example', id: 'small-model', name: 'Small', contextWindow: 128_000 }

    if (options.extensionFallback && spawnOptions.env.KETTU_TREE_NAV === '1') {
      setImmediate(() => {
        send({
          type: 'extension_ui_request',
          id: 'tree-nav-ready',
          method: 'setStatus',
          statusKey: NAVIGATE_READY_STATUS,
          statusText: '1',
        })
      })
    }

    void readJsonLines(stdin, {
      record: (value) => {
        const cmd = value as { id?: string; type: string; [key: string]: unknown }
        const ok = (data?: unknown) =>
          send({
            id: cmd.id,
            type: 'response',
            command: cmd.type,
            success: true,
            ...(data === undefined ? {} : { data }),
          })
        const fail = (error: string) =>
          send({ id: cmd.id, type: 'response', command: cmd.type, success: false, error })
        const cur = sessions.get(currentId)!

        switch (cmd.type) {
          case 'get_state':
            ok({
              model,
              thinkingLevel: 'high',
              isStreaming: heldFinish !== null,
              sessionId: currentId,
              sessionFile: currentFile,
              autoCompactionEnabled: true,
              messageCount: cur.entries.length,
            })
            break
          case 'get_available_models':
            ok({ models: [model] })
            break
          case 'get_available_thinking_levels':
            ok({ levels: ['low', 'high'] })
            break
          case 'get_commands':
            ok({
              commands: options.extensionFallback
                ? [{ name: NAVIGATE_COMMAND, description: 'Internal', source: 'extension' }]
                : [],
            })
            break
          case 'get_session_stats':
            ok({ contextUsage: { tokens: 240, contextWindow: 128_000, percent: 0.2 } })
            break
          case 'get_entries':
            ok({ entries: [...cur.entries], leafId: procLeafId })
            break
          case 'navigate_tree': {
            if (options.extensionFallback) {
              fail('Unknown command: navigate_tree')
              break
            }
            const targetId = String(cmd.targetId ?? '')
            if (!cur.entries.some((entry) => entry.id === targetId)) {
              fail(`Entry ${targetId} not found`)
              break
            }
            procLeafId = targetId
            cur.leafId = targetId
            navigations.push({ sessionId: currentId, targetId, via: 'rpc' })
            ok({ cancelled: false })
            break
          }
          case 'fork': {
            const entryId = String(cmd.entryId)
            const byId = new Map(cur.entries.map((entry) => [entry.id, entry]))
            const target = byId.get(entryId)
            if (!target) {
              fail(`Unknown entry ${entryId}`)
              break
            }
            // Copy root-to-parent path for the target entry, matching real Pi `createBranchedSession`.
            const kept: PiEntry[] = []
            for (let id = target.parentId; id !== null;) {
              const entry = byId.get(id)
              if (!entry) break
              kept.push(entry)
              id = entry.parentId
            }
            kept.reverse()
            const newId = `pi-s-${nextSession++}`
            const newFile = path.join(sessionDir, `2026-11-27T00-00-00-000Z_${newId}.jsonl`)
            sessions.set(newId, {
              file: newFile,
              cwd: spawnCwd,
              entries: kept,
              leafId: kept.at(-1)?.id ?? null,
            })
            forked.push({ from: currentId, entryId, into: newId })
            currentId = newId
            currentFile = newFile
            procLeafId = kept.at(-1)?.id ?? null
            void persistFile(newFile, newId, spawnCwd, kept).then(() =>
              ok({ text: '', cancelled: false }),
            )
            break
          }
          case 'prompt': {
            const text = String(cmd.message ?? '')
            if (options.extensionFallback && text.startsWith(`/${NAVIGATE_COMMAND} `)) {
              const payload = JSON.parse(text.slice(`/${NAVIGATE_COMMAND} `.length)) as {
                reqId: string
                targetId: string
              }
              if (!cur.entries.some((entry) => entry.id === payload.targetId)) {
                send({
                  type: 'extension_ui_request',
                  id: `nav-${payload.reqId}`,
                  method: 'setStatus',
                  statusKey: NAVIGATE_STATUS,
                  statusText: JSON.stringify({
                    reqId: payload.reqId,
                    ok: false,
                    error: `Entry ${payload.targetId} not found`,
                  }),
                })
                ok({ disposition: 'handled' })
                break
              }
              procLeafId = payload.targetId
              cur.leafId = payload.targetId
              navigations.push({
                sessionId: currentId,
                targetId: payload.targetId,
                via: 'extension',
              })
              send({
                type: 'extension_ui_request',
                id: `nav-${payload.reqId}`,
                method: 'setStatus',
                statusKey: NAVIGATE_STATUS,
                statusText: JSON.stringify({
                  reqId: payload.reqId,
                  ok: true,
                  cancelled: false,
                }),
              })
              ok({ disposition: 'handled' })
              break
            }

            const ts = nextTs++
            const userEntry: PiEntry = {
              type: 'message',
              id: `u${nextEntry++}`,
              parentId: procLeafId,
              timestamp: new Date(ts).toISOString(),
              message: { role: 'user', content: [{ type: 'text', text }], timestamp: ts },
            }
            const replyTs = nextTs++
            const replyEntry: PiEntry = {
              type: 'message',
              id: `a${nextEntry++}`,
              parentId: userEntry.id,
              timestamp: new Date(replyTs).toISOString(),
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: `echo:${text.split('\n').at(-1)}` }],
                timestamp: replyTs,
                stopReason: 'stop',
              },
            }
            const emitRun = () => {
              cur.entries.push(userEntry, replyEntry)
              procLeafId = replyEntry.id
              cur.leafId = replyEntry.id
              void persistFile(currentFile, currentId, spawnCwd, cur.entries).then(() => {
                send({ type: 'message_start', message: userEntry.message })
                send({ type: 'message_end', message: userEntry.message })
                send({ type: 'message_start', message: replyEntry.message })
                send({ type: 'message_end', message: replyEntry.message })
                send({ type: 'agent_settled', aborted: false })
              })
            }

            ok({ disposition: 'started' })
            send({ type: 'agent_start' })
            if (options.holdTurns) {
              heldFinish = () => {
                heldFinish = null
                emitRun()
              }
              notifyTurnStarted?.()
            } else {
              emitRun()
            }
            break
          }
          default:
            ok()
        }
      },
      garbage: () => {},
    }).then(() => child.kill())
    spawnOptions.signal?.addEventListener('abort', () => child.kill())
    return child as unknown as ChildProcess
  }

  const driver: HostedDriver = {
    kind: 'hosted',
    connect: (context) =>
      new PiConnection({
        ...context,
        env: { ...context.env, PI_CODING_AGENT_DIR: options.piAgentDir },
        cliVersion: '1.5.2',
        spawn,
      }),
  }

  return {
    driver,
    sessions,
    navigations,
    forked,
    seedBranchedSession,
    waitTurnStarted: () => turnStartedPromise,
    finishHeldTurn: () => {
      const finish = heldFinish
      turnStartedPromise = new Promise<void>((resolve) => {
        notifyTurnStarted = resolve
      })
      finish?.()
    },
  }
}

const entryOf = (window: TestPort, sessionId: string, prompt: string) => {
  const entry = window
    .entries(sessionId)
    .find(
      (item): item is Extract<ThreadEntry, { kind: 'user' }> =>
        item.kind === 'user' && item.content[0]?.type === 'text' && item.content[0].text === prompt,
    )
  if (!entry) throw new Error(`Missing user entry ${prompt}`)
  return entry
}

it('browses and switches native Pi branches, broadcasts history to all windows, persists across reopen, and appends next prompts to the active leaf', async () => {
  const userDataPath = await tempFolder('kettu-pi-branches-host-')
  const projectDir = await tempFolder('kettu-pi-branches-proj-')
  const piAgentDir = await tempFolder('kettu-pi-agent-dir-')
  dirs.push(userDataPath, projectDir, piAgentDir)

  const pi = scriptedTreePi({ piAgentDir, extensionFallback: true })
  const startHost = () =>
    startTestHost({
      userDataPath,
      projectDir,
      fakeAs: ['pi'],
      protocols: { pi: 'pi-rpc' },
      programVersions: { pi: '1.5.2' },
      drivers: { 'pi-rpc': pi.driver },
      sessionTimings: { checkpointMs: 10 },
    })

  const host = await startHost()
  hosts.push(host)
  await pi.seedBranchedSession(piAgentDir, host.project, 'pi-imported-1')

  const win1 = host.connect()
  const win2 = host.connect()

  // Import the multi-branch Pi session from disk.
  const imported = await win1.request('sessions.import', {
    agentId: 'pi',
    projectPath: host.project,
    acpSessionId: 'pi-imported-1',
  })
  const id = imported.id

  // Even before opening, `sessions.branches` reads the full tree straight from the Pi JSONL file.
  const beforeOpen = await win1.request('sessions.branches', { sessionId: id })
  expect(beforeOpen.activeLeafId).toBe('a2b')
  expect(beforeOpen.branchCount).toBe(2)
  expect(beforeOpen.hasBranches).toBe(true)
  expect(beforeOpen.nodes.map((node) => node.id)).toEqual(['a1', 'a2a', 'a2b'])

  // Open on both windows: initial thread shows Branch B (the JSONL tail).
  await win1.open(id)
  await win2.open(id)
  await win1.untilStatus(id, 'ready')
  await win1.until(() => userTexts(win1.entries(id)).includes('Branch B prompt'))
  expect(userTexts(win1.entries(id))).toEqual(['Shared root', 'Branch B prompt'])
  expect(agentTexts(win1.entries(id))).toEqual(['Shared answer', 'Branch B answer'])

  // Switch to Branch A via Pi's native tree navigation (extension command fallback).
  const switched = await win1.request('sessions.switchBranch', { sessionId: id, branchId: 'a2a' })
  expect(switched.activeLeafId).toBe('a2a')
  expect(switched.nodes.find((node) => node.id === 'a2a')?.isCurrent).toBe(true)
  expect(pi.navigations).toEqual([
    { sessionId: 'pi-imported-1', targetId: 'a2a', via: 'extension' },
  ])

  // Both connected windows immediately show Branch A's history.
  await win1.until(() => userTexts(win1.entries(id)).includes('Branch A prompt'))
  await win2.until(() => userTexts(win2.entries(id)).includes('Branch A prompt'))
  expect(userTexts(win1.entries(id))).toEqual(['Shared root', 'Branch A prompt'])
  expect(agentTexts(win1.entries(id))).toEqual(['Shared answer', 'Branch A answer'])
  expect(userTexts(win2.entries(id))).toEqual(['Shared root', 'Branch A prompt'])

  // Restart the host without sending a prompt: reopening must stay on Branch A, not revert to 'a2b'.
  await host.stop()
  hosts.splice(0)

  const restarted = await startHost()
  hosts.push(restarted)
  const reopened = restarted.connect()

  // Closed read still reports Branch A as active.
  const afterRestartClosed = await reopened.request('sessions.branches', { sessionId: id })
  expect(afterRestartClosed.activeLeafId).toBe('a2a')

  await reopened.open(id)
  await reopened.until(() => userTexts(reopened.entries(id)).includes('Branch A prompt'))
  expect(userTexts(reopened.entries(id))).toEqual(['Shared root', 'Branch A prompt'])

  // Sending the next prompt appends directly onto Branch A's leaf (`parentId === 'a2a'`) inside the same Pi session!
  await reopened.request('sessions.queue', {
    sessionId: id,
    content: [{ type: 'text', text: 'Continue on A' }],
  })
  await reopened.until(
    () =>
      userTexts(reopened.entries(id)).includes('Continue on A') &&
      reopened.summary(id)?.status === 'ready',
  )
  const nativeEntries = pi.sessions.get('pi-imported-1')!.entries
  const appendedUser = nativeEntries.find(
    (entry) =>
      entry.message?.role === 'user' &&
      JSON.stringify(entry.message.content).includes('Continue on A'),
  )
  expect(appendedUser?.parentId).toBe('a2a')
  expect(reopened.thread(id).session.acpSessionId).toBe('pi-imported-1')

  // Switching back to Branch B and using #2698 Edit from here rewinds cleanly on Branch B!
  await reopened.request('sessions.switchBranch', { sessionId: id, branchId: 'a2b' })
  await reopened.until(() => userTexts(reopened.entries(id)).includes('Branch B prompt'))
  const branchBPrompt = entryOf(reopened, id, 'Branch B prompt')
  expect(branchBPrompt.agentRef).toBe('u2b')
  await reopened.request('sessions.rewind', {
    sessionId: id,
    entryId: branchBPrompt.id,
    draft: [],
  })
  await reopened.request('sessions.queue', {
    sessionId: id,
    content: [{ type: 'text', text: 'Branch B edited' }],
  })
  await reopened.until(
    () =>
      userTexts(reopened.entries(id)).includes('Branch B edited') &&
      reopened.summary(id)?.status === 'ready',
  )
  expect(pi.forked).toHaveLength(1)
  expect(pi.forked[0]).toMatchObject({ from: 'pi-imported-1', entryId: 'u2b' })
  expect(userTexts(reopened.entries(id))).toEqual(['Shared root', 'Branch B edited'])
})

it('blocks branch switching while a turn is running and rejects non-branching agents', async () => {
  const piAgentDir = await tempFolder('kettu-pi-agent-running-')
  dirs.push(piAgentDir)

  const pi = scriptedTreePi({ piAgentDir, holdTurns: true })
  const host = await startTestHost({
    fakeAs: ['pi', 'claude-code'],
    protocols: { pi: 'pi-rpc' },
    programVersions: { pi: '1.5.2' },
    drivers: { 'pi-rpc': pi.driver },
    sessionTimings: { checkpointMs: 10 },
  })
  hosts.push(host)
  await pi.seedBranchedSession(piAgentDir, host.project, 'pi-busy-1')

  const window = host.connect()
  const imported = await window.request('sessions.import', {
    agentId: 'pi',
    projectPath: host.project,
    acpSessionId: 'pi-busy-1',
  })
  await window.open(imported.id)
  await window.untilStatus(imported.id, 'ready')

  // Start a turn and leave it running.
  await window.request('sessions.queue', {
    sessionId: imported.id,
    content: [{ type: 'text', text: 'Long running turn' }],
  })
  await window.untilStatus(imported.id, 'running')
  await pi.waitTurnStarted()

  // Switching branches while running must fail with `busy` without modifying native state.
  await expect(
    window.request('sessions.switchBranch', { sessionId: imported.id, branchId: 'a2a' }),
  ).rejects.toMatchObject({ code: 'busy' })
  expect(pi.navigations).toEqual([])

  // Once the turn finishes, switching succeeds normally.
  pi.finishHeldTurn()
  await window.untilStatus(imported.id, 'ready')
  const switched = await window.request('sessions.switchBranch', {
    sessionId: imported.id,
    branchId: 'a2a',
  })
  expect(switched.activeLeafId).toBe('a2a')
  expect(pi.navigations).toEqual([{ sessionId: 'pi-busy-1', targetId: 'a2a', via: 'rpc' }])

  // A harness that does not declare `capabilities.branches` is cleanly rejected.
  const other = await window.request('sessions.create', {
    agentId: 'claude-code',
    projectPath: host.project,
  })
  await expect(window.request('sessions.branches', { sessionId: other.id })).rejects.toMatchObject({
    code: 'restricted',
  })
  await expect(
    window.request('sessions.switchBranch', { sessionId: other.id, branchId: 'any' }),
  ).rejects.toMatchObject({ code: 'restricted' })
})
