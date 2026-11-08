import { describe, expect, it } from 'vitest'
import { currentPrimitives } from '@shared/remote/primitives'
import {
  DEFAULT_CHOICES,
  decodeSealed,
  openPush,
  parsePushRequest,
  pushRequestText,
  pushTag,
  type DevicePush,
  type PushContent,
} from '@shared/remote/push'
import {
  importRelayKey,
  newRelaySeed,
  relayHostId,
  verifyRelaySignature,
} from '@shared/remote/relay'
import type { PushJob } from './notifier'
import { PushSender, type PushTokenKind } from './push-sender'

const URL = 'https://push.example.test'
const DEVICE_TOKEN = 'a1'.repeat(32)
const ACCESS_TOKEN = 'secret-access-token'

async function setup(answers: (number | Error)[], push: Partial<DevicePush> = {}) {
  const key = await importRelayKey(await newRelaySeed())
  const hostId = await relayHostId(key.publicKey)
  const device = await currentPrimitives().generateKeyPair(false)
  const devicePush: DevicePush = {
    target: { apns: { token: DEVICE_TOKEN, environment: 'sandbox' } },
    choices: DEFAULT_CHOICES,
    ...push,
  }
  const requests: { url: string; headers: Record<string, string>; body: string }[] = []
  const logs: string[] = []
  const gone: [string, PushTokenKind][] = []
  let done: () => void = () => {}
  const finished = new Promise<void>((resolve) => (done = resolve))
  const sender = new PushSender({
    url: URL,
    key,
    hostId,
    hostName: () => 'Studio',
    token: () => ACCESS_TOKEN,
    device: (id) =>
      id === 'phone'
        ? { publicKey: Buffer.from(device.publicKey).toString('base64'), push: devicePush }
        : null,
    unregistered: (id, token) => gone.push([id, token]),
    log: (level, message) => logs.push(`${level}: ${message}`),
    retry: { firstMs: 1, maxMs: 5, attempts: 3 },
    fetch: async (input, init) => {
      requests.push({
        url: String(input),
        headers: init!.headers as Record<string, string>,
        body: init!.body as string,
      })
      const answer = answers.shift() ?? 200
      if (answers.length === 0) done()
      if (answer instanceof Error) throw answer
      const error = answer === 410 ? 'unregistered' : answer === 502 ? 'apns' : 'malformed'
      return Response.json(answer === 200 ? { ok: true } : { error }, { status: answer })
    },
  })
  return { sender, key, hostId, device, requests, logs, gone, finished }
}

const job: PushJob = {
  deviceId: 'phone',
  subject: 's1',
  type: 'alert',
  event: {
    kind: 'permission',
    sessionId: 's1',
    requestId: 'r1',
    actions: { allow: { optionId: 'allow', label: 'Allow' } },
  },
  title: 'Fix the login form',
  body: 'Wants to run pnpm test',
}

async function opened(t: Awaited<ReturnType<typeof setup>>, body: string): Promise<PushContent> {
  const request = parsePushRequest(body)!
  const envelope = decodeSealed(request.push.sealed)!
  const content = (await openPush(envelope, t.device))!
  expect(await verifyRelaySignature(t.key.publicKey, content.signature, content.signed)).toBe(true)
  return JSON.parse(new TextDecoder().decode(content.body)) as PushContent
}

describe('sending a push', () => {
  it('posts the content sealed to the device, the request signed with the host key', async () => {
    const t = await setup([200])
    t.sender.send(job)
    await t.finished
    const [request] = t.requests
    expect(request!.url).toBe(`${URL}/v1/push`)
    expect(request!.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`)
    const signature = Buffer.from(request!.headers['Kettu-Signature']!, 'base64url')
    const signed = pushRequestText(URL, t.hostId, request!.body)
    expect(await verifyRelaySignature(t.key.publicKey, signature, signed)).toBe(true)
    const parsed = parsePushRequest(request!.body)!
    const tag = await pushTag(t.device.publicKey, t.hostId, 's1')
    expect(parsed).toMatchObject({
      token: DEVICE_TOKEN,
      environment: 'sandbox',
      push: { type: 'alert', collapse: tag },
    })
    expect(await opened(t, request!.body)).toMatchObject({
      v: 1,
      host: t.hostId,
      hostName: 'Studio',
      tag,
      title: 'Fix the login form',
      body: 'Wants to run pnpm test',
      kind: 'permission',
      sessionId: 's1',
      requestId: 'r1',
      actions: { allow: { optionId: 'allow', label: 'Allow' } },
    })
  })

  it('leaves out the title, the text and the answers for a device without details', async () => {
    const t = await setup([200], { choices: { ...DEFAULT_CHOICES, details: false } })
    t.sender.send(job)
    await t.finished
    const content = await opened(t, t.requests[0]!.body)
    expect(content).not.toHaveProperty('title')
    expect(content).not.toHaveProperty('body')
    expect(content).not.toHaveProperty('actions')
    expect(content).toMatchObject({ kind: 'permission', sessionId: 's1', requestId: 'r1' })
  })

  it('tries again after the gateway or the network fails, and logs nothing of the push', async () => {
    const t = await setup([502, new TypeError('fetch failed'), 200])
    t.sender.send(job)
    await t.finished
    await expect.poll(() => t.requests.length).toBe(3)
    expect(t.logs).toEqual([])
    const t2 = await setup([502, 502, 502])
    t2.sender.send(job)
    await expect.poll(() => t2.logs.length).toBe(1)
    expect(t2.logs).toEqual(['warn: Gave up a notification for device phone after 3 tries: apns'])
  })

  it('forgets a token Apple no longer takes, and gives up what the gateway refuses', async () => {
    const t = await setup([410])
    t.sender.send(job)
    await expect.poll(() => t.gone).toEqual([['phone', 'device']])
    const t2 = await setup([400])
    t2.sender.send(job)
    await expect.poll(() => t2.logs.length).toBe(1)
    expect(t2.requests).toHaveLength(1)
    for (const line of [...t.logs, ...t2.logs]) {
      expect(line).not.toContain(DEVICE_TOKEN)
      expect(line).not.toContain(ACCESS_TOKEN)
      expect(line).not.toContain('pnpm test')
    }
  })

  it('sends a Live Activity start to its own token, with sealed attributes', async () => {
    const start = 'c3'.repeat(80)
    const t = await setup([200], {
      target: { apns: { token: DEVICE_TOKEN, environment: 'production' }, activity: { start } },
    })
    t.sender.send({
      deviceId: 'phone',
      subject: 'activity',
      type: 'activity',
      action: 'start',
      count: 2,
      sessionId: 's1',
      title: 'Fix the login form',
    })
    await t.finished
    const request = parsePushRequest(t.requests[0]!.body)!
    expect(request).toMatchObject({
      token: start,
      environment: 'production',
      push: { type: 'liveactivity', event: 'start' },
    })
    expect(await opened(t, t.requests[0]!.body)).toMatchObject({
      kind: 'waiting',
      count: 2,
      sessionId: 's1',
      title: 'Fix the login form',
    })
    // Without the activity's own token, an update has nowhere to go.
    t.sender.send({
      deviceId: 'phone',
      subject: 'activity',
      type: 'activity',
      action: 'update',
      count: 1,
      sessionId: 's1',
      title: null,
    })
    expect(t.requests).toHaveLength(1)
  })
})
