// Release places for tests: keys that sign as the release workflow does, and a fetch that serves
// releases laid out as GitHub's from memory.

import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'

export interface TestKey {
  privateKey: KeyObject
  /** The public key as update-keys.json holds one: raw, in base64. */
  raw: string
}

export function keyPair(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const { x } = publicKey.export({ format: 'jwk' })
  return { privateKey, raw: Buffer.from(x!, 'base64url').toString('base64') }
}

/** A `<file>.sig` as the release workflow writes it: the signature of the name, a newline and the file. */
export function signatureOf(name: string, body: string, key: KeyObject): string {
  const message = Buffer.concat([Buffer.from(`${name}\n`), Buffer.from(body)])
  return `${sign(null, message, key).toString('base64')}\n`
}

/** The files of one release by `<version>/<name>`, each with its signature, as the workflow uploads them. */
export function signedFiles(
  version: string,
  files: Record<string, string>,
  key: KeyObject,
): Record<string, string> {
  const served: Record<string, string> = {}
  for (const [name, body] of Object.entries(files)) {
    served[`${version}/${name}`] = body
    served[`${version}/${name}.sig`] = signatureOf(name, body, key)
  }
  return served
}

export interface TestPlace {
  /** The version its latest release redirect names. */
  latest: string
  /** What it serves under `download/v<version>/`, by `<version>/<name>`. */
  files: Record<string, string>
}

/**
 * A fetch that answers as the releases of each place in `places` do, keyed by base URL; a place
 * not listed does not answer. `requests` holds every URL asked for, in order.
 */
export function releasesFetch(places: Record<string, TestPlace>): {
  fetch: typeof fetch
  requests: string[]
} {
  const requests: string[] = []
  const served = (async (input: string | URL | Request) => {
    const url = String(input)
    requests.push(url)
    for (const [base, place] of Object.entries(places)) {
      if (url === `${base}/latest`) {
        return new Response(null, {
          status: 302,
          headers: { location: `${base}/tag/v${place.latest}` },
        })
      }
      const prefix = `${base}/download/v`
      if (url.startsWith(prefix)) {
        const body = place.files[url.slice(prefix.length)]
        return body === undefined ? new Response('not found', { status: 404 }) : new Response(body)
      }
    }
    throw new TypeError('fetch failed')
  }) as typeof fetch
  return { fetch: served, requests }
}
