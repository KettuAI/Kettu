// The channel's primitives on the noble libraries, for a page without `crypto.subtle`, from only
// the subpaths they need so the bundle stays small. primitives.ts loads it with import() there.

import { gcm } from '@noble/ciphers/aes.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import type { KeyPair, Primitives, PrivateKey, RawPrivateKey } from './primitives'

function isRawPrivateKey(key: PrivateKey): key is RawPrivateKey {
  return 'x25519' in key && key.x25519 instanceof Uint8Array && key.x25519.length === 32
}

// A noble key is its raw bytes, never non-extractable; an extractable key means a WebCrypto one.
function keyPair(privateKey: Uint8Array, extractable: boolean): KeyPair {
  if (extractable) throw new Error('Only WebCrypto makes an extractable key')
  return { privateKey: { x25519: privateKey }, publicKey: x25519.getPublicKey(privateKey) }
}

export const noblePrimitives: Primitives = {
  name: 'noble',
  sha256: async (data) => sha256(data),
  hmacSha256: async (key, data) => hmac(sha256, key, data),
  aesGcm: async (key) => {
    const raw = key.slice()
    return {
      seal: async (nonce, plaintext, ad) => gcm(raw, nonce, ad).encrypt(plaintext),
      open: async (nonce, ciphertext, ad) => gcm(raw, nonce, ad).decrypt(ciphertext),
    }
  },
  generateKeyPair: async (extractable) => keyPair(x25519.utils.randomSecretKey(), extractable),
  importKeyPair: async (privateKey, extractable) => keyPair(privateKey.slice(), extractable),
  isPrivateKey: isRawPrivateKey,
  dh: async (privateKey, publicKey) => {
    if (!isRawPrivateKey(privateKey)) throw new Error('The private key is not a noble key')
    return x25519.getSharedSecret(privateKey.x25519, publicKey)
  },
}
