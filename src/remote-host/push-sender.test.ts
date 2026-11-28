import { describe, expect, it, vi } from 'vitest'
import * as requestLog from '@shared/log/requests'
import { currentPrimitives } from '@shared/remote/primitives'
import {
  DEFAULT_CHOICES,
  LIVE_ACTIVITY_V2,
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
import { PushSender } from './push-sender'

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
    unregistered: () => {},
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
  return { sender, key, hostId, device, requests, logs, finished }
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

  it('封装运行中实时活动并在关闭详情时自动脱敏', async () => {
    const startToken = 'b2'.repeat(32)
    const t = await setup([200], {
      target: {
        apns: { token: DEVICE_TOKEN, environment: 'sandbox' },
        activity: { start: startToken, version: LIVE_ACTIVITY_V2 },
      },
    })
    t.sender.send({
      deviceId: 'phone',
      subject: 'activity',
      type: 'activity',
      action: 'start',
      count: 0,
      sessionId: 's1',
      title: 'Fix the login form',
      payload: {
        kind: 'running',
        sessionId: 's1',
        agentId: 'claude-code',
        title: 'Fix the login form',
        turnStartedAt: 1_762_560_000_000,
        project: 'Kettu',
        plan: { done: 2, total: 5, current: 'Run tests', lastCompleted: 'Refactor layout' },
      },
    })
    await t.finished
    const content = await opened(t, t.requests[0]!.body)
    expect(content).toMatchObject({
      kind: 'running',
      sessionId: 's1',
      agentId: 'claude-code',
      title: 'Fix the login form',
      project: 'Kettu',
      plan: { done: 2, total: 5, current: 'Run tests', lastCompleted: 'Refactor layout' },
    })

    const tPrivate = await setup([200], {
      target: {
        apns: { token: DEVICE_TOKEN, environment: 'sandbox' },
        activity: { start: startToken, version: LIVE_ACTIVITY_V2 },
      },
      choices: { ...DEFAULT_CHOICES, details: false },
    })
    tPrivate.sender.send({
      deviceId: 'phone',
      subject: 'activity',
      type: 'activity',
      action: 'start',
      count: 0,
      sessionId: 's1',
      title: 'Secret title',
      payload: {
        kind: 'running',
        sessionId: 's1',
        agentId: 'claude-code',
        title: 'Secret title',
        turnStartedAt: 1_762_560_000_000,
        project: 'secret-repo',
        plan: { done: 2, total: 5, current: 'Secret step' },
      },
    })
    await tPrivate.finished
    const hidden = await opened(tPrivate, tPrivate.requests[0]!.body)
    expect(hidden).not.toHaveProperty('title')
    expect(hidden).not.toHaveProperty('project')
    expect(hidden).not.toHaveProperty('plan')
    expect(hidden).toMatchObject({ kind: 'running', sessionId: 's1' })
  })

  it('记录推送从入队到网关接收的总耗时、网关耗时与重试次数', async () => {
    let clock = 5000
    const spy = vi.spyOn(requestLog, 'logDevicePush')
    try {
      const key = await importRelayKey(await newRelaySeed())
      const hostId = await relayHostId(key.publicKey)
      const device = await currentPrimitives().generateKeyPair(false)
      let done: () => void = () => {}
      const finished = new Promise<void>((resolve) => (done = resolve))
      let call = 0
      const sender = new PushSender({
        url: URL,
        key,
        hostId,
        hostName: () => 'Studio',
        token: () => ACCESS_TOKEN,
        device: () => ({
          publicKey: Buffer.from(device.publicKey).toString('base64'),
          push: {
            target: { apns: { token: DEVICE_TOKEN, environment: 'sandbox' } },
            choices: DEFAULT_CHOICES,
          },
        }),
        unregistered: () => {},
        log: () => {},
        now: () => clock,
        retry: { firstMs: 1, maxMs: 5, attempts: 3 },
        fetch: async () => {
          call++
          if (call === 1) {
            clock += 120
            return Response.json({ error: 'apns' }, { status: 502 })
          }
          clock += 85
          done()
          return Response.json({ ok: true }, { status: 200 })
        },
      })
      sender.send(job)
      await finished
      // 等待 attempt 返回后记录完成
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(spy).toHaveBeenCalledWith({
        device: 'phone',
        kind: 'alert',
        ms: 205,
        gatewayMs: 85,
        attempts: 2,
      })
    } finally {
      spy.mockRestore()
    }
  })

  it('封装等待选择态快捷选项并在关闭详情时自动隐藏', async () => {
    const startToken = '33'.repeat(32)
    const quickOptions = {
      target: 'question' as const,
      total: 3,
      questionCount: 1,
      multiSelect: false,
      items: [
        { id: '0', label: '270° 填充弧', style: 'recommended' as const },
        { id: '1', label: '360° 闭环', style: 'normal' as const },
        { id: '2', label: '同心双环', style: 'normal' as const },
      ],
    }
    const t = await setup([200], {
      target: {
        apns: { token: DEVICE_TOKEN, environment: 'sandbox' },
        activity: { start: startToken },
      },
    })
    t.sender.send({
      deviceId: 'phone',
      subject: 'activity',
      type: 'activity',
      action: 'start',
      count: 1,
      sessionId: 's2',
      title: '选择锁屏样式',
      payload: {
        kind: 'waiting',
        count: 1,
        sessionId: 's2',
        title: '选择锁屏样式',
        body: '锁屏圆形额度小组件采用哪套方案？',
        requestId: 'req-q1',
        actionKind: 'question',
        quickOptions,
      },
    })
    await t.finished
    const content = await opened(t, t.requests[0]!.body)
    expect(content).toMatchObject({
      kind: 'waiting',
      count: 1,
      actionKind: 'question',
      requestId: 'req-q1',
      quickOptions,
    })

    const tPrivate = await setup([200], {
      target: {
        apns: { token: DEVICE_TOKEN, environment: 'sandbox' },
        activity: { start: startToken },
      },
      choices: { ...DEFAULT_CHOICES, details: false },
    })
    tPrivate.sender.send({
      deviceId: 'phone',
      subject: 'activity',
      type: 'activity',
      action: 'start',
      count: 1,
      sessionId: 's2',
      title: 'Secret',
      payload: {
        kind: 'waiting',
        count: 1,
        sessionId: 's2',
        title: 'Secret',
        body: 'Secret question',
        requestId: 'req-q1',
        actionKind: 'question',
        quickOptions,
      },
    })
    await tPrivate.finished
    const hidden = await opened(tPrivate, tPrivate.requests[0]!.body)
    expect(hidden).not.toHaveProperty('quickOptions')
    expect(hidden).not.toHaveProperty('actionKind')
  })

  it('透传普通锁屏通知元数据（agentId / changedFiles / quickOptions）并在隐藏详情时安全脱敏', async () => {
    const quickOptions = {
      target: 'question' as const,
      total: 2,
      questionCount: 1,
      multiSelect: false,
      items: [
        { id: '0', label: '仅导出 JSON', style: 'recommended' as const },
        { id: '1', label: 'CSV + JSON', style: 'normal' as const },
      ],
    }
    const t = await setup([200])
    t.sender.send({
      deviceId: 'phone',
      subject: 's-meta',
      type: 'alert',
      title: '导出格式确认',
      body: '需要同时导出 CSV 吗？',
      event: {
        kind: 'permission',
        sessionId: 's-meta',
        agentId: 'codex',
        requestId: 'req-meta',
        actionKind: 'question',
        quickOptions,
      },
    })
    await t.finished
    const shown = await opened(t, t.requests[0]!.body)
    expect(shown).toMatchObject({
      kind: 'permission',
      agentId: 'codex',
      actionKind: 'question',
      quickOptions,
    })

    const tPrivate = await setup([200], { choices: { ...DEFAULT_CHOICES, details: false } })
    tPrivate.sender.send({
      deviceId: 'phone',
      subject: 's-meta',
      type: 'alert',
      title: '机密标题',
      body: '机密正文',
      event: {
        kind: 'turn-ended',
        sessionId: 's-meta',
        agentId: 'claude-code',
        changedFiles: 4,
      },
    })
    await tPrivate.finished
    const redacted = await opened(tPrivate, tPrivate.requests[0]!.body)
    expect(redacted).toMatchObject({ kind: 'turn-ended', sessionId: 's-meta' })
    expect(redacted).not.toHaveProperty('title')
    expect(redacted).not.toHaveProperty('agentId')
    expect(redacted).not.toHaveProperty('changedFiles')
  })

  it('encodes Live Activity end pushes as an empty waiting state and strips stale fields', async () => {
    const updateToken = '44'.repeat(32)
    const t = await setup([200], {
      target: {
        apns: { token: DEVICE_TOKEN, environment: 'sandbox' },
        activity: { update: updateToken },
      },
    })
    t.sender.send({
      deviceId: 'phone',
      subject: 'activity',
      type: 'activity',
      action: 'end',
      count: 3,
      sessionId: 'stale-session',
      title: 'Stale title',
      payload: {
        kind: 'waiting',
        count: 3,
        sessionId: 'stale-session',
        title: 'Stale title',
        body: 'Stale body',
        requestId: 'req-stale',
      },
    })
    await t.finished
    const parsed = parsePushRequest(t.requests[0]!.body)!
    expect(parsed).toMatchObject({
      token: updateToken,
      environment: 'sandbox',
      push: { type: 'liveactivity', event: 'end' },
    })
    const content = await opened(t, t.requests[0]!.body)
    expect(content).toMatchObject({
      v: 1,
      host: t.hostId,
      hostName: 'Studio',
      kind: 'waiting',
      count: 0,
    })
    expect(content).not.toHaveProperty('title')
    expect(content).not.toHaveProperty('body')
    expect(content).not.toHaveProperty('sessionId')
    expect(content).not.toHaveProperty('requestId')
  })

  it('新推送取代正在退避重试中的同键旧推送时，立即中止旧重试并直接发送最新推送', async () => {
    const key = await importRelayKey(await newRelaySeed())
    const hostId = await relayHostId(key.publicKey)
    const device = await currentPrimitives().generateKeyPair(false)
    const sent: string[] = []
    let firstAttemptDone: () => void = () => {}
    const waitedFirst = new Promise<void>((resolve) => (firstAttemptDone = resolve))
    let secondSent: () => void = () => {}
    const finished = new Promise<void>((resolve) => (secondSent = resolve))

    const sender = new PushSender({
      url: URL,
      key,
      hostId,
      hostName: () => 'Studio',
      token: () => ACCESS_TOKEN,
      device: () => ({
        publicKey: Buffer.from(device.publicKey).toString('base64'),
        push: {
          target: {
            apns: { token: DEVICE_TOKEN, environment: 'sandbox' },
            activity: { start: 'b2'.repeat(32), update: 'c3'.repeat(32) },
          },
          choices: DEFAULT_CHOICES,
        },
      }),
      unregistered: () => {},
      log: () => {},
      // 设长退避，验证新推送无需等旧退避超时即可立即中断并发送。
      retry: { firstMs: 30_000, maxMs: 60_000, attempts: 3 },
      fetch: async (_input, init) => {
        const body = init!.body as string
        sent.push(body)
        if (sent.length === 1) {
          firstAttemptDone()
          return Response.json({ error: 'apns' }, { status: 502 })
        }
        secondSent()
        return Response.json({ ok: true }, { status: 200 })
      },
    })

    sender.send({
      deviceId: 'phone',
      subject: 'activity',
      type: 'activity',
      action: 'update',
      count: 1,
      sessionId: 's1',
      title: 'Old waiting',
      payload: { kind: 'waiting', count: 1, sessionId: 's1', title: 'Old waiting' },
    })
    await waitedFirst
    // 稍微让出事件循环，使旧任务进入 30s 退避等待。
    await new Promise((resolve) => setTimeout(resolve, 10))

    sender.send({
      deviceId: 'phone',
      subject: 'activity',
      type: 'activity',
      action: 'end',
      count: 0,
      sessionId: null,
      title: null,
    })
    await finished
    sender.stop()

    expect(sent).toHaveLength(2)
    expect(parsePushRequest(sent[0]!)!.push).toMatchObject({
      type: 'liveactivity',
      event: 'update',
    })
    expect(parsePushRequest(sent[1]!)!.push).toMatchObject({ type: 'liveactivity', event: 'end' })
  })

  it('发送前 shouldSend 返回 false 时放弃重试，且密文 at 保留入队时刻不被重试刷新', async () => {
    let clock = 10_000
    let stillValid = true
    const key = await importRelayKey(await newRelaySeed())
    const hostId = await relayHostId(key.publicKey)
    const device = await currentPrimitives().generateKeyPair(false)
    const bodies: string[] = []
    let firstDone: () => void = () => {}
    const waitedFirst = new Promise<void>((resolve) => (firstDone = resolve))

    const sender = new PushSender({
      url: URL,
      key,
      hostId,
      hostName: () => 'Studio',
      token: () => ACCESS_TOKEN,
      device: () => ({
        publicKey: Buffer.from(device.publicKey).toString('base64'),
        push: {
          target: { apns: { token: DEVICE_TOKEN, environment: 'sandbox' } },
          choices: DEFAULT_CHOICES,
        },
      }),
      unregistered: () => {},
      shouldSend: () => stillValid,
      log: () => {},
      now: () => clock,
      retry: { firstMs: 5, maxMs: 10, attempts: 3 },
      fetch: async (_input, init) => {
        bodies.push(init!.body as string)
        clock += 5000
        stillValid = false
        firstDone()
        return Response.json({ error: 'apns' }, { status: 502 })
      },
    })

    sender.send(job)
    await waitedFirst
    await new Promise((resolve) => setTimeout(resolve, 30))
    sender.stop()

    // 第一次失败后请求已失效，不应发起第二次重试。
    expect(bodies).toHaveLength(1)
    const envelope = decodeSealed(parsePushRequest(bodies[0]!)!.push.sealed)!
    const openedBody = (await openPush(envelope, device))!
    const parsed = JSON.parse(new TextDecoder().decode(openedBody.body)) as PushContent
    expect(parsed.at).toBe(10_000)
  })

  it('drops non-waiting Live Activity pushes for legacy devices and notifies activityStartNotSent', async () => {
    const startToken = 'b2'.repeat(32)
    const key = await importRelayKey(await newRelaySeed())
    const hostId = await relayHostId(key.publicKey)
    const device = await currentPrimitives().generateKeyPair(false)
    const requests: string[] = []
    const notSent: PushJob[] = []
    const sender = new PushSender({
      url: URL,
      key,
      hostId,
      hostName: () => 'Studio',
      token: () => ACCESS_TOKEN,
      device: () => ({
        publicKey: Buffer.from(device.publicKey).toString('base64'),
        push: {
          target: {
            apns: { token: DEVICE_TOKEN, environment: 'sandbox' },
            activity: { start: startToken },
          },
          choices: DEFAULT_CHOICES,
        },
      }),
      unregistered: () => {},
      activityStartNotSent: (dropped) => notSent.push(dropped),
      log: () => {},
      fetch: async (_input, init) => {
        requests.push(init!.body as string)
        return Response.json({ ok: true }, { status: 200 })
      },
    })

    const runningStart: PushJob = {
      deviceId: 'phone',
      subject: 'activity',
      type: 'activity',
      action: 'start',
      count: 0,
      sessionId: 's1',
      title: 'Running task',
      payload: { kind: 'running', sessionId: 's1', title: 'Running task' },
    }
    sender.send(runningStart)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(requests).toEqual([])
    expect(notSent).toEqual([runningStart])
    sender.stop()
  })

  it('does not abort an in-flight Live Activity end when a new start arrives, and delivers end before start', async () => {
    const startToken = 'b2'.repeat(32)
    const oldUpdateToken = 'c3'.repeat(32)
    const key = await importRelayKey(await newRelaySeed())
    const hostId = await relayHostId(key.publicKey)
    const device = await currentPrimitives().generateKeyPair(false)
    const push: DevicePush = {
      target: {
        apns: { token: DEVICE_TOKEN, environment: 'sandbox' },
        activity: { start: startToken, update: oldUpdateToken, version: LIVE_ACTIVITY_V2 },
      },
      choices: DEFAULT_CHOICES,
    }

    const events: { token: string; event: string; aborted: boolean }[] = []
    let releaseEnd: () => void = () => {}
    const endInFlight = new Promise<void>((resolve) => {
      releaseEnd = resolve
    })
    let endStarted: () => void = () => {}
    const waitEndStarted = new Promise<void>((resolve) => {
      endStarted = resolve
    })
    let startCompleted: () => void = () => {}
    const waitStartCompleted = new Promise<void>((resolve) => {
      startCompleted = resolve
    })

    const sender = new PushSender({
      url: URL,
      key,
      hostId,
      hostName: () => 'Studio',
      token: () => ACCESS_TOKEN,
      device: () => ({
        publicKey: Buffer.from(device.publicKey).toString('base64'),
        push,
      }),
      unregistered: () => {},
      log: () => {},
      retry: { firstMs: 5, maxMs: 10, attempts: 3 },
      fetch: async (_input, init) => {
        const parsed = parsePushRequest(init!.body as string)!
        const signal = init!.signal!
        const pushEvent = parsed.push.type === 'liveactivity' ? parsed.push.event : parsed.push.type
        if (pushEvent === 'end') {
          endStarted()
          await endInFlight
          events.push({ token: parsed.token, event: pushEvent, aborted: signal.aborted })
          return Response.json({ ok: true }, { status: 200 })
        }
        events.push({ token: parsed.token, event: pushEvent, aborted: signal.aborted })
        startCompleted()
        return Response.json({ ok: true }, { status: 200 })
      },
    })

    sender.send({
      deviceId: 'phone',
      subject: 'activity',
      type: 'activity',
      action: 'end',
      count: 0,
      sessionId: null,
      title: null,
    })
    await waitEndStarted

    // Simulate dropActivityToken clearing update while `end` is still in flight, then a new `start`.
    push.target = {
      apns: { token: DEVICE_TOKEN, environment: 'sandbox' },
      activity: { start: startToken, version: LIVE_ACTIVITY_V2 },
    }
    sender.send({
      deviceId: 'phone',
      subject: 'activity',
      type: 'activity',
      action: 'start',
      count: 1,
      sessionId: 's2',
      title: 'New request',
      payload: { kind: 'waiting', count: 1, sessionId: 's2', title: 'New request' },
    })

    // Give the event loop a tick to verify `start` stays queued behind the in-flight `end`.
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(events).toEqual([])

    releaseEnd()
    await waitStartCompleted
    sender.stop()

    expect(events).toEqual([
      { token: oldUpdateToken, event: 'end', aborted: false },
      { token: startToken, event: 'start', aborted: false },
    ])
  })

  it('keeps in-flight end alive when cancel("activity") drops a queued start and reports activityStartNotSent', async () => {
    const startToken = 'b2'.repeat(32)
    const oldUpdateToken = 'c3'.repeat(32)
    const key = await importRelayKey(await newRelaySeed())
    const hostId = await relayHostId(key.publicKey)
    const device = await currentPrimitives().generateKeyPair(false)
    const delivered: string[] = []
    const notSent: PushJob[] = []
    let releaseEnd: () => void = () => {}
    const endGate = new Promise<void>((resolve) => {
      releaseEnd = resolve
    })
    let endStarted: () => void = () => {}
    const waitEndStarted = new Promise<void>((resolve) => {
      endStarted = resolve
    })
    let endDone: () => void = () => {}
    const waitEndDone = new Promise<void>((resolve) => {
      endDone = resolve
    })

    const sender = new PushSender({
      url: URL,
      key,
      hostId,
      hostName: () => 'Studio',
      token: () => ACCESS_TOKEN,
      device: () => ({
        publicKey: Buffer.from(device.publicKey).toString('base64'),
        push: {
          target: {
            apns: { token: DEVICE_TOKEN, environment: 'sandbox' },
            activity: { start: startToken, update: oldUpdateToken, version: LIVE_ACTIVITY_V2 },
          },
          choices: DEFAULT_CHOICES,
        },
      }),
      unregistered: () => {},
      activityStartNotSent: (dropped) => notSent.push(dropped),
      log: () => {},
      fetch: async (_input, init) => {
        const parsed = parsePushRequest(init!.body as string)!
        const event = parsed.push.type === 'liveactivity' ? parsed.push.event : parsed.push.type
        if (event === 'end') {
          endStarted()
          await endGate
          expect(init!.signal!.aborted).toBe(false)
          delivered.push(`${event}:${parsed.token}`)
          endDone()
          return Response.json({ ok: true }, { status: 200 })
        }
        delivered.push(`${event}:${parsed.token}`)
        return Response.json({ ok: true }, { status: 200 })
      },
    })

    sender.send({
      deviceId: 'phone',
      subject: 'activity',
      type: 'activity',
      action: 'end',
      count: 0,
      sessionId: null,
      title: null,
    })
    await waitEndStarted

    const queuedStart: PushJob = {
      deviceId: 'phone',
      subject: 'activity',
      type: 'activity',
      action: 'start',
      count: 1,
      sessionId: 's-cancel',
      title: 'Brief wait',
      payload: { kind: 'waiting', count: 1, sessionId: 's-cancel', title: 'Brief wait' },
    }
    sender.send(queuedStart)
    sender.cancel('phone', 'activity')
    expect(notSent).toEqual([queuedStart])

    releaseEnd()
    await waitEndDone
    await new Promise((resolve) => setTimeout(resolve, 15))
    sender.stop()

    expect(delivered).toEqual([`end:${oldUpdateToken}`])
  })

  it('coalesces a newer update over an in-flight update while preserving distinct end tokens', async () => {
    const startToken = 'b2'.repeat(32)
    const tokenA = 'c3'.repeat(32)
    const tokenB = 'd4'.repeat(32)
    const key = await importRelayKey(await newRelaySeed())
    const hostId = await relayHostId(key.publicKey)
    const device = await currentPrimitives().generateKeyPair(false)
    let currentUpdateToken = tokenA
    const delivered: { event: string; token: string; count?: number }[] = []
    let releaseFirst: () => void = () => {}
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstStarted: () => void = () => {}
    const waitFirstStarted = new Promise<void>((resolve) => {
      firstStarted = resolve
    })
    let allDone: () => void = () => {}
    const waitAllDone = new Promise<void>((resolve) => {
      allDone = resolve
    })

    const sender = new PushSender({
      url: URL,
      key,
      hostId,
      hostName: () => 'Studio',
      token: () => ACCESS_TOKEN,
      device: () => ({
        publicKey: Buffer.from(device.publicKey).toString('base64'),
        push: {
          target: {
            apns: { token: DEVICE_TOKEN, environment: 'sandbox' },
            activity: { start: startToken, update: currentUpdateToken, version: LIVE_ACTIVITY_V2 },
          },
          choices: DEFAULT_CHOICES,
        },
      }),
      unregistered: () => {},
      log: () => {},
      retry: { firstMs: 5, maxMs: 10, attempts: 2 },
      fetch: async (_input, init) => {
        const parsed = parsePushRequest(init!.body as string)!
        const event = parsed.push.type === 'liveactivity' ? parsed.push.event : parsed.push.type
        if (delivered.length === 0 && event === 'update') {
          firstStarted()
          await firstGate
          if (init!.signal!.aborted) throw new DOMException('Aborted', 'AbortError')
        }
        const envelope = decodeSealed(parsed.push.sealed)!
        const openedBody = (await openPush(envelope, device))!
        const content = JSON.parse(new TextDecoder().decode(openedBody.body)) as PushContent
        delivered.push({
          event,
          token: parsed.token,
          ...(content.kind === 'waiting' ? { count: content.count } : {}),
        })
        if (delivered.length === 3) allDone()
        return Response.json({ ok: true }, { status: 200 })
      },
    })

    // First update gets superseded by a newer update before it completes.
    sender.send({
      deviceId: 'phone',
      subject: 'activity',
      type: 'activity',
      action: 'update',
      count: 1,
      sessionId: 's1',
      title: 'One',
      payload: { kind: 'waiting', count: 1, sessionId: 's1', title: 'One' },
    })
    await waitFirstStarted
    sender.send({
      deviceId: 'phone',
      subject: 'activity',
      type: 'activity',
      action: 'update',
      count: 2,
      sessionId: 's1',
      title: 'Two',
      payload: { kind: 'waiting', count: 2, sessionId: 's1', title: 'Two' },
    })
    releaseFirst()

    // Wait for update(count: 2) to finish, then queue two distinct `end` tokens back-to-back.
    await expect.poll(() => delivered.length).toBe(1)
    expect(delivered[0]).toEqual({ event: 'update', token: tokenA, count: 2 })

    sender.send({
      deviceId: 'phone',
      subject: 'activity',
      type: 'activity',
      action: 'end',
      count: 0,
      sessionId: null,
      title: null,
    })
    // Duplicate end for tokenA is deduplicated without aborting.
    sender.send({
      deviceId: 'phone',
      subject: 'activity',
      type: 'activity',
      action: 'end',
      count: 0,
      sessionId: null,
      title: null,
    })
    // A second end for tokenB is preserved alongside tokenA's end.
    currentUpdateToken = tokenB
    sender.send({
      deviceId: 'phone',
      subject: 'activity',
      type: 'activity',
      action: 'end',
      count: 0,
      sessionId: null,
      title: null,
    })

    await waitAllDone
    sender.stop()
    expect(delivered).toEqual([
      { event: 'update', token: tokenA, count: 2 },
      { event: 'end', token: tokenA, count: 0 },
      { event: 'end', token: tokenB, count: 0 },
    ])
  })
})
