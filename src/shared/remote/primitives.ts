// The cryptography the Noise channel runs on: WebCrypto by default, so Node.js, Electron and
// browsers run the same code, or the noble libraries on a page without `crypto.subtle`, which
// browsers give only to secure contexts and so not to a page served over plain http.

// Node.js's types declare WebCrypto's CryptoKey only as a value, the DOM's as a type too.
export type WebCryptoKey = InstanceType<typeof CryptoKey>

/** noble's X25519 private key: its 32 bytes, in a plain object that structured cloning keeps. */
export interface RawPrivateKey {
  readonly x25519: Uint8Array
}

/** A private key the primitives that made it take, and the others refuse. */
export type PrivateKey = WebCryptoKey | RawPrivateKey

export interface KeyPair<Private extends PrivateKey = PrivateKey> {
  /** An X25519 key: WebCrypto's for `deriveBits`, non-extractable unless asked for, or noble's. */
  privateKey: Private
  publicKey: Uint8Array
}

/** AES-256-GCM on one key, with a 12-byte nonce. */
export interface AesGcm {
  /** The ciphertext with its 16-byte tag. */
  seal(nonce: Uint8Array, plaintext: Uint8Array, ad: Uint8Array): Promise<Uint8Array>
  /** Rejects when the ciphertext, its tag or the associated data was changed. */
  open(nonce: Uint8Array, ciphertext: Uint8Array, ad: Uint8Array): Promise<Uint8Array>
}

export interface Primitives {
  /** Names the implementation in errors. */
  readonly name: string
  sha256(data: Uint8Array): Promise<Uint8Array>
  hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array>
  /** A cipher on the 32-byte `key`. */
  aesGcm(key: Uint8Array): Promise<AesGcm>
  /** An `extractable` key is a WebCrypto key that `crypto.subtle.exportKey` takes. */
  generateKeyPair(extractable: boolean): Promise<KeyPair>
  /** A key pair from the 32 raw bytes of an X25519 private key. */
  importKeyPair(privateKey: Uint8Array, extractable: boolean): Promise<KeyPair>
  /** Whether these primitives made the key. */
  isPrivateKey(key: PrivateKey): boolean
  /** X25519, which rejects a low-order public key, whose shared secret would be all zeros. */
  dh(privateKey: PrivateKey, publicKey: Uint8Array): Promise<Uint8Array>
}

// WebCrypto takes views of an ArrayBuffer and throws on a SharedArrayBuffer, which nothing passes.
const buffer = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => bytes as Uint8Array<ArrayBuffer>

// The X25519 base point: a private key's public key is its shared secret with this point, which
// works on a non-extractable key.
const BASE_POINT = new Uint8Array(32)
BASE_POINT[0] = 9

// An X25519 private key in PKCS #8 is this prefix and the 32 raw bytes (RFC 8410).
const PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
])

async function deriveBits(privateKey: PrivateKey, publicKey: Uint8Array): Promise<Uint8Array> {
  if (!(privateKey instanceof CryptoKey)) throw new Error('The private key is not a WebCrypto key')
  const remote = await crypto.subtle.importKey('raw', buffer(publicKey), 'X25519', true, [])
  const params = { name: 'X25519', public: remote }
  return new Uint8Array(await crypto.subtle.deriveBits(params, privateKey, 256))
}

function webCryptoAesGcm(key: WebCryptoKey): AesGcm {
  return {
    seal: async (nonce, plaintext, ad) => {
      const params = { name: 'AES-GCM', iv: buffer(nonce), additionalData: buffer(ad) }
      return new Uint8Array(await crypto.subtle.encrypt(params, key, buffer(plaintext)))
    },
    open: async (nonce, ciphertext, ad) => {
      const params = { name: 'AES-GCM', iv: buffer(nonce), additionalData: buffer(ad) }
      return new Uint8Array(await crypto.subtle.decrypt(params, key, buffer(ciphertext)))
    },
  }
}

export const webCryptoPrimitives: Primitives = {
  name: 'WebCrypto',
  sha256: async (data) => new Uint8Array(await crypto.subtle.digest('SHA-256', buffer(data))),
  hmacSha256: async (key, data) => {
    const hmacKey = await crypto.subtle.importKey(
      'raw',
      buffer(key),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    return new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, buffer(data)))
  },
  aesGcm: async (key) =>
    webCryptoAesGcm(
      await crypto.subtle.importKey('raw', buffer(key), 'AES-GCM', false, ['encrypt', 'decrypt']),
    ),
  generateKeyPair: async (extractable) => {
    const pair = await crypto.subtle.generateKey('X25519', extractable, ['deriveBits'])
    if (!('privateKey' in pair)) throw new Error('X25519 gave no key pair')
    const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
    return { privateKey: pair.privateKey, publicKey }
  },
  importKeyPair: async (privateKey, extractable) => {
    const pkcs8 = new Uint8Array(PKCS8_PREFIX.length + privateKey.length)
    pkcs8.set(PKCS8_PREFIX)
    pkcs8.set(privateKey, PKCS8_PREFIX.length)
    const key = await crypto.subtle.importKey('pkcs8', pkcs8, 'X25519', extractable, ['deriveBits'])
    return { privateKey: key, publicKey: await deriveBits(key, BASE_POINT) }
  },
  isPrivateKey: (key) => key instanceof CryptoKey,
  dh: deriveBits,
}

let current: Primitives = webCryptoPrimitives

/** The primitives a new handshake or cipher runs on. */
export function currentPrimitives(): Primitives {
  return current
}

/** Changes the primitives new handshakes and ciphers run on, as tests do. */
export function setPrimitives(primitives: Primitives): void {
  current = primitives
}

/**
 * Keeps WebCrypto where the platform has it and loads noble where it has no `crypto.subtle`, as on
 * a page served over plain http. A page calls it once, before it makes a key or a handshake.
 */
export async function loadPlatformPrimitives(): Promise<void> {
  if (globalThis.crypto?.subtle) return
  current = (await import('./noble-primitives')).noblePrimitives
}
