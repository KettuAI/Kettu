import { generateKeyPairSync, sign } from 'node:crypto'
import type { SignedManifest } from '../harness-manifest'

/** A throwaway manifest key: its public half as the app keeps one, and a signer with it. */
export function manifestSigner(): { key: string; sign(document: unknown): SignedManifest } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const x = publicKey.export({ format: 'jwk' }).x ?? ''
  return {
    key: Buffer.from(x, 'base64url').toString('base64'),
    sign: (document) => {
      const payload = Buffer.from(JSON.stringify(document), 'utf8')
      return {
        payload: payload.toString('base64url'),
        signature: sign(null, payload, privateKey).toString('base64url'),
      }
    },
  }
}

/** A manifest document at `sequence` with these harnesses. */
export function manifestDocument(
  sequence: number,
  harnesses: Record<string, unknown[]>,
): Record<string, unknown> {
  return { sequence, updatedAt: '2026-11-17T08:00:00Z', harnesses }
}
