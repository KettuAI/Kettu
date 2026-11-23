import { createECDH, createPublicKey, verify } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { generateKeyPair } from '@shared/remote/noise'
import { pushTag } from '@shared/remote/push'
import {
  decodeRelayBytes,
  encodeRelayBytes,
  importRelayKey,
  newRelaySeed,
  relayHostId,
} from '@shared/remote/relay'
import {
  openWebPush,
  type NotificationsWithdrawn,
  type WebPushSubscription,
} from '@shared/remote/web-push'
import { DeviceStore } from './devices'
import { DeviceNotifications } from './notifications'
import {
  encryptWebPush,
  isUsableSubscription,
  openWebPushSecrets,
  storeWebPush,
  vapidAuthorization,
  webPushStoreKey,
} from './web-push'

const bytes = (text: string): Uint8Array => decodeRelayBytes(text.replace(/\s/g, ''))!

const buffer = (data: Uint8Array): ArrayBuffer =>
  data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer

/** Decrypts a push as the browser does, with WebCrypto alone. */
async function decryptAsBrowser(
  body: Uint8Array,
  ua: { publicKey: Uint8Array; privateKey: InstanceType<typeof CryptoKey> },
  auth: Uint8Array,
): Promise<Uint8Array> {
  const salt = body.subarray(0, 16)
  const idLength = body[20]!
  const serverPublic = body.subarray(21, 21 + idLength)
  const sealed = body.subarray(21 + idLength)
  const serverKey = await crypto.subtle.importKey(
    'raw',
    buffer(serverPublic),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: serverKey },
    ua.privateKey,
    256,
  )
  const derive = async (ikm: ArrayBuffer, salt: Uint8Array, info: Uint8Array, bits: number) => {
    const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
    return crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: buffer(salt), info: buffer(info) },
      key,
      bits,
    )
  }
  const text = (value: string) => new TextEncoder().encode(value)
  const keyInfo = new Uint8Array([...text('WebPush: info\0'), ...ua.publicKey, ...serverPublic])
  const ikm = await derive(shared, auth, keyInfo, 256)
  const cek = await derive(ikm, salt, text('Content-Encoding: aes128gcm\0'), 128)
  const nonce = await derive(ikm, salt, text('Content-Encoding: nonce\0'), 96)
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt'])
  const record = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, buffer(sealed)),
  )
  expect(record.at(-1)).toBe(0x02)
  return record.subarray(0, -1)
}

async function browserKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  return { publicKey, privateKey: pair.privateKey }
}

function vapidPair(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return {
    publicKey: encodeRelayBytes(ecdh.getPublicKey()),
    privateKey: encodeRelayBytes(ecdh.getPrivateKey()),
  }
}

async function subscription(
  endpoint = 'https://fcm.googleapis.com/fcm/send/abc',
): Promise<{ subscription: WebPushSubscription; ua: Awaited<ReturnType<typeof browserKeys>> }> {
  const ua = await browserKeys()
  return {
    ua,
    subscription: {
      endpoint,
      p256dh: encodeRelayBytes(ua.publicKey),
      auth: encodeRelayBytes(crypto.getRandomValues(new Uint8Array(16))),
      vapid: vapidPair(),
    },
  }
}

describe('Web Push encryption (RFC 8291)', () => {
  it("matches the RFC's example", () => {
    const body = encryptWebPush(
      bytes('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'),
      bytes(`BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx
        aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4`),
      bytes('BTBZMqHH6r4Tts7J_aSIgg'),
      {
        salt: bytes('DGv6ra1nlYgDCS1FRnbzlw'),
        privateKey: bytes('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
      },
    )
    expect(encodeRelayBytes(body)).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
        'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
        'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    )
  })

  it('opens in the browser with a fresh key and salt each time', async () => {
    const ua = await browserKeys()
    const auth = crypto.getRandomValues(new Uint8Array(16))
    const plaintext = new TextEncoder().encode('{"title":"会话需要你"}')
    const first = encryptWebPush(plaintext, ua.publicKey, auth)
    const second = encryptWebPush(plaintext, ua.publicKey, auth)
    expect(first.subarray(0, 16).equals(second.subarray(0, 16))).toBe(false)
    expect(first.readUInt32BE(16)).toBe(4096)
    expect(await decryptAsBrowser(first, ua, auth)).toEqual(plaintext)
    // Another browser's secret opens nothing.
    await expect(
      decryptAsBrowser(first, ua, crypto.getRandomValues(new Uint8Array(16))),
    ).rejects.toThrow()
  })

  it('refuses a key that is not on the curve', () => {
    const bad = new Uint8Array(65).fill(7)
    bad[0] = 4
    expect(() => encryptWebPush(new Uint8Array(1), bad, new Uint8Array(16))).toThrow()
  })
})

describe('VAPID (RFC 8292)', () => {
  it("signs a token for the endpoint's origin that the browser's public key verifies", () => {
    const pair = vapidPair()
    const now = Date.UTC(2026, 10, 23, 12)
    const header = vapidAuthorization(
      'https://web.push.apple.com/QGuQyavXutnMH5j0/token?x=1',
      bytes(pair.publicKey),
      bytes(pair.privateKey),
      now,
    )
    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header)
    expect(match).not.toBeNull()
    const [, head, claims, signature, k] = match!
    expect(k).toBe(pair.publicKey)
    const json = (part: string) => JSON.parse(Buffer.from(bytes(part)).toString('utf8'))
    expect(json(head!)).toEqual({ typ: 'JWT', alg: 'ES256' })
    const read = json(claims!)
    expect(read.aud).toBe('https://web.push.apple.com')
    expect(read.sub).toMatch(/^https:\/\//)
    expect(read.exp).toBeGreaterThan(now / 1000)
    expect(read.exp).toBeLessThanOrEqual(now / 1000 + 24 * 60 * 60)
    const publicKey = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: encodeRelayBytes(bytes(pair.publicKey).subarray(1, 33)),
        y: encodeRelayBytes(bytes(pair.publicKey).subarray(33)),
      },
      format: 'jwk',
    })
    const signed = Buffer.from(`${head}.${claims}`)
    const raw = bytes(signature!)
    expect(raw).toHaveLength(64)
    expect(verify('sha256', signed, { key: publicKey, dsaEncoding: 'ieee-p1363' }, raw)).toBe(true)
    expect(
      verify(
        'sha256',
        Buffer.from(`${head}.x${claims}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        raw,
      ),
    ).toBe(false)
  })

  it('takes a subscription only when its private key is its public key', async () => {
    const { subscription: good } = await subscription()
    expect(isUsableSubscription(good)).toBe(true)
    const other = vapidPair()
    expect(
      isUsableSubscription({
        ...good,
        vapid: { publicKey: good.vapid.publicKey, privateKey: other.privateKey },
      }),
    ).toBe(false)
  })
})

describe("a subscription's secrets on the host", () => {
  it('are sealed for the device and the endpoint with the identity key', async () => {
    const { subscription: given } = await subscription()
    const key = webPushStoreKey(crypto.getRandomValues(new Uint8Array(32)))
    const stored = storeWebPush(given, 'device-1', key)
    expect(JSON.stringify(stored)).not.toContain(given.auth)
    expect(JSON.stringify(stored)).not.toContain(given.vapid.privateKey)
    const opened = openWebPushSecrets(stored, 'device-1', key)
    expect(encodeRelayBytes(opened!.auth)).toBe(given.auth)
    expect(encodeRelayBytes(opened!.vapidPrivateKey)).toBe(given.vapid.privateKey)
    expect(openWebPushSecrets(stored, 'device-2', key)).toBeNull()
    expect(
      openWebPushSecrets({ ...stored, endpoint: `${stored.endpoint}x` }, 'device-1', key),
    ).toBeNull()
    const otherKey = webPushStoreKey(crypto.getRandomValues(new Uint8Array(32)))
    expect(openWebPushSecrets(stored, 'device-1', otherKey)).toBeNull()
  })
})

describe("a browser's notifications", () => {
  let dir: string | null = null
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = null
  })

  async function setup(answers: number[] = []) {
    dir = await mkdtemp(path.join(tmpdir(), 'kettu-web-push-'))
    const logs: string[] = []
    const log = (level: string, message: string) => logs.push(`${level}: ${message}`)
    const devices = await DeviceStore.load(dir, log)
    const browserKey = await generateKeyPair()
    const browser = (await devices.add({
      publicKey: Buffer.from(browserKey.publicKey).toString('base64'),
      name: 'Safari · iPhone',
      kind: 'web',
      platform: 'iOS',
      model: 'Safari',
    }))!
    const key = await importRelayKey(await newRelaySeed())
    const hostId = await relayHostId(key.publicKey)
    const storeKey = webPushStoreKey(crypto.getRandomValues(new Uint8Array(32)))
    const requests: { url: string; headers: Record<string, string>; body: Uint8Array }[] = []
    const told: NotificationsWithdrawn[] = []
    const state = { foreground: false }
    let heard: () => void = () => {}
    const notifications = new DeviceNotifications({
      devices,
      key,
      hostId,
      url: 'https://push.example.test',
      hostName: () => 'Studio',
      token: () => null,
      showing: () => false,
      foreground: () => state.foreground,
      tell: (_, message) => told.push(message),
      storeKey,
      log,
      mergeMs: 1,
      retry: { firstMs: 1, maxMs: 5, attempts: 3 },
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          headers: init!.headers as Record<string, string>,
          body: init!.body as Uint8Array,
        })
        heard()
        return new Response(null, { status: answers.shift() ?? 201 })
      },
    })
    const request = () => new Promise<void>((resolve) => (heard = resolve))
    return {
      dir,
      devices,
      browser,
      browserKey,
      key,
      hostId,
      notifications,
      requests,
      told,
      state,
      logs,
      request,
    }
  }

  const attention = (sessionId: string) => ({
    kind: 'turn-ended' as const,
    sessionId,
    title: 'Fix the login form',
    body: 'The tests pass.',
    inFront: false,
    devices: [],
  })

  it('keep the subscription sealed in the device file, and push signed and encrypted', async () => {
    const t = await setup()
    const { subscription: given, ua } = await subscription()
    const state = await t.notifications.update(t.browser.id, {
      web: given,
      choices: { turnEnded: true },
    })
    expect(state).toMatchObject({ web: { endpoint: given.endpoint, withdrawn: [] } })
    await t.devices.flush()
    const file = await readFile(path.join(t.dir, 'remote', 'devices.json'), 'utf8')
    expect(file).toContain(given.endpoint)
    expect(file).not.toContain(given.auth)
    expect(file).not.toContain(given.vapid.privateKey)
    // What the file keeps reads back after a restart.
    const reloaded = await DeviceStore.load(t.dir, () => {})
    expect(reloaded.push(t.browser.id)?.web).toEqual(t.devices.push(t.browser.id)?.web)

    const sent = t.request()
    t.notifications.attention(attention('s1'))
    await sent
    const [request] = t.requests
    expect(request!.url).toBe(given.endpoint)
    expect(request!.headers).toMatchObject({
      'Content-Encoding': 'aes128gcm',
      TTL: expect.stringMatching(/^\d+$/),
      Authorization: expect.stringMatching(/^vapid t=.+, k=/),
    })
    const payload = await decryptAsBrowser(request!.body, ua, bytes(given.auth))
    const tag = await pushTag(t.browserKey.publicKey, t.hostId, 's1')
    const content = await openWebPush(payload, ua.publicKey, (id) =>
      id === t.hostId ? t.key.publicKey : null,
    )
    expect(content).toMatchObject({
      host: t.hostId,
      hostName: 'Studio',
      kind: 'turn-ended',
      sessionId: 's1',
      title: 'Fix the login form',
      tag,
    })
    expect(request!.headers.Topic).toBe(tag)
    t.notifications.stop()
  })

  it('push nothing while the page is in view, which shows its own', async () => {
    const t = await setup()
    const { subscription: given } = await subscription()
    await t.notifications.update(t.browser.id, { web: given })
    t.state.foreground = true
    t.notifications.attention(attention('s1'))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(t.requests).toEqual([])
    t.notifications.stop()
  })

  it('withdraw by telling the page, never by a push, until one of the same is sent', async () => {
    const t = await setup()
    const { subscription: given } = await subscription()
    await t.notifications.update(t.browser.id, { web: given })
    const sent = t.request()
    t.notifications.attention(attention('s1'))
    await sent
    t.notifications.seen('s1')
    await new Promise((resolve) => setTimeout(resolve, 10))
    const tag = await pushTag(t.browserKey.publicKey, t.hostId, 's1')
    expect(t.requests).toHaveLength(1)
    expect(t.told).toEqual([{ type: 'notifications.withdrawn', tags: [tag] }])
    expect(t.notifications.state(t.browser.id).web?.withdrawn).toEqual([tag])
    const again = t.request()
    t.notifications.attention(attention('s1'))
    await again
    expect(t.notifications.state(t.browser.id).web?.withdrawn).toEqual([])
    t.notifications.stop()
  })

  it('end the subscription once the push service says it is gone', async () => {
    const t = await setup([410])
    const { subscription: given } = await subscription()
    await t.notifications.update(t.browser.id, { web: given })
    const sent = t.request()
    t.notifications.attention(attention('s1'))
    await sent
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(t.devices.push(t.browser.id)?.web).toBeUndefined()
    expect(t.notifications.state(t.browser.id).web).toBeNull()
    t.notifications.stop()
  })

  it('refuse a subscription whose keys are not a pair, and go with the device', async () => {
    const t = await setup()
    const { subscription: given } = await subscription()
    const other = vapidPair()
    expect(
      await t.notifications.update(t.browser.id, {
        web: { ...given, vapid: { ...given.vapid, privateKey: other.privateKey } },
      }),
    ).toBe('invalid')
    expect(t.devices.push(t.browser.id)).toBeNull()
    await t.notifications.update(t.browser.id, { web: given })
    await t.devices.remove(t.browser.id)
    expect(t.devices.push(t.browser.id)).toBeNull()
    t.notifications.stop()
  })
})
