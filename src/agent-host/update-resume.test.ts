import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type HostSettings } from '@shared/settings'
import type { ThreadEntry } from '@shared/thread'
import { UPDATE_RESUME_FILE, UPDATE_RESUME_MAX_AGE_MS } from '@shared/update-resume'
import { saveUpdateResume } from '../main/update-resume'
import { consumeUpdateResume } from './update-resume'
import { startTestHost, type TestHost } from './testing/harness'
import { tempFolder } from './testing/temp'

vi.setConfig({ testTimeout: 60_000 })

const hosts: TestHost[] = []
const tempDirs: string[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await tempFolder(prefix)
  tempDirs.push(dir)
  return dir
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

function makeHostSettings(overrides: Partial<HostSettings> = {}): HostSettings {
  return {
    locale: 'en',
    agents: { 'fake-agent': { enabled: true } },
    addedAgents: DEFAULT_SETTINGS.addedAgents,
    disabledAgents: DEFAULT_SETTINGS.disabledAgents,
    proxy: DEFAULT_SETTINGS.proxy,
    git: DEFAULT_SETTINGS.git,
    mcp: DEFAULT_SETTINGS.mcp,
    marketplace: DEFAULT_SETTINGS.marketplace,
    startModes: DEFAULT_SETTINGS.startModes,
    idleSessions: DEFAULT_SETTINGS.idleSessions,
    workflow: DEFAULT_SETTINGS.workflow,
    startedSessions: DEFAULT_SETTINGS.startedSessions,
    usage: { fromComputer: false },
    sessionTitles: true,
    promptSuggestions: true,
    continueAfterLimit: true,
    agentPasswords: false,
    lightModel: { mode: 'small' },
    initialSetupDone: true,
    defaultAgent: null,
    computerUse: DEFAULT_SETTINGS.computerUse,
    downloadService: false,
    ...overrides,
  }
}

function noticesOf(
  entries: readonly ThreadEntry[],
  cause: 'update_resumed' | 'update_resume_blocked',
): Extract<ThreadEntry, { kind: 'notice' }>[] {
  return entries.filter(
    (entry): entry is Extract<ThreadEntry, { kind: 'notice' }> =>
      entry.kind === 'notice' && entry.cause === cause,
  )
}

function kettuMessagesOf(
  entries: readonly ThreadEntry[],
): Extract<ThreadEntry, { kind: 'user' }>[] {
  return entries.filter(
    (entry): entry is Extract<ThreadEntry, { kind: 'user' }> =>
      entry.kind === 'user' && entry.kettu === true,
  )
}

describe('consumeUpdateResume one-shot semantics', () => {
  it('atomically consumes a valid file once and deletes it before returning', async () => {
    const dir = await makeTempDir('kettu-consume-')
    const now = Date.UTC(2026, 10, 27, 15, 0, 0)
    await saveUpdateResume(dir, {
      fromVersion: '0.1.28',
      now,
      sessions: [
        { sessionId: 's1', waitingForUser: false },
        { sessionId: 's2', waitingForUser: true },
      ],
    })

    const first = await consumeUpdateResume(dir, { now: now + 5_000 })
    expect(first).toEqual({
      version: 1,
      createdAt: now,
      fromVersion: '0.1.28',
      sessions: [
        { sessionId: 's1', waitingForUser: false },
        { sessionId: 's2', waitingForUser: true },
      ],
    })
    expect(await fileExists(path.join(dir, UPDATE_RESUME_FILE))).toBe(false)

    // Second launch sees nothing and never triggers again.
    const second = await consumeUpdateResume(dir, { now: now + 6_000 })
    expect(second).toBeNull()
  })

  it('drops stale, far-future, or malformed records and removes the file', async () => {
    const dir = await makeTempDir('kettu-stale-')
    const now = Date.UTC(2026, 10, 27, 15, 0, 0)

    await saveUpdateResume(dir, {
      fromVersion: '0.1.28',
      now: now - UPDATE_RESUME_MAX_AGE_MS - 1_000,
      sessions: [{ sessionId: 's-stale', waitingForUser: false }],
    })
    expect(await consumeUpdateResume(dir, { now })).toBeNull()
    expect(await fileExists(path.join(dir, UPDATE_RESUME_FILE))).toBe(false)

    await writeFile(path.join(dir, UPDATE_RESUME_FILE), '{not-valid-json', 'utf8')
    expect(await consumeUpdateResume(dir, { now })).toBeNull()
    expect(await fileExists(path.join(dir, UPDATE_RESUME_FILE))).toBe(false)

    await writeFile(
      path.join(dir, UPDATE_RESUME_FILE),
      JSON.stringify({ version: 2, createdAt: now, fromVersion: '0.1.28', sessions: [] }),
      'utf8',
    )
    expect(await consumeUpdateResume(dir, { now })).toBeNull()
    expect(await fileExists(path.join(dir, UPDATE_RESUME_FILE))).toBe(false)
  })
})

describe('AgentHost post-update session recovery', () => {
  it('captures only actively running and approval-waiting user sessions, resumes running ones in parallel, marks waiting ones manual, and never repeats on next launch', async () => {
    const dir = await makeTempDir('kettu-resume-e2e-')
    const project = path.join(dir, 'project')
    await mkdir(project, { recursive: true })

    const host1 = await startTestHost({ userDataPath: dir, projectDir: project })
    hosts.push(host1)
    const win1 = host1.connect()

    const createReady = async () => {
      const { id } = await win1.request('sessions.create', {
        agentId: 'fake-agent',
        projectPath: host1.project,
      })
      await win1.open(id)
      await win1.untilStatus(id, 'ready')
      return id
    }

    const runningA = await createReady()
    const runningB = await createReady()
    const idleDone = await createReady()
    const backgroundIdle = await createReady()
    const waitingApproval = await createReady()

    // idleDone finishes normally before the update restart.
    await win1.request('sessions.prompt', {
      sessionId: idleDone,
      content: [{ type: 'text', text: 'Quick hello' }],
    })
    await win1.untilEntry(idleDone, (entry) => entry.kind === 'turn_end')
    await win1.untilStatus(idleDone, 'ready')

    // backgroundIdle starts a background command and returns to idle ready state.
    await win1.request('sessions.prompt', {
      sessionId: backgroundIdle,
      content: [{ type: 'text', text: '/background' }],
    })
    await win1.untilEntry(backgroundIdle, (entry) => entry.kind === 'turn_end')
    await win1.untilStatus(backgroundIdle, 'ready')

    // runningA and runningB stay actively running (/cancel holds until cancelled or shutdown).
    await win1.request('sessions.prompt', {
      sessionId: runningA,
      content: [{ type: 'text', text: '/cancel' }],
    })
    await win1.request('sessions.prompt', {
      sessionId: runningB,
      content: [{ type: 'text', text: '/cancel' }],
    })
    await win1.untilStatus(runningA, 'running')
    await win1.untilStatus(runningB, 'running')

    // waitingApproval blocks waiting on user permission.
    await win1.request('sessions.prompt', {
      sessionId: waitingApproval,
      content: [{ type: 'text', text: '/permission' }],
    })
    await win1.untilStatus(waitingApproval, 'awaiting_permission')

    // Verify exact pre-update capture snapshot.
    const captured = host1.host.sessions.interruptedByUpdate()
    expect(captured).toHaveLength(3)
    expect(captured).toEqual(
      expect.arrayContaining([
        { sessionId: runningA, waitingForUser: false },
        { sessionId: runningB, waitingForUser: false },
        { sessionId: waitingApproval, waitingForUser: true },
      ]),
    )
    expect(captured.some((item) => item.sessionId === idleDone)).toBe(false)
    expect(captured.some((item) => item.sessionId === backgroundIdle)).toBe(false)

    // Persist manifest as main does right before shutting down for an immediate update.
    await saveUpdateResume(dir, { fromVersion: '0.1.28', sessions: captured })
    await host1.stop()

    // Launch 2: after update restart.
    const host2 = await startTestHost({ userDataPath: dir, projectDir: project })
    hosts.push(host2)
    expect(await fileExists(path.join(dir, UPDATE_RESUME_FILE))).toBe(false)
    await host2.host.updateResumeReady()

    const win2 = host2.connect()
    await win2.open(runningA)
    await win2.open(runningB)
    await win2.open(idleDone)
    await win2.open(waitingApproval)

    // Both running sessions received an info notice and auto-continued with a Kettu prompt.
    for (const id of [runningA, runningB]) {
      await win2.untilEntry(id, (entry) => entry.kind === 'turn_end')
      await win2.untilStatus(id, 'ready')
      const entries = win2.entries(id)
      expect(noticesOf(entries, 'update_resumed')).toHaveLength(1)
      expect(noticesOf(entries, 'update_resume_blocked')).toHaveLength(0)
      expect(kettuMessagesOf(entries)).toHaveLength(1)
    }

    // Idle session was untouched.
    expect(noticesOf(win2.entries(idleDone), 'update_resumed')).toHaveLength(0)
    expect(noticesOf(win2.entries(idleDone), 'update_resume_blocked')).toHaveLength(0)
    expect(kettuMessagesOf(win2.entries(idleDone))).toHaveLength(0)

    // Waiting-on-user session was NOT auto-sent; instead it got a warning notice explaining why.
    const waitingEntries = win2.entries(waitingApproval)
    expect(noticesOf(waitingEntries, 'update_resumed')).toHaveLength(0)
    const blockedNotices = noticesOf(waitingEntries, 'update_resume_blocked')
    expect(blockedNotices).toHaveLength(1)
    expect(blockedNotices[0]!.description).toContain('waiting for your approval or input')
    expect(kettuMessagesOf(waitingEntries)).toHaveLength(0)

    await host2.stop()

    // Launch 3: ordinary restart must never trigger recovery a second time.
    const host3 = await startTestHost({ userDataPath: dir, projectDir: project })
    hosts.push(host3)
    await host3.host.updateResumeReady()
    const win3 = host3.connect()
    await win3.open(runningA)
    await win3.open(waitingApproval)
    expect(noticesOf(win3.entries(runningA), 'update_resumed')).toHaveLength(1)
    expect(kettuMessagesOf(win3.entries(runningA))).toHaveLength(1)
    expect(noticesOf(win3.entries(waitingApproval), 'update_resume_blocked')).toHaveLength(1)
  })

  it('writes a blocked notice with reason when session is archived, project folder is missing, worktree is missing, agent is disabled, or resume fails', async () => {
    const dir = await makeTempDir('kettu-resume-blocked-')
    const projectOk = path.join(dir, 'project-ok')
    const projectVanish = path.join(dir, 'project-vanish')
    await mkdir(projectOk, { recursive: true })
    await mkdir(projectVanish, { recursive: true })

    // Prepare sessions on Host 1.
    const host1 = await startTestHost({ userDataPath: dir, projectDir: projectOk })
    hosts.push(host1)
    const win1 = host1.connect()

    const makeFinishedSession = async (projectPath: string) => {
      const { id } = await win1.request('sessions.create', {
        agentId: 'fake-agent',
        projectPath,
      })
      await win1.open(id)
      await win1.untilStatus(id, 'ready')
      await win1.request('sessions.prompt', {
        sessionId: id,
        content: [{ type: 'text', text: 'Initial message' }],
      })
      await win1.untilEntry(id, (entry) => entry.kind === 'turn_end')
      await win1.untilStatus(id, 'ready')
      return id
    }

    const archivedId = await makeFinishedSession(host1.project)
    const missingDirId = await makeFinishedSession(projectVanish)
    const missingWorktreeId = await makeFinishedSession(host1.project)
    const attachFailId = await makeFinishedSession(host1.project)

    // Archive one session before stopping.
    await win1.request('sessions.archive', { sessionId: archivedId })

    // Simulate a missing worktree on missingWorktreeId by attaching a non-existent worktree record.
    const wtPath = path.join(dir, 'gone-worktree')
    const missingWtRecord = (
      host1.host.sessions as unknown as {
        records: Map<
          string,
          { worktree?: { path: string; branch: string; base: string; baseOid: string } }
        >
        saveIndex(): void
      }
    ).records.get(missingWorktreeId)
    expect(missingWtRecord).toBeDefined()
    missingWtRecord!.worktree = {
      path: wtPath,
      branch: 'feat/gone',
      base: 'main',
      baseOid: '0000000',
    }
    ;(host1.host.sessions as unknown as { saveIndex(): void }).saveIndex()

    await host1.stop()

    // Delete the second project's directory before relaunch.
    await rm(projectVanish, { recursive: true, force: true })

    // Stage manifest for all four sessions and force fake-agent resumeSession to fail for attachFailId.
    await saveUpdateResume(dir, {
      fromVersion: '0.1.28',
      sessions: [
        { sessionId: archivedId, waitingForUser: false },
        { sessionId: missingDirId, waitingForUser: false },
        { sessionId: missingWorktreeId, waitingForUser: false },
        { sessionId: attachFailId, waitingForUser: false },
      ],
    })

    const host2 = await startTestHost({
      userDataPath: dir,
      projectDir: projectOk,
      agentEnv: { FAKE_AGENT_RESUME_UNKNOWN: 'fail' },
    })
    hosts.push(host2)
    await host2.host.updateResumeReady()

    const win2 = host2.connect()
    for (const id of [archivedId, missingDirId, missingWorktreeId, attachFailId]) {
      await win2.open(id)
    }

    const archivedBlocked = noticesOf(win2.entries(archivedId), 'update_resume_blocked')
    expect(archivedBlocked).toHaveLength(1)
    expect(archivedBlocked[0]!.description).toContain('archived')
    expect(kettuMessagesOf(win2.entries(archivedId))).toHaveLength(0)

    const missingDirBlocked = noticesOf(win2.entries(missingDirId), 'update_resume_blocked')
    expect(missingDirBlocked).toHaveLength(1)
    expect(missingDirBlocked[0]!.description).toContain('project folder')
    expect(kettuMessagesOf(win2.entries(missingDirId))).toHaveLength(0)

    const missingWtBlocked = noticesOf(win2.entries(missingWorktreeId), 'update_resume_blocked')
    expect(missingWtBlocked).toHaveLength(1)
    expect(missingWtBlocked[0]!.description).toContain('worktree')
    expect(kettuMessagesOf(win2.entries(missingWorktreeId))).toHaveLength(0)

    const attachFailBlocked = noticesOf(win2.entries(attachFailId), 'update_resume_blocked')
    expect(attachFailBlocked).toHaveLength(1)
    expect(attachFailBlocked[0]!.description).toContain('Automatic resume failed')
    expect(noticesOf(win2.entries(attachFailId), 'update_resumed')).toHaveLength(0)
    expect(kettuMessagesOf(win2.entries(attachFailId))).toHaveLength(0)

    await host2.stop()

    // Now test disabled agent on a fresh restart with another staged manifest.
    await saveUpdateResume(dir, {
      fromVersion: '0.1.28',
      sessions: [{ sessionId: attachFailId, waitingForUser: false }],
    })
    const host3 = await startTestHost({
      userDataPath: dir,
      projectDir: projectOk,
      settings: makeHostSettings({ disabledAgents: ['fake-agent'] }),
    })
    hosts.push(host3)
    await host3.host.updateResumeReady()

    const win3 = host3.connect()
    await win3.open(attachFailId)
    const disabledBlocked = noticesOf(win3.entries(attachFailId), 'update_resume_blocked')
    expect(disabledBlocked.some((n) => n.description?.includes('currently disabled'))).toBe(true)
    expect(kettuMessagesOf(win3.entries(attachFailId))).toHaveLength(0)

    await host3.stop()

    // Also test an agent that is no longer installed on relaunch.
    const dirUninstalled = await makeTempDir('kettu-resume-uninstalled-')
    const projectUninstalled = path.join(dirUninstalled, 'project')
    await mkdir(projectUninstalled, { recursive: true })
    const hostA = await startTestHost({
      userDataPath: dirUninstalled,
      projectDir: projectUninstalled,
      fakeAs: ['claude-code'],
    })
    hosts.push(hostA)
    const winA = hostA.connect()
    const { id: claudeSessionId } = await winA.request('sessions.create', {
      agentId: 'claude-code',
      projectPath: hostA.project,
    })
    await winA.open(claudeSessionId)
    await winA.untilStatus(claudeSessionId, 'ready')
    await winA.request('sessions.prompt', {
      sessionId: claudeSessionId,
      content: [{ type: 'text', text: '/cancel' }],
    })
    await winA.untilStatus(claudeSessionId, 'running')
    await saveUpdateResume(dirUninstalled, {
      fromVersion: '0.1.28',
      sessions: hostA.host.sessions.interruptedByUpdate(),
    })
    await hostA.stop()

    // Relaunch without claude-code installed.
    const hostB = await startTestHost({
      userDataPath: dirUninstalled,
      projectDir: projectUninstalled,
    })
    hosts.push(hostB)
    await hostB.host.updateResumeReady()
    const winB = hostB.connect()
    await winB.open(claudeSessionId)
    const unavailableBlocked = noticesOf(winB.entries(claudeSessionId), 'update_resume_blocked')
    expect(unavailableBlocked).toHaveLength(1)
    expect(unavailableBlocked[0]!.description).toContain('not installed or unavailable')
    expect(kettuMessagesOf(winB.entries(claudeSessionId))).toHaveLength(0)
  })
})
