import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentId, PatchBatch, ThreadEntry } from '@shared/thread'
import type { ExitInfo } from './agent-process'
import type { AgentManager, AgentSessionHooks } from './agents'
import { AgentTrees } from './agent-trees'
import { AgentRequestError, type AgentConnection } from './connection'
import { Diagnostics } from './diagnostics'
import { isDiskFullError } from './disk-full'
import { setLocale } from './i18n'
import type { Projects } from './projects'
import type { ScratchFolders } from './scratch'
import {
  SessionManager,
  type SessionEvents,
  type SessionManagerDeps,
  type SessionTimings,
} from './sessions'
import {
  JsonFile,
  observeStorageWrites,
  parseAgentProcessesFile,
  parseSessionsFile,
  returnedFile,
  writeFileAtomic,
  type AgentProcessesFile,
  type SessionsFile,
} from './storage'
import type { ProcessControl } from './process-tree'

const ENOSPC = (): NodeJS.ErrnoException =>
  Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })

let dir: string
let managers: SessionManager[] = []
let unsubscribes: (() => void)[] = []

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kettu-exit-enospc-'))
  managers = []
  unsubscribes = []
  setLocale('en')
})

afterEach(async () => {
  for (const unsub of unsubscribes.splice(0)) unsub()
  for (const sessions of managers.splice(0)) {
    sessions.shutdown()
    await sessions.flush()
  }
  setLocale('en')
  await rm(dir, { recursive: true, force: true })
})

interface HarnessOptions {
  sessionsWrite?: (file: string, contents: string) => Promise<void>
  agentName?: string
  now?: () => number
  timings?: Partial<SessionTimings>
}

function createHarness(options: HarnessOptions = {}) {
  let exitInfo: ExitInfo | null = null
  let runStderr = ''
  let rejectPrompt: ((error: unknown) => void) | null = null
  let hooks: AgentSessionHooks | null = null
  const patches: PatchBatch[] = []
  const attentions: { sessionId: string; kind: string; title: string; body: string }[] = []

  const connection: Partial<AgentConnection> = {
    isClosed: false,
    closed: new Promise<void>(() => {}),
    rootOf: (id: string) => id,
    register: () => {},
    unregister: () => {},
    newSession: async () => ({ sessionId: 'acp-1', config: [] }),
    prompt: () =>
      new Promise((_, reject) => {
        rejectPrompt = reject
      }),
    cancel: async () => {},
    closeSession: async () => {},
    close: () => {},
  }

  const agents = {
    get hooks() {
      return hooks!
    },
    set hooks(next: AgentSessionHooks) {
      hooks = next
    },
    has: () => true,
    name: () => options.agentName ?? 'Google Antigravity',
    assertEnabled: () => {},
    runningConfig: () => null,
    sessionsChanged: () => {},
    restoreConfig: (_agentId: AgentId, config: unknown[]) => config,
    status: () => ({
      capabilities: { prompt: { image: false, audio: false, embeddedContext: false } },
      limits: [],
    }),
    whileOpening: (_agentId: AgentId, start: Promise<unknown>) => start,
    runtime: () => null,
    ensureReady: async () => ({
      agentId: 'antigravity' as AgentId,
      connection: connection as AgentConnection,
      init: {
        capabilities: {
          prompt: { image: false, audio: false, embeddedContext: false },
        },
      },
      kettu: false,
    }),
    exitContext: () => ({ info: exitInfo, stderr: runStderr }),
    signedIn: () => {},
    authRequired: () => {},
    context: () => false,
    contextEstimates: () => false,
    usesRouter: () => false,
  } as unknown as AgentManager

  const sessionsJson = new JsonFile<SessionsFile>({
    file: path.join(dir, 'state', 'sessions.json'),
    version: 1,
    migrations: {},
    parse: parseSessionsFile,
    empty: () => ({ version: 1, sessions: [] }),
    log: () => {},
    debounceMs: 0,
    retryMs: 60_000,
    ...(options.sessionsWrite ? { writeFile: options.sessionsWrite } : {}),
  })

  const diagnostics = new Diagnostics()
  const events = new Proxy(
    {
      patches: (batch: PatchBatch) => patches.push(batch),
      attention: (sessionId: string, kind: string, title: string, body: string) =>
        attentions.push({ sessionId, kind, title, body }),
    },
    {
      get: (target, prop) => (prop in target ? target[prop as keyof typeof target] : () => {}),
    },
  ) as unknown as SessionEvents

  const deps = {
    platform: 'darwin',
    agents,
    projects: {
      list: () => [],
      resolveDirectory: async (folder: string) => folder,
      add: async () => {},
    } as unknown as Projects,
    scratch: { contains: () => false } as unknown as ScratchFolders,
    file: sessionsJson,
    returned: returnedFile(dir, () => {}),
    portOpen: () => true,
    threads: null,
    reportsDir: path.join(dir, 'reports'),
    diagnostics,
    git: () => null,
    events,
    settings: () => ({ startModes: {} }) as never,
    ...(options.now ? { now: options.now } : {}),
    timings: { flushMs: 0, ...options.timings },
  } satisfies SessionManagerDeps

  const sessions = new SessionManager(deps)
  managers.push(sessions)

  async function startRunningTurn(): Promise<string> {
    await sessions.load()
    const created = await sessions.create(
      { agentId: 'antigravity', projectPath: '/repo' },
      'port-1',
    )
    sessions.watch(created.id, 'port-1')
    sessions.show([created.id], 'port-1')
    await sessions.open(created.id)
    await sessions.prompt(created.id, [{ type: 'text', text: 'hello' }], 'port-1')
    // Wait until connection.prompt has been invoked so the turn is actively running.
    await vi.waitFor(() => expect(rejectPrompt).not.toBeNull())
    return created.id
  }

  function noticesInPatches(sessionId: string): Extract<ThreadEntry, { kind: 'notice' }>[] {
    const byId = new Map<string, Extract<ThreadEntry, { kind: 'notice' }>>()
    for (const batch of patches) {
      if (batch.sessionId !== sessionId) continue
      for (const patch of batch.patches) {
        if (patch.op === 'entry.add' && patch.entry.kind === 'notice') {
          byId.set(patch.entry.id, patch.entry)
        } else if (patch.op === 'entry.update') {
          const existing = byId.get(patch.id)
          if (existing) byId.set(patch.id, { ...existing, ...patch.changes } as typeof existing)
        }
      }
    }
    return [...byId.values()]
  }

  return {
    sessions,
    sessionsJson,
    diagnostics,
    attentions,
    startRunningTurn,
    noticesInPatches,
    setStderr: (text: string) => {
      runStderr = text
      diagnostics.stderr('antigravity', text)
    },
    triggerExit: (info: ExitInfo) => {
      exitInfo = info
      hooks?.agentExited('antigravity', info)
    },
    rejectTurnClosed: (message = 'The agent connection closed') => {
      rejectPrompt?.(new AgentRequestError('closed', message))
    },
  }
}

describe('stoppedNotice exit diagnostics', () => {
  it('includes non-zero exit code and filtered stderr summary on mid-turn crash', async () => {
    const h = createHarness()
    const sessionId = await h.startRunningTurn()
    h.setStderr(
      [
        '(node:42) ExperimentalWarning: noisy warning',
        'Error: upstream auth failed for token=secret_token_value_12345',
        '    at Client.run (/app/run.js:12:3)',
        'Node.js v22.12.0',
      ].join('\n'),
    )
    h.triggerExit({ code: 1, signal: null })

    const stopped = h.noticesInPatches(sessionId).find((n) => n.cause === 'agent_stopped')
    expect(stopped).toBeDefined()
    expect(stopped?.title).toBe('Google Antigravity exited before finishing this turn')
    expect(stopped?.description).toBe(
      'Exited with code 1: Error: upstream auth failed for token=<redacted>',
    )
    expect(stopped?.description).not.toContain('secret_token_value_12345')
    expect(stopped?.description).not.toContain('at Client.run')
  })

  it('includes signal name when agent is terminated by a signal', async () => {
    const h = createHarness()
    const sessionId = await h.startRunningTurn()
    h.triggerExit({ code: null, signal: 'SIGKILL' })

    const stopped = h.noticesInPatches(sessionId).find((n) => n.cause === 'agent_stopped')
    expect(stopped?.title).toBe('Google Antigravity exited before finishing this turn')
    expect(stopped?.description).toBe('Stopped by signal SIGKILL.')
  })

  it('gives targeted disk-full guidance when stderr contains no space left on device (en & zh-CN)', async () => {
    const h = createHarness()
    const sessionId = await h.startRunningTurn()
    h.setStderr('Fatal: ENOSPC: no space left on device, write\n')
    h.triggerExit({ code: 1, signal: null })

    const stopped = h.noticesInPatches(sessionId).find((n) => n.cause === 'agent_stopped')
    expect(stopped?.description).toContain('The disk is full.')
    expect(stopped?.description).toContain('Exited with code 1')
    expect(stopped?.description).toContain('no space left on device')

    setLocale('zh-CN')
    const hZh = createHarness()
    const sessionIdZh = await hZh.startRunningTurn()
    hZh.setStderr('Error: no space left on device\n')
    hZh.triggerExit({ code: 1, signal: null })

    const stoppedZh = hZh.noticesInPatches(sessionIdZh).find((n) => n.cause === 'agent_stopped')
    expect(stoppedZh?.title).toBe('Google Antigravity 在本轮对话完成前退出了')
    expect(stoppedZh?.description).toContain('磁盘空间不足')
    expect(stoppedZh?.description).toContain('退出码 1')
  })

  it('enriches the stopped notice if failTurn wins the race against agentExited', async () => {
    const h = createHarness()
    const sessionId = await h.startRunningTurn()
    // Prompt rejects with closed before the OS exit event arrives.
    h.rejectTurnClosed()
    await vi.waitFor(() =>
      expect(h.noticesInPatches(sessionId).some((n) => n.cause === 'agent_stopped')).toBe(true),
    )

    // Exit event arrives shortly after with the exit code and stderr.
    h.setStderr('Error: ENOSPC: no space left on device, write\n')
    h.triggerExit({ code: 1, signal: null })

    const stopped = h.noticesInPatches(sessionId).find((n) => n.cause === 'agent_stopped')
    expect(stopped?.description).toContain('The disk is full.')
    expect(stopped?.description).toContain('Exited with code 1')
  })
})

describe('state-file ENOSPC disk-full notices and deduplication', () => {
  it('surfaces notice.diskFull once when sessions.json hits ENOSPC repeatedly, then resets after recovery', async () => {
    let fail = false
    let clock = 1_000
    const h = createHarness({
      now: () => clock,
      timings: { diskFullCooldownMs: 60_000 },
      sessionsWrite: async (file, contents) => {
        if (fail) throw ENOSPC()
        await writeFileAtomic(file, contents)
      },
    })
    const sessionId = await h.startRunningTurn()

    fail = true
    h.sessions.rename(sessionId, 'Title 1')
    await h.sessionsJson.flushWritten()
    h.sessions.rename(sessionId, 'Title 2')
    await h.sessionsJson.flushWritten()
    h.sessions.rename(sessionId, 'Title 3')
    await h.sessionsJson.flushWritten()

    const diskFullNotices = () =>
      h.noticesInPatches(sessionId).filter((n) => n.title.includes('the disk is full'))
    expect(diskFullNotices()).toHaveLength(1)
    expect(h.attentions.filter((a) => a.body.includes('the disk is full'))).toHaveLength(1)

    // Recovery resets the gate so a future ENOSPC surfaces again.
    fail = false
    await h.sessionsJson.flushWritten()
    clock += 120_000

    fail = true
    h.sessions.rename(sessionId, 'Title 4')
    await h.sessionsJson.flushWritten()
    await vi.waitFor(() => expect(diskFullNotices()).toHaveLength(2))
    expect(h.attentions.filter((a) => a.body.includes('the disk is full'))).toHaveLength(2)
  })

  it('surfaces notice.diskFull when agent-processes.json hits ENOSPC and deduplicates across sources', async () => {
    let sessionsFail = false
    let processesFail = true
    const h = createHarness({
      sessionsWrite: async (file, contents) => {
        if (sessionsFail) throw ENOSPC()
        await writeFileAtomic(file, contents)
      },
    })
    // Wire the same root observer AgentHost installs for userDataPath.
    unsubscribes.push(
      observeStorageWrites(dir, (outcome) => {
        if (outcome.ok) h.sessions.noteDiskWriteSucceeded(outcome.file)
        else if (isDiskFullError(outcome.error)) h.sessions.reportDiskFull(outcome.file)
      }),
    )

    const sessionId = await h.startRunningTurn()

    const processesJson = new JsonFile<AgentProcessesFile>({
      file: path.join(dir, 'state', 'agent-processes.json'),
      version: 1,
      migrations: {},
      parse: parseAgentProcessesFile,
      empty: () => ({ version: 1, processes: [] }),
      log: () => {},
      debounceMs: 0,
      retryMs: 60_000,
      writeFile: async (file, contents) => {
        if (processesFail) throw ENOSPC()
        await writeFileAtomic(file, contents)
      },
    })
    const control: ProcessControl = {
      platform: 'darwin',
      list: async () => [],
      kill: () => {},
      taskkill: async () => {},
      delay: async () => {},
    }
    const trees = new AgentTrees({
      file: processesJson,
      control,
      graceMs: 100,
      log: () => {},
    })

    // Writing agent-processes.json fails with ENOSPC while threads.db is not even involved.
    trees.launched({ pid: 99999, startedAt: Date.now() })
    await processesJson.flushWritten()

    // Simultaneous ENOSPC on sessions.json must not emit a duplicate notice or duplicate attention.
    sessionsFail = true
    h.sessions.rename(sessionId, 'Renamed under pressure')
    await h.sessionsJson.flushWritten()

    const diskFullNotices = () =>
      h.noticesInPatches(sessionId).filter((n) => n.title.includes('the disk is full'))
    expect(diskFullNotices()).toHaveLength(1)
    expect(h.attentions.filter((a) => a.body.includes('the disk is full'))).toHaveLength(1)

    // Partial recovery (agent-processes.json succeeds while sessions.json still fails) must not spam.
    processesFail = false
    await processesJson.flushWritten()
    h.sessions.rename(sessionId, 'Still full')
    await h.sessionsJson.flushWritten()
    expect(diskFullNotices()).toHaveLength(1)
  })

  it('still raises a throttled attention alert when ENOSPC occurs after all sessions closed', async () => {
    let fail = false
    const clock = 5_000
    const h = createHarness({
      now: () => clock,
      timings: { diskFullCooldownMs: 60_000 },
      sessionsWrite: async (file, contents) => {
        if (fail) throw ENOSPC()
        await writeFileAtomic(file, contents)
      },
    })
    const sessionId = await h.startRunningTurn()
    // Agent crashes and closes the session (drops it from live).
    h.triggerExit({ code: 1, signal: null })
    await vi.waitFor(() => expect(h.sessions.summary(sessionId).status).toBe('closed'))

    // Subsequent state-file ENOSPC (e.g. debounced sessions.json write) still alerts once.
    fail = true
    h.sessions.rename(sessionId, 'After close 1')
    await h.sessionsJson.flushWritten()
    h.sessions.rename(sessionId, 'After close 2')
    await h.sessionsJson.flushWritten()

    expect(h.attentions.filter((a) => a.body.includes('the disk is full'))).toHaveLength(1)
  })
})
