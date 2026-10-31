import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Handshake,
  PROLOGUE,
  generateKeyPair,
  importKeyPair,
  type HandshakeOptions,
  type KeyPair,
  type NoisePattern,
  type TransportCiphers,
} from './noise'
// Cacophony's test vectors (https://github.com/haskell-cryptography/cacophony, vectors/,
// public domain), only the two protocols the channel runs.
import vectorFile from './noise-vectors.json'

interface Vector {
  protocol_name: string
  init_prologue: string
  init_psks?: string[]
  init_static: string
  init_ephemeral: string
  init_remote_static: string
  resp_prologue: string
  resp_psks?: string[]
  resp_static: string
  resp_ephemeral: string
  handshake_hash: string
  messages: { payload: string; ciphertext: string }[]
}

const VECTORS: Vector[] = vectorFile.vectors

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => parseInt(byte, 16))
const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
const text = (value: string): Uint8Array => new TextEncoder().encode(value)

function flip(bytes: Uint8Array, index: number): Uint8Array {
  const out = bytes.slice()
  out[index] ^= 1
  return out
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe.each(VECTORS)('$protocol_name', (vector) => {
  const pattern: NoisePattern = vector.protocol_name.includes('psk1') ? 'IKpsk1' : 'IK'

  async function handshakeAs(role: 'initiator' | 'responder'): Promise<Handshake> {
    const initiatorStatic = await importKeyPair(fromHex(vector.init_static))
    if (role === 'initiator') {
      return Handshake.create({
        role,
        pattern,
        staticKey: initiatorStatic,
        remoteStaticKey: fromHex(vector.init_remote_static),
        psk: vector.init_psks && fromHex(vector.init_psks[0]),
        prologue: fromHex(vector.init_prologue),
        ephemeral: await importKeyPair(fromHex(vector.init_ephemeral)),
      })
    }
    return Handshake.create({
      role,
      pattern,
      staticKey: await importKeyPair(fromHex(vector.resp_static)),
      accept: (key) => toHex(key) === toHex(initiatorStatic.publicKey),
      psk: vector.resp_psks && fromHex(vector.resp_psks[0]),
      prologue: fromHex(vector.resp_prologue),
      ephemeral: await importKeyPair(fromHex(vector.resp_ephemeral)),
    })
  }

  it.each(['initiator', 'responder'] as const)(
    'reproduces every message and the handshake hash as the %s',
    async (role) => {
      const handshake = await handshakeAs(role)
      let ciphers: TransportCiphers | null = null
      for (const [index, { payload, ciphertext }] of vector.messages.entries()) {
        const sending = (index % 2 === 0) === (role === 'initiator')
        if (!handshake.finished) {
          if (sending)
            expect(toHex(await handshake.writeMessage(fromHex(payload)))).toBe(ciphertext)
          else expect(toHex(await handshake.readMessage(fromHex(ciphertext)))).toBe(payload)
          continue
        }
        ciphers ??= await handshake.split()
        if (sending) expect(toHex(await ciphers.send.encrypt(fromHex(payload)))).toBe(ciphertext)
        else expect(toHex(await ciphers.receive.decrypt(fromHex(ciphertext)))).toBe(payload)
      }
      expect(ciphers).not.toBeNull()
      expect(toHex(handshake.handshakeHash)).toBe(vector.handshake_hash)
    },
  )
})

interface Sides {
  device: KeyPair
  host: KeyPair
  initiator: Handshake
  responder: Handshake
}

async function sides(
  pattern: NoisePattern,
  responder: Partial<Extract<HandshakeOptions, { role: 'responder' }>> = {},
): Promise<Sides> {
  const device = await generateKeyPair()
  const host = await generateKeyPair()
  const psk = pattern === 'IKpsk1' ? new Uint8Array(32).fill(7) : undefined
  return {
    device,
    host,
    initiator: await Handshake.create({
      role: 'initiator',
      pattern,
      staticKey: device,
      remoteStaticKey: host.publicKey,
      psk,
    }),
    responder: await Handshake.create({
      role: 'responder',
      pattern,
      staticKey: host,
      accept: () => true,
      psk,
      ...responder,
    }),
  }
}

async function connect(
  pattern: NoisePattern = 'IK',
): Promise<[TransportCiphers, TransportCiphers]> {
  const { initiator, responder } = await sides(pattern)
  await responder.readMessage(await initiator.writeMessage())
  await initiator.readMessage(await responder.writeMessage())
  return [await initiator.split(), await responder.split()]
}

describe('Handshake', () => {
  it.each(['IK', 'IKpsk1'] as const)('connects two generated keys with %s', async (pattern) => {
    const { device, initiator, responder } = await sides(pattern)
    const hello = await responder.readMessage(await initiator.writeMessage(text('hello')))
    expect(responder.remoteStaticKey).toEqual(device.publicKey)
    const welcome = await initiator.readMessage(await responder.writeMessage(text('welcome')))
    expect([hello, welcome]).toEqual([text('hello'), text('welcome')])
    expect(initiator.handshakeHash).toEqual(responder.handshakeHash)

    const [toHost, toDevice] = [await initiator.split(), await responder.split()]
    expect(await toDevice.receive.decrypt(await toHost.send.encrypt(text('up')))).toEqual(
      text('up'),
    )
    expect(await toHost.receive.decrypt(await toDevice.send.encrypt(text('down')))).toEqual(
      text('down'),
    )
  })

  it('binds both sides to the channel prologue', async () => {
    const host = await generateKeyPair()
    const initiator = await Handshake.create({
      role: 'initiator',
      pattern: 'IK',
      staticKey: await generateKeyPair(),
      remoteStaticKey: host.publicKey,
      prologue: text('kettu-channel/2'),
    })
    const responder = await Handshake.create({
      role: 'responder',
      pattern: 'IK',
      staticKey: host,
      accept: () => true,
    })
    expect(new TextDecoder().decode(PROLOGUE)).toBe('kettu-channel/1')
    await expect(responder.readMessage(await initiator.writeMessage())).rejects.toThrow(
      'failed to decrypt',
    )
  })

  it('shows the responder the static key before anything after it is decrypted', async () => {
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt')
    const seen: { key: string; decrypted: number }[] = []
    const { device, initiator, responder } = await sides('IK', {
      accept: async (key) => {
        seen.push({ key: toHex(key), decrypted: decrypt.mock.calls.length })
        return false
      },
    })
    const message = await initiator.writeMessage(text('hello'))
    await expect(responder.readMessage(message)).rejects.toThrow('refused')
    expect(seen).toEqual([{ key: toHex(device.publicKey), decrypted: 1 }])
    expect(decrypt).toHaveBeenCalledTimes(1)
    expect(responder.remoteStaticKey).toBeNull()
    await expect(responder.writeMessage()).rejects.toThrow('failed')
    await expect(responder.readMessage(message)).rejects.toThrow('failed')
  })

  it('fails the first message with a wrong pairing secret', async () => {
    const { initiator, responder } = await sides('IKpsk1', { psk: new Uint8Array(32).fill(8) })
    await expect(responder.readMessage(await initiator.writeMessage())).rejects.toThrow(
      'failed to decrypt',
    )
  })

  it('fails on a changed byte in either message', async () => {
    const first = await sides('IK')
    const message = await first.initiator.writeMessage(text('hello'))
    await expect(first.responder.readMessage(flip(message, message.length - 1))).rejects.toThrow(
      'failed to decrypt',
    )

    const second = await sides('IK')
    await second.responder.readMessage(await second.initiator.writeMessage())
    const answer = await second.responder.writeMessage()
    await expect(second.initiator.readMessage(flip(answer, 40))).rejects.toThrow(
      'failed to decrypt',
    )
  })

  it('refuses a message that is too short or out of turn', async () => {
    const { initiator, responder } = await sides('IK')
    await expect(initiator.readMessage(new Uint8Array(48))).rejects.toThrow('waiting to write')
    await expect(responder.readMessage(new Uint8Array(40).fill(9))).rejects.toThrow('too short')
  })

  it('refuses a low-order ephemeral key', async () => {
    const { initiator, responder } = await sides('IK')
    const message = await initiator.writeMessage()
    message.fill(0, 0, 32)
    await expect(responder.readMessage(message)).rejects.toThrow('key exchange failed')
  })

  it('checks its options', async () => {
    const staticKey = await generateKeyPair()
    const base = { role: 'responder', staticKey, accept: () => true } as const
    await expect(Handshake.create({ ...base, pattern: 'IKpsk1' })).rejects.toThrow('needs')
    await expect(
      Handshake.create({ ...base, pattern: 'IK', psk: new Uint8Array(32) }),
    ).rejects.toThrow('takes no')
    await expect(
      Handshake.create({ ...base, pattern: 'IKpsk1', psk: new Uint8Array(16) }),
    ).rejects.toThrow('32 bytes')
  })

  it('splits only once, after the last message', async () => {
    const { initiator, responder } = await sides('IK')
    await expect(initiator.split()).rejects.toThrow('not finished')
    await responder.readMessage(await initiator.writeMessage())
    await initiator.readMessage(await responder.writeMessage())
    await initiator.split()
    await expect(initiator.split()).rejects.toThrow('already split')
  })
})

describe('CipherState', () => {
  it('fails on a changed byte', async () => {
    const [device, host] = await connect()
    const sealed = await device.send.encrypt(text('hello'))
    await expect(host.receive.decrypt(flip(sealed, 2))).rejects.toThrow('failed to decrypt')
  })

  it('refuses a message past the Noise limit', async () => {
    const [device, host] = await connect()
    await expect(device.send.encrypt(new Uint8Array(65520))).rejects.toThrow('too long')
    await expect(host.receive.decrypt(new Uint8Array(65536))).rejects.toThrow('too long')
    const sealed = await device.send.encrypt(new Uint8Array(65519))
    expect(sealed).toHaveLength(65535)
    expect(await host.receive.decrypt(sealed)).toEqual(new Uint8Array(65519))
  })

  it('fails on a replayed message', async () => {
    const [device, host] = await connect()
    const sealed = await device.send.encrypt(text('once'))
    expect(await host.receive.decrypt(sealed)).toEqual(text('once'))
    await expect(host.receive.decrypt(sealed)).rejects.toThrow('failed to decrypt')
  })

  it('fails on a skipped message', async () => {
    const [device, host] = await connect()
    await device.send.encrypt(text('first'))
    const second = await device.send.encrypt(text('second'))
    await expect(host.receive.decrypt(second)).rejects.toThrow('failed to decrypt')
  })

  it('takes nonces in the order calls are made', async () => {
    const [device, host] = await connect()
    const words = ['one', 'two', 'three', 'four']
    const sealed = await Promise.all(words.map((word) => device.send.encrypt(text(word))))
    for (const [index, word] of words.entries()) {
      expect(await host.receive.decrypt(sealed[index])).toEqual(text(word))
    }
  })

  it('keeps working once both sides rekey', async () => {
    const [device, host] = await connect()
    await host.receive.decrypt(await device.send.encrypt(text('before')))
    const rekeyed = device.send.rekey()
    // A call made right after rekey() uses the new key, though it is still being derived.
    const sealed = device.send.encrypt(text('after'))
    await rekeyed
    await host.receive.rekey()
    expect(await host.receive.decrypt(await sealed)).toEqual(text('after'))
  })

  it('fails when only one side rekeys', async () => {
    const [device, host] = await connect()
    await device.send.rekey()
    await expect(host.receive.decrypt(await device.send.encrypt(text('after')))).rejects.toThrow(
      'failed to decrypt',
    )
  })
})
