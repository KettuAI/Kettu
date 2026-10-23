// Artifact ids: `art_` and a ULID (https://github.com/ulid/spec), so they need no server and sort
// by creation time. Ten characters of milliseconds, then sixteen of 80 random bits.

import { randomBytes } from 'node:crypto'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function ulid(now: number = Date.now(), random: Uint8Array = randomBytes(10)): string {
  if (!Number.isSafeInteger(now) || now < 0 || now >= 2 ** 48) {
    throw new Error(`A ULID cannot hold the time ${now}`)
  }
  if (random.length !== 10) throw new Error('A ULID takes 10 random bytes')
  let time = ''
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32))
    time = CROCKFORD.charAt(t % 32) + time
  let bits = 0n
  for (const byte of random) bits = (bits << 8n) | BigInt(byte)
  let rest = ''
  for (let i = 0; i < 16; i++, bits >>= 5n) rest = CROCKFORD.charAt(Number(bits & 31n)) + rest
  return time + rest
}

export function newArtifactId(now?: number): string {
  return `art_${ulid(now)}`
}
