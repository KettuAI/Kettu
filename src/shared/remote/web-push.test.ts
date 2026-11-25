import { describe, expect, it } from 'vitest'
import type { PushContent } from './push'
import { encodeRelayBytes, importRelayKey, newRelaySeed, relayHostId } from './relay'
import {
  isPushEndpoint,
  MAX_WEB_PUSH_PAYLOAD,
  openWebPush,
  parseStoredWebPush,
  parseWebPushSubscription,
  parseWithdrawn,
  signWebPush,
} from './web-push'

const p256 = (fill: number): string => {
  const key = new Uint8Array(65).fill(fill)
  key[0] = 4
  return encodeRelayBytes(key)
}

const subscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc:def',
  p256dh: p256(1),
  auth: encodeRelayBytes(new Uint8Array(16).fill(2)),
  vapid: { publicKey: p256(3), privateKey: encodeRelayBytes(new Uint8Array(32).fill(4)) },
}

describe('a Web Push subscription', () => {
  it("is taken only for the browsers' push services over https", () => {
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/x',
      'https://updates.push.services.mozilla.com/wpush/v2/x',
      'https://web.push.apple.com/QGuQ',
      'https://wns2-par02p.notify.windows.com/w/?token=x',
    ]) {
      expect(isPushEndpoint(endpoint)).toBe(true)
    }
    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/x',
      'https://fcm.googleapis.com:8443/x',
      'https://user:pass@fcm.googleapis.com/x',
      'https://fcm.googleapis.com.example.com/x',
      'https://evilweb.push.apple.com/x',
      'https://192.168.1.8/push',
      'https://localhost/push',
      `https://fcm.googleapis.com/${'x'.repeat(2100)}`,
    ]) {
      expect(isPushEndpoint(endpoint)).toBe(false)
    }
  })

  it('needs every key at its size', () => {
    expect(parseWebPushSubscription(subscription)).toEqual(subscription)
    expect(parseWebPushSubscription({ ...subscription, endpoint: 'https://example.com/x' })).toBe(
      null,
    )
    expect(parseWebPushSubscription({ ...subscription, auth: 'AAAA' })).toBeNull()
    expect(
      parseWebPushSubscription({ ...subscription, p256dh: encodeRelayBytes(new Uint8Array(65)) }),
    ).toBeNull()
    expect(
      parseWebPushSubscription({
        ...subscription,
        vapid: { ...subscription.vapid, privateKey: 'AAAA' },
      }),
    ).toBeNull()
    expect(parseWebPushSubscription({ ...subscription, vapid: undefined })).toBeNull()
  })

  it('reads back as the host stored it, its secrets sealed', () => {
    const stored = {
      endpoint: subscription.endpoint,
      p256dh: subscription.p256dh,
      vapidKey: subscription.vapid.publicKey,
      sealed: 'c2VhbGVk',
    }
    expect(parseStoredWebPush(stored)).toEqual(stored)
    expect(parseStoredWebPush({ ...stored, sealed: '' })).toBeNull()
    expect(parseStoredWebPush({ ...stored, sealed: 'not base64!' })).toBeNull()
    expect(parseStoredWebPush({ ...stored, endpoint: 'https://example.com/x' })).toBeNull()
  })

  it('takes only well-formed tags to withdraw', () => {
    expect(parseWithdrawn({ type: 'notifications.withdrawn', tags: ['abc_-1', 7, 'a b'] })).toEqual(
      ['abc_-1'],
    )
    expect(parseWithdrawn({ type: 'renamed', tags: ['abc'] })).toBeNull()
  })
})

describe("a push's signature", () => {
  async function setup() {
    const key = await importRelayKey(await newRelaySeed())
    const other = await importRelayKey(await newRelaySeed())
    const hostId = await relayHostId(key.publicKey)
    const browser = crypto.getRandomValues(new Uint8Array(65))
    const content: PushContent = {
      v: 1,
      host: hostId,
      hostName: 'Studio',
      at: 1,
      tag: 'tag_1',
      title: '修好登录表单',
      body: 'Wants to run pnpm test',
      kind: 'permission',
      sessionId: 's1',
      requestId: 'r1',
    }
    const keys = (id: string) => (id === hostId ? key.publicKey : null)
    return { key, other, hostId, browser, content, keys }
  }

  it('shows what the host it names signed for this browser', async () => {
    const t = await setup()
    const payload = await signWebPush(t.content, t.browser, t.key)
    expect(payload.length).toBeLessThan(MAX_WEB_PUSH_PAYLOAD)
    // Chrome hands a worker only a payload that is UTF-8.
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(payload)).not.toThrow()
    expect(await openWebPush(payload, t.browser, t.keys)).toEqual(t.content)
  })

  it('drops one another host signed in its name', async () => {
    const t = await setup()
    const forged = await signWebPush(t.content, t.browser, t.other)
    expect(await openWebPush(forged, t.browser, t.keys)).toBeNull()
  })

  it('drops one signed for another browser, changed, or naming an unknown host', async () => {
    const t = await setup()
    const payload = await signWebPush(t.content, t.browser, t.key)
    const elsewhere = crypto.getRandomValues(new Uint8Array(65))
    expect(await openWebPush(payload, elsewhere, t.keys)).toBeNull()
    const text = new TextDecoder().decode(payload)
    const changed = new TextEncoder().encode(text.replace('pnpm test', 'rm -rf ~'))
    expect(await openWebPush(changed, t.browser, t.keys)).toBeNull()
    const unknown = await signWebPush({ ...t.content, host: 'a'.repeat(26) }, t.browser, t.key)
    expect(await openWebPush(unknown, t.browser, t.keys)).toBeNull()
    const version = new TextEncoder().encode(`2${text.slice(1)}`)
    expect(await openWebPush(version, t.browser, t.keys)).toBeNull()
    expect(await openWebPush(payload.subarray(0, 60), t.browser, t.keys)).toBeNull()
  })

  it("shows a device's request and a device that joined, each naming what it is about", async () => {
    const t = await setup()
    const base = { v: 1, host: t.hostId, hostName: 'Studio', at: 1, tag: 'tag_2', title: 'Laptop' }
    const request = { ...base, kind: 'device-request', requestId: 3 } as PushContent
    const joined = { ...base, kind: 'device-joined', deviceId: 'a'.repeat(32) } as PushContent
    for (const content of [request, joined]) {
      const payload = await signWebPush(content, t.browser, t.key)
      expect(await openWebPush(payload, t.browser, t.keys)).toEqual(content)
    }
    const named = { ...base, kind: 'device-joined', deviceId: 'Laptop' } as PushContent
    const payload = await signWebPush(named, t.browser, t.key)
    expect(await openWebPush(payload, t.browser, t.keys)).toBeNull()
  })

  it('drops content that is not an alert, though signed', async () => {
    const t = await setup()
    const withdraw = { ...t.content, kind: 'withdraw' } as unknown as PushContent
    const payload = await signWebPush(withdraw, t.browser, t.key)
    expect(await openWebPush(payload, t.browser, t.keys)).toBeNull()
  })
})
