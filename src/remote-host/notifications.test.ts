import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HostActivitySnapshot } from '@shared/host-control'
import { currentPrimitives } from '@shared/remote/primitives'
import {
  LIVE_ACTIVITY_V2,
  decodeSealed,
  openPush,
  parsePushRequest,
  type PushContent,
} from '@shared/remote/push'
import { importRelayKey, newRelaySeed, relayHostId } from '@shared/remote/relay'
import { DeviceStore } from './devices'
import { DeviceNotifications } from './notifications'

const APNS_TOKEN = 'a1'.repeat(32)
const START_TOKEN = 'b2'.repeat(32)
const OLD_UPDATE_TOKEN = 'c3'.repeat(32)
const NEW_UPDATE_TOKEN = 'd4'.repeat(32)

const EMPTY_ACTIVITY: HostActivitySnapshot = {
  running: [],
  error: [],
  ended: [],
  limit: null,
  waitingMeta: {},
}

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function setup(fetchImpl: typeof fetch) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kettu-notif-'))
  dirs.push(dir)
  const devices = await DeviceStore.load(dir, () => {})
  const hostKey = await importRelayKey(await newRelaySeed())
  const hostId = await relayHostId(hostKey.publicKey)
  const deviceKey = await currentPrimitives().generateKeyPair(false)
  const paired = (await devices.add({
    publicKey: Buffer.from(deviceKey.publicKey).toString('base64'),
    name: 'iPhone',
    kind: 'ios',
    platform: 'ios',
    model: 'iPhone 17 Pro',
  }))!
  const notifications = new DeviceNotifications({
    devices,
    key: hostKey,
    hostId,
    url: 'https://push.example.test',
    hostName: () => 'Studio',
    token: () => 'access-token',
    showing: () => false,
    foreground: () => false,
    tell: () => {},
    storeKey: crypto.randomBytes(32),
    log: () => {},
    fetch: fetchImpl,
    mergeMs: 5,
    retry: { firstMs: 5, maxMs: 10, attempts: 2 },
  })
  return { dir, devices, paired, deviceKey, notifications }
}

async function decodeActivity(
  body: string,
  deviceKey: Awaited<ReturnType<ReturnType<typeof currentPrimitives>['generateKeyPair']>>,
) {
  const parsed = parsePushRequest(body)!
  const envelope = decodeSealed(parsed.push.sealed)!
  const opened = (await openPush(envelope, deviceKey))!
  const content = JSON.parse(new TextDecoder().decode(opened.body)) as PushContent
  return { parsed, content }
}

describe('DeviceNotifications Live Activity compatibility and lifecycle races', () => {
  it('preserves activity.version across end cleanup and delivers end before subsequent start without aborting', async () => {
    const delivered: { token: string; event: string; kind: string; aborted: boolean }[] = []
    let releaseEnd: () => void = () => {}
    const endGate = new Promise<void>((resolve) => {
      releaseEnd = resolve
    })
    let endStarted: () => void = () => {}
    const waitEndStarted = new Promise<void>((resolve) => {
      endStarted = resolve
    })
    let startSent: () => void = () => {}
    const waitStartSent = new Promise<void>((resolve) => {
      startSent = resolve
    })

    let env: Awaited<ReturnType<typeof setup>> | null = null
    env = await setup(async (_input, init) => {
      const { parsed, content } = await decodeActivity(init!.body as string, env!.deviceKey)
      const event = parsed.push.type === 'liveactivity' ? parsed.push.event : parsed.push.type
      if (event === 'end') {
        endStarted()
        await endGate
        delivered.push({
          token: parsed.token,
          event,
          kind: content.kind,
          aborted: init!.signal!.aborted,
        })
        return Response.json({ ok: true }, { status: 200 })
      }
      delivered.push({
        token: parsed.token,
        event,
        kind: content.kind,
        aborted: init!.signal!.aborted,
      })
      startSent()
      return Response.json({ ok: true }, { status: 200 })
    })

    const state = await env.notifications.update(env.paired.id, {
      target: {
        apns: { token: APNS_TOKEN, environment: 'production' },
        activity: { start: START_TOKEN, update: OLD_UPDATE_TOKEN, version: LIVE_ACTIVITY_V2 },
      },
      choices: { onlyAway: false },
    })
    expect(state).toMatchObject({
      target: {
        apns: true,
        activityStart: true,
        activityUpdate: true,
        activityVersion: LIVE_ACTIVITY_V2,
      },
    })

    // Empty activity ends the existing Live Activity and clears only the spent update token.
    env.notifications.setActivity(EMPTY_ACTIVITY)
    await waitEndStarted

    // While `end` is still in flight to the gateway, `version` must remain intact.
    expect(env.devices.push(env.paired.id)?.target?.activity).toEqual({
      start: START_TOKEN,
      version: LIVE_ACTIVITY_V2,
    })

    // A new running session starts while `end` is still in flight.
    env.notifications.setActivity({
      ...EMPTY_ACTIVITY,
      running: [
        {
          sessionId: 's-next',
          agentId: 'claude-code',
          title: 'Next task',
          turnStartedAt: Date.now(),
          parentId: null,
        },
      ],
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(delivered).toEqual([])

    releaseEnd()
    await waitStartSent
    env.notifications.stop()

    expect(delivered).toEqual([
      { token: OLD_UPDATE_TOKEN, event: 'end', kind: 'waiting', aborted: false },
      { token: START_TOKEN, event: 'start', kind: 'running', aborted: false },
    ])
  })

  it('never sends running push-to-start to legacy iOS devices and still sends waiting and end', async () => {
    const delivered: { token: string; event: string; content: PushContent }[] = []
    let env: Awaited<ReturnType<typeof setup>> | null = null
    env = await setup(async (_input, init) => {
      const { parsed, content } = await decodeActivity(init!.body as string, env!.deviceKey)
      const event = parsed.push.type === 'liveactivity' ? parsed.push.event : parsed.push.type
      delivered.push({ token: parsed.token, event, content })
      return Response.json({ ok: true }, { status: 200 })
    })

    const state = await env.notifications.update(env.paired.id, {
      target: {
        apns: { token: APNS_TOKEN, environment: 'production' },
        activity: { start: START_TOKEN },
      },
      choices: { onlyAway: false },
    })
    expect(state).toMatchObject({
      target: { apns: true, activityStart: true, activityUpdate: false },
    })
    expect((state as { target: Record<string, unknown> }).target).not.toHaveProperty(
      'activityVersion',
    )

    // Running session sends zero activity pushes to a legacy device.
    env.notifications.setActivity({
      ...EMPTY_ACTIVITY,
      running: [
        {
          sessionId: 's-run',
          agentId: 'codex',
          title: 'Background build',
          turnStartedAt: Date.now(),
          parentId: null,
        },
      ],
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(delivered).toEqual([])

    // Waiting permission request sends a legacy-compatible waiting start with count.
    env.notifications.setWaiting({ 's-run': ['req-1'] })
    await expect.poll(() => delivered.length).toBe(1)
    expect(delivered[0]).toMatchObject({
      token: START_TOKEN,
      event: 'start',
      content: { kind: 'waiting', count: 1, sessionId: 's-run' },
    })

    // Device reports its update token; clearing waiting ends the activity even while still running.
    await env.notifications.update(env.paired.id, {
      target: {
        apns: { token: APNS_TOKEN, environment: 'production' },
        activity: { start: START_TOKEN, update: OLD_UPDATE_TOKEN },
      },
    })
    env.notifications.setWaiting({})
    await expect.poll(() => delivered.length).toBe(2)
    expect(delivered[1]).toMatchObject({
      token: OLD_UPDATE_TOKEN,
      event: 'end',
      content: { kind: 'waiting', count: 0 },
    })
    env.notifications.stop()
  })

  it('ignores a stale 410 unregistered response for an older activity update token', async () => {
    let releaseEnd: () => void = () => {}
    const endGate = new Promise<void>((resolve) => {
      releaseEnd = resolve
    })
    let endStarted: () => void = () => {}
    const waitEndStarted = new Promise<void>((resolve) => {
      endStarted = resolve
    })

    const seenTokens: string[] = []
    const env = await setup(async (_input, init) => {
      const parsed = parsePushRequest(init!.body as string)!
      seenTokens.push(parsed.token)
      if (parsed.token === OLD_UPDATE_TOKEN) {
        endStarted()
        await endGate
        return Response.json({ error: 'unregistered' }, { status: 410 })
      }
      return Response.json({ ok: true }, { status: 200 })
    })

    await env.notifications.update(env.paired.id, {
      target: {
        apns: { token: APNS_TOKEN, environment: 'production' },
        activity: { start: START_TOKEN, update: OLD_UPDATE_TOKEN, version: LIVE_ACTIVITY_V2 },
      },
      choices: { onlyAway: false },
    })

    // Trigger `end` for OLD_UPDATE_TOKEN.
    env.notifications.setActivity(EMPTY_ACTIVITY)
    await waitEndStarted

    // While the old `end` is still in flight, a new session starts and the device reports a new update token.
    env.notifications.setActivity({
      ...EMPTY_ACTIVITY,
      running: [
        {
          sessionId: 's-new',
          agentId: 'claude-code',
          title: 'Active session',
          turnStartedAt: Date.now(),
          parentId: null,
        },
      ],
    })
    await env.notifications.update(env.paired.id, {
      target: {
        apns: { token: APNS_TOKEN, environment: 'production' },
        activity: { start: START_TOKEN, update: NEW_UPDATE_TOKEN, version: LIVE_ACTIVITY_V2 },
      },
    })

    releaseEnd()
    await expect.poll(() => seenTokens).toContain(NEW_UPDATE_TOKEN)
    await new Promise((resolve) => setTimeout(resolve, 25))

    // The stale 410 for OLD_UPDATE_TOKEN must not wipe NEW_UPDATE_TOKEN.
    expect(env.devices.push(env.paired.id)?.target?.activity).toEqual({
      start: START_TOKEN,
      update: NEW_UPDATE_TOKEN,
      version: LIVE_ACTIVITY_V2,
    })
    env.notifications.stop()
  })
})
