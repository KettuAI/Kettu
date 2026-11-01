// The Noise handshakes a device and a computer run, Noise_IK_25519_AESGCM_SHA256 for a paired
// device and Noise_IKpsk1_25519_AESGCM_SHA256 for pairing, as revision 34 of the Noise Protocol
// Framework defines them. On WebCrypto, so Node.js, Electron and browsers run the same code, or on
// noble where a page has no `crypto.subtle` (primitives.ts).

import {
  currentPrimitives,
  type AesGcm,
  type KeyPair,
  type Primitives,
  type PrivateKey,
  type WebCryptoKey,
} from './primitives'

export type { KeyPair, PrivateKey } from './primitives'

const DHLEN = 32
const HASHLEN = 32
const TAGLEN = 16

/** The largest Noise message, handshake or transport. */
export const MAX_NOISE_MESSAGE = 65535

/** Binds both handshakes to this channel format, so a later format cannot be mistaken for it. */
export const PROLOGUE = new TextEncoder().encode('kettu-channel/1')

export type NoisePattern = 'IK' | 'IKpsk1'

interface CommonOptions {
  pattern: NoisePattern
  staticKey: KeyPair
  /** The 32-byte pre-shared key, which IKpsk1 needs and IK takes none of. */
  psk?: Uint8Array
  /** Only for test vectors: every connection uses `PROLOGUE`. */
  prologue?: Uint8Array
  /** Only for test vectors: a fixed ephemeral key gives up forward secrecy. */
  ephemeral?: KeyPair
}

export interface InitiatorOptions extends CommonOptions {
  role: 'initiator'
  /** The responder's static public key, which IK needs before the first message. */
  remoteStaticKey: Uint8Array
}

export interface ResponderOptions extends CommonOptions {
  role: 'responder'
  /**
   * Decides on the initiator's static key as soon as the first message reveals it, before
   * anything after it is decrypted. A refused key ends the handshake.
   */
  accept: (publicKey: Uint8Array) => boolean | Promise<boolean>
}

export type HandshakeOptions = InitiatorOptions | ResponderOptions

/** One cipher for each direction, from Noise's `Split()`. */
export interface TransportCiphers {
  send: CipherState
  receive: CipherState
}

type Token = 'e' | 's' | 'ee' | 'es' | 'se' | 'ss' | 'psk'

// Both patterns have the pre-message `<- s`: the initiator knows the responder's static key.
const PATTERNS: Record<NoisePattern, Token[][]> = {
  IK: [
    ['e', 'es', 's', 'ss'],
    ['e', 'ee', 'se'],
  ],
  IKpsk1: [
    ['e', 'es', 's', 'ss', 'psk'],
    ['e', 'ee', 'se'],
  ],
}

const EMPTY = new Uint8Array(0)

// Noise reserves the nonce 2^64 - 1 for Rekey(), so a counter stops below it; a JavaScript number
// counts exactly only to 2^53, far more messages than a key ever carries.
const MAX_NONCE = Number.MAX_SAFE_INTEGER
const REKEY_NONCE = new Uint8Array([0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255])

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

// Noise's HKDF on HMAC, as the specification writes it. WebCrypto's HKDF gives the same bytes but
// takes the input as an imported key, an empty one for Split().
async function hkdf(
  primitives: Primitives,
  chainingKey: Uint8Array,
  input: Uint8Array,
  outputs: 2 | 3,
): Promise<Uint8Array[]> {
  const tempKey = await primitives.hmacSha256(chainingKey, input)
  const out: Uint8Array[] = []
  let previous: Uint8Array = EMPTY
  for (let i = 1; i <= outputs; i++) {
    const output = await primitives.hmacSha256(tempKey, concat(previous, Uint8Array.of(i)))
    out.push(output)
    previous = output
  }
  return out
}

async function dh(
  primitives: Primitives,
  privateKey: PrivateKey,
  publicKey: Uint8Array,
): Promise<Uint8Array> {
  try {
    return await primitives.dh(privateKey, publicKey)
  } catch {
    // Both primitives refuse a low-order public key, whose shared secret would be all zeros.
    throw new Error('Noise key exchange failed')
  }
}

/**
 * A new X25519 key pair on the current primitives. An extractable one is a WebCrypto key for
 * `crypto.subtle.exportKey`, which noble refuses to make.
 */
export function generateKeyPair(extractable: true): Promise<KeyPair<WebCryptoKey>>
export function generateKeyPair(extractable?: boolean): Promise<KeyPair>
export async function generateKeyPair(extractable = false): Promise<KeyPair> {
  return currentPrimitives().generateKeyPair(extractable)
}

/** A key pair from the 32 raw bytes of an X25519 private key, extractable as generateKeyPair's. */
export function importKeyPair(
  privateKey: Uint8Array,
  extractable: true,
): Promise<KeyPair<WebCryptoKey>>
export function importKeyPair(privateKey: Uint8Array, extractable?: boolean): Promise<KeyPair>
export async function importKeyPair(privateKey: Uint8Array, extractable = false): Promise<KeyPair> {
  if (privateKey.length !== DHLEN) throw new Error('An X25519 private key is 32 bytes')
  return currentPrimitives().importKeyPair(privateKey, extractable)
}

/**
 * AES-256-GCM with Noise's nonce: 32 zero bits, then a 64-bit big-endian counter. Each call takes
 * its nonce when it is made, so calls started at once still use them in order. A failed decryption
 * still uses up its nonce, so a cipher fails closed where Noise would let the caller retry.
 */
export class CipherState {
  private key: Promise<AesGcm> | null
  private nonce = 0

  /** A cipher on the 32-byte `key`, or one that passes data through unchanged without a key. */
  constructor(
    key: Uint8Array | null = null,
    private readonly primitives: Primitives = currentPrimitives(),
  ) {
    this.key = key && primitives.aesGcm(key)
  }

  get hasKey(): boolean {
    return this.key !== null
  }

  async encrypt(plaintext: Uint8Array, ad: Uint8Array = EMPTY): Promise<Uint8Array> {
    if (!this.key) return plaintext.slice()
    if (plaintext.length + TAGLEN > MAX_NOISE_MESSAGE) throw new Error('Noise message is too long')
    const key = this.key
    const nonce = this.nextNonce()
    return (await key).seal(nonce, plaintext, ad)
  }

  async decrypt(ciphertext: Uint8Array, ad: Uint8Array = EMPTY): Promise<Uint8Array> {
    if (!this.key) return ciphertext.slice()
    if (ciphertext.length > MAX_NOISE_MESSAGE) throw new Error('Noise message is too long')
    const key = this.key
    const nonce = this.nextNonce()
    const cipher = await key
    try {
      return await cipher.open(nonce, ciphertext, ad)
    } catch {
      throw new Error('Noise message failed to decrypt')
    }
  }

  /** Noise's `Rekey()`; calls made after it use the new key, though it is derived asynchronously. */
  rekey(): Promise<void> {
    const key = this.key
    if (!key) throw new Error('A cipher without a key cannot rekey')
    this.key = key.then(async (current) => {
      const out = await current.seal(REKEY_NONCE, new Uint8Array(32), EMPTY)
      return this.primitives.aesGcm(out.subarray(0, 32))
    })
    return this.key.then(() => undefined)
  }

  private nextNonce(): Uint8Array<ArrayBuffer> {
    if (this.nonce >= MAX_NONCE) throw new Error('Noise nonce is exhausted')
    const iv = new Uint8Array(12)
    const view = new DataView(iv.buffer)
    view.setUint32(4, Math.floor(this.nonce / 2 ** 32))
    view.setUint32(8, this.nonce % 2 ** 32)
    this.nonce++
    return iv
  }
}

class SymmetricState {
  private cipher = new CipherState()

  private constructor(
    private readonly primitives: Primitives,
    private chainingKey: Uint8Array,
    private hash: Uint8Array,
  ) {}

  static async create(primitives: Primitives, protocolName: string): Promise<SymmetricState> {
    const name = new TextEncoder().encode(protocolName)
    let hash: Uint8Array = new Uint8Array(HASHLEN)
    if (name.length <= HASHLEN) hash.set(name)
    else hash = await primitives.sha256(name)
    return new SymmetricState(primitives, hash, hash)
  }

  get hasKey(): boolean {
    return this.cipher.hasKey
  }

  get handshakeHash(): Uint8Array {
    return this.hash
  }

  async mixKey(input: Uint8Array): Promise<void> {
    const [chainingKey, key] = await hkdf(this.primitives, this.chainingKey, input, 2)
    this.chainingKey = chainingKey
    this.cipher = new CipherState(key, this.primitives)
  }

  async mixHash(data: Uint8Array): Promise<void> {
    this.hash = await this.primitives.sha256(concat(this.hash, data))
  }

  async mixKeyAndHash(input: Uint8Array): Promise<void> {
    const [chainingKey, hash, key] = await hkdf(this.primitives, this.chainingKey, input, 3)
    this.chainingKey = chainingKey
    await this.mixHash(hash)
    this.cipher = new CipherState(key, this.primitives)
  }

  async encryptAndHash(plaintext: Uint8Array): Promise<Uint8Array> {
    const ciphertext = await this.cipher.encrypt(plaintext, this.hash)
    await this.mixHash(ciphertext)
    return ciphertext
  }

  async decryptAndHash(ciphertext: Uint8Array): Promise<Uint8Array> {
    const plaintext = await this.cipher.decrypt(ciphertext, this.hash)
    await this.mixHash(ciphertext)
    return plaintext
  }

  async split(): Promise<[CipherState, CipherState]> {
    const [first, second] = await hkdf(this.primitives, this.chainingKey, EMPTY, 2)
    return [new CipherState(first, this.primitives), new CipherState(second, this.primitives)]
  }
}

/**
 * One side of a handshake: the initiator writes the first message and reads the second, the
 * responder the other way round. Any failure ends it for good.
 */
export class Handshake {
  private readonly messages: Token[][]
  private readonly psk: Uint8Array | null
  private ephemeral: KeyPair | null = null
  private remoteEphemeral: Uint8Array | null = null
  private remoteStatic: Uint8Array | null
  private index = 0
  private failed = false
  private didSplit = false

  private constructor(
    private readonly options: HandshakeOptions,
    private readonly primitives: Primitives,
    private readonly symmetric: SymmetricState,
  ) {
    this.messages = PATTERNS[options.pattern]
    this.psk = options.psk ?? null
    this.remoteStatic = options.role === 'initiator' ? options.remoteStaticKey.slice() : null
  }

  static async create(options: HandshakeOptions): Promise<Handshake> {
    if (!Object.hasOwn(PATTERNS, options.pattern)) {
      throw new Error(`Unknown Noise pattern ${options.pattern}`)
    }
    const needsPsk = options.pattern === 'IKpsk1'
    if (needsPsk !== (options.psk !== undefined)) {
      throw new Error(`Noise ${options.pattern} ${needsPsk ? 'needs' : 'takes no'} pre-shared key`)
    }
    if (options.psk && options.psk.length !== 32) throw new Error('A pre-shared key is 32 bytes')
    if (options.staticKey.publicKey.length !== DHLEN) throw new Error('A public key is 32 bytes')
    if (options.role === 'initiator' && options.remoteStaticKey.length !== DHLEN) {
      throw new Error('A public key is 32 bytes')
    }
    // The handshake and its ciphers stay on the primitives it starts on, which made its keys.
    const primitives = currentPrimitives()
    for (const pair of [options.staticKey, options.ephemeral]) {
      if (pair && !primitives.isPrivateKey(pair.privateKey)) {
        throw new Error(`Noise key pair is not a ${primitives.name} key`)
      }
    }
    const symmetric = await SymmetricState.create(
      primitives,
      `Noise_${options.pattern}_25519_AESGCM_SHA256`,
    )
    await symmetric.mixHash(options.prologue ?? PROLOGUE)
    await symmetric.mixHash(
      options.role === 'initiator' ? options.remoteStaticKey : options.staticKey.publicKey,
    )
    return new Handshake(options, primitives, symmetric)
  }

  get finished(): boolean {
    return this.index === this.messages.length
  }

  /** The other side's static key: the responder's from the start, the initiator's once read. */
  get remoteStaticKey(): Uint8Array | null {
    return this.remoteStatic
  }

  /** Noise's `GetHandshakeHash()`, which both sides share once the handshake is finished. */
  get handshakeHash(): Uint8Array {
    if (!this.finished) throw new Error('Noise handshake is not finished')
    return this.symmetric.handshakeHash
  }

  writeMessage(payload: Uint8Array = EMPTY): Promise<Uint8Array> {
    return this.step(true, async () => {
      const parts: Uint8Array[] = []
      for (const token of this.messages[this.index]) {
        if (token === 'e') {
          this.ephemeral = this.options.ephemeral ?? (await this.primitives.generateKeyPair(false))
          parts.push(this.ephemeral.publicKey)
          await this.mixEphemeral(this.ephemeral.publicKey)
        } else if (token === 's') {
          parts.push(await this.symmetric.encryptAndHash(this.options.staticKey.publicKey))
        } else {
          await this.mixToken(token)
        }
      }
      parts.push(await this.symmetric.encryptAndHash(payload))
      const message = concat(...parts)
      if (message.length > MAX_NOISE_MESSAGE) throw new Error('Noise message is too long')
      return message
    })
  }

  readMessage(message: Uint8Array): Promise<Uint8Array> {
    return this.step(false, async () => {
      if (message.length > MAX_NOISE_MESSAGE) throw new Error('Noise message is too long')
      let offset = 0
      const take = (length: number): Uint8Array => {
        if (offset + length > message.length) throw new Error('Noise message is too short')
        offset += length
        return message.slice(offset - length, offset)
      }
      for (const token of this.messages[this.index]) {
        if (token === 'e') {
          this.remoteEphemeral = take(DHLEN)
          await this.mixEphemeral(this.remoteEphemeral)
        } else if (token === 's') {
          const length = this.symmetric.hasKey ? DHLEN + TAGLEN : DHLEN
          const remoteStatic = await this.symmetric.decryptAndHash(take(length))
          if (this.options.role === 'responder' && !(await this.options.accept(remoteStatic))) {
            throw new Error('Noise static key was refused')
          }
          this.remoteStatic = remoteStatic
        } else {
          await this.mixToken(token)
        }
      }
      return this.symmetric.decryptAndHash(message.subarray(offset))
    })
  }

  /** Noise's `Split()`, once, after the last message: a second pair would reuse every nonce. */
  async split(): Promise<TransportCiphers> {
    if (!this.finished || this.failed) throw new Error('Noise handshake is not finished')
    if (this.didSplit) throw new Error('Noise handshake is already split')
    this.didSplit = true
    const [initiatorToResponder, responderToInitiator] = await this.symmetric.split()
    return this.options.role === 'initiator'
      ? { send: initiatorToResponder, receive: responderToInitiator }
      : { send: responderToInitiator, receive: initiatorToResponder }
  }

  private async step(writing: boolean, run: () => Promise<Uint8Array>): Promise<Uint8Array> {
    if (this.failed) throw new Error('Noise handshake has failed')
    if (this.finished) throw new Error('Noise handshake is finished')
    const initiatorTurn = this.index % 2 === 0
    if (writing !== (initiatorTurn === (this.options.role === 'initiator'))) {
      throw new Error(`Noise handshake is waiting to ${writing ? 'read' : 'write'} a message`)
    }
    // Mark the handshake failed until the step completes, so a call made meanwhile is refused too.
    this.failed = true
    const out = await run()
    this.failed = false
    this.index++
    return out
  }

  private async mixEphemeral(publicKey: Uint8Array): Promise<void> {
    await this.symmetric.mixHash(publicKey)
    if (this.psk) await this.symmetric.mixKey(publicKey)
  }

  private async mixToken(token: Exclude<Token, 'e' | 's'>): Promise<void> {
    if (token === 'psk') return this.symmetric.mixKeyAndHash(this.psk!)
    // A DH token names the initiator's key first and the responder's second.
    const initiator = this.options.role === 'initiator'
    const [mine, theirs] = initiator ? [token[0], token[1]] : [token[1], token[0]]
    const local = mine === 'e' ? this.ephemeral : this.options.staticKey
    const remote = theirs === 'e' ? this.remoteEphemeral : this.remoteStatic
    if (!local || !remote) throw new Error(`Noise token ${token} is missing a key`)
    await this.symmetric.mixKey(await dh(this.primitives, local.privateKey, remote))
  }
}
