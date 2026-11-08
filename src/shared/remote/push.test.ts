import { describe, expect, it } from 'vitest'
import { currentPrimitives } from './primitives'
import {
  DEFAULT_CHOICES,
  encodeSealed,
  openPush,
  parseChoices,
  parseDevicePush,
  parseNotificationsUpdate,
  parsePushRequest,
  parsePushTarget,
  pushRequestHeaders,
  pushRequestText,
  pushTag,
  pushUrlFrom,
  sealPush,
  type PushContent,
} from './push'
import vectors from './push-vectors.json'
import { decodeRelayBytes, importRelayKey, relayHostId, verifyRelaySignature } from './relay'

const bytes = (text: string): Uint8Array => decodeRelayBytes(text)!

async function keys() {
  const primitives = currentPrimitives()
  const host = await importRelayKey(bytes(vectors.keys.hostSeed))
  const device = await primitives.importKeyPair(bytes(vectors.keys.devicePrivateKey), false)
  const ephemeral = await primitives.importKeyPair(bytes(vectors.keys.ephemeralPrivateKey), false)
  return { host, device, ephemeral }
}

describe('the sealed envelope', () => {
  it('uses the keys the vectors name', async () => {
    const { host, device, ephemeral } = await keys()
    expect(encodeSealed(host.publicKey)).toBe(vectors.keys.hostPublicKey)
    expect(await relayHostId(host.publicKey)).toBe(vectors.keys.hostId)
    expect(encodeSealed(device.publicKey)).toBe(vectors.keys.devicePublicKey)
    expect(encodeSealed(ephemeral.publicKey)).toBe(vectors.keys.ephemeralPublicKey)
    // RFC 7748's shared secret of the two.
    const shared = await currentPrimitives().dh(ephemeral.privateKey, device.publicKey)
    expect(Buffer.from(shared).toString('hex')).toBe(
      '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742',
    )
  })

  for (const vector of vectors.sealed) {
    it(`seals the ${vector.name} vector byte for byte, and its device opens and checks it`, async () => {
      const { host, device, ephemeral } = await keys()
      const content = vector.content as PushContent
      expect(JSON.stringify(content)).toBe(vector.body)
      const envelope = await sealPush(content, device.publicKey, host, ephemeral)
      expect(encodeSealed(envelope)).toBe(vector.envelope)

      const opened = (await openPush(envelope, device))!
      expect(new TextDecoder().decode(opened.body)).toBe(vector.body)
      expect(encodeSealed(opened.signed)).toBe(vector.signed)
      expect(encodeSealed(opened.signature)).toBe(vector.signature)
      expect(await verifyRelaySignature(host.publicKey, opened.signature, opened.signed)).toBe(true)
    })
  }

  it('gives a fresh ephemeral key each time, which only the device opens', async () => {
    const { host, device } = await keys()
    const content = vectors.sealed[0]!.content as PushContent
    const first = await sealPush(content, device.publicKey, host)
    const second = await sealPush(content, device.publicKey, host)
    expect(encodeSealed(first.subarray(1, 33))).not.toBe(encodeSealed(second.subarray(1, 33)))
    const opened = (await openPush(first, device))!
    expect(await verifyRelaySignature(host.publicKey, opened.signature, opened.signed)).toBe(true)

    const other = await currentPrimitives().generateKeyPair(false)
    expect(await openPush(first, other)).toBeNull()
  })

  it('refuses an envelope changed anywhere', async () => {
    const { device } = await keys()
    const envelope = bytes(vectors.sealed[0]!.envelope)
    for (const at of [0, 1, 40, envelope.length - 1]) {
      const changed = envelope.slice()
      changed[at]! ^= 1
      expect(await openPush(changed, device)).toBeNull()
    }
    expect(await openPush(envelope.subarray(0, 100), device)).toBeNull()
  })

  it('signs for one device and one envelope, so it cannot be passed on', async () => {
    const { host, device } = await keys()
    const opened = (await openPush(bytes(vectors.sealed[0]!.envelope), device))!
    const other = await currentPrimitives().generateKeyPair(false)
    const elsewhere = opened.signed.slice()
    elsewhere.set(other.publicKey, 'kettu-push-content/1\n'.length)
    expect(await verifyRelaySignature(host.publicKey, opened.signature, elsewhere)).toBe(false)
  })

  it("tags a device's notifications by subject", async () => {
    const { device } = await keys()
    for (const [subject, tag] of Object.entries(vectors.tags)) {
      expect(await pushTag(device.publicKey, vectors.keys.hostId, subject)).toBe(tag)
    }
  })
})

describe('a request to the gateway', () => {
  it('signs the context, the origin, the id and the body, one per line', async () => {
    const { host } = await keys()
    const { origin, id, body, text, signature, accessToken } = vectors.request
    expect(new TextDecoder().decode(pushRequestText(origin, id, body))).toBe(text)
    const headers = await pushRequestHeaders(host, origin, id, body, accessToken)
    expect(headers).toEqual({
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Kettu-Host-Key': vectors.keys.hostPublicKey,
      'Kettu-Signature': signature,
    })
    const signed = pushRequestText(origin, id, body)
    expect(await verifyRelaySignature(host.publicKey, bytes(signature), signed)).toBe(true)
    const other = pushRequestText('https://push.example.com', id, body)
    expect(await verifyRelaySignature(host.publicKey, bytes(signature), other)).toBe(false)
  })

  it('is read when it is one and refused otherwise', () => {
    for (const text of vectors.requests.valid) expect(parsePushRequest(text)).not.toBeNull()
    for (const text of vectors.requests.invalid) expect(parsePushRequest(text)).toBeNull()
    expect(parsePushRequest('x'.repeat(9000))).toBeNull()
  })

  it('goes to the project gateway unless a development run names another', () => {
    expect(pushUrlFrom(undefined)).toBe('https://push.kettu.sh')
    expect(pushUrlFrom('http://localhost:47901/')).toBe('http://localhost:47901')
    expect(() => pushUrlFrom('ftp://push')).toThrow()
  })
})

describe("a device's notifications", () => {
  it('take a target and choices that are ones, and refuse the rest', () => {
    for (const target of vectors.targets.valid) expect(parsePushTarget(target)).toEqual(target)
    for (const target of vectors.targets.invalid) expect(parsePushTarget(target)).toBeNull()
    for (const choices of vectors.choices.invalid) expect(parseChoices(choices)).toBeNull()
    expect(parseChoices({ permission: false, muted: ['a', 'b', 'a'] })).toEqual({
      permission: false,
      muted: ['a', 'b'],
    })
    expect(parseChoices({ muted: Array.from({ length: 501 }, (_, i) => `s${i}`) })).toBeNull()
  })

  it('read an update that clears the target, changes it or leaves it', () => {
    expect(parseNotificationsUpdate({ target: null })).toEqual({ target: null })
    expect(parseNotificationsUpdate({ choices: { routines: true } })).toEqual({
      choices: { routines: true },
    })
    expect(parseNotificationsUpdate({ target: { apns: {} } })).toBeNull()
    expect(parseNotificationsUpdate(null)).toBeNull()
  })

  it('are read back from storage with the defaults for what they leave out', () => {
    const target = vectors.targets.valid[1]!
    expect(parseDevicePush({ target, choices: { details: false } })).toEqual({
      target,
      choices: { ...DEFAULT_CHOICES, details: false },
    })
    expect(parseDevicePush({ target: null, choices: {} })).toEqual({
      target: null,
      choices: DEFAULT_CHOICES,
    })
    expect(parseDevicePush({ target: { apns: {} }, choices: {} })).toBeNull()
  })
})
