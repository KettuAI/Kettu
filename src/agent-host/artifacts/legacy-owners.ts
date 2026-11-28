// Reliable legacy artifact ownership from `published-artifacts.json`: older versions kept no
// `owner_account_id` in `threads.db`, so Kettu publish records are the only trustworthy record of
// which Kettu account owns an existing artifact. Purely local artifacts without a Kettu publish
// record stay unowned (`null`) and are never claimed automatically.

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { ARTIFACT_ID } from '@shared/artifacts'

const KETTU_ACCOUNT = /^[A-Za-z0-9-]{1,64}$/

export interface LegacyArtifactOwner {
  id: string
  accountId: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Extracts reliable `(artifactId, accountId)` ownership pairs from a parsed
 * `published-artifacts.json` payload. Only v2/v3 Kettu publish records carry a verified Kettu
 * account id; Cloudflare records and invalid entries are ignored.
 */
export function parseLegacyKettuOwners(raw: unknown): LegacyArtifactOwner[] {
  if (!isRecord(raw) || (raw.version !== 2 && raw.version !== 3) || !Array.isArray(raw.published)) {
    return []
  }
  const seen = new Set<string>()
  const owners: LegacyArtifactOwner[] = []
  for (const entry of raw.published) {
    if (!isRecord(entry) || entry.target !== 'kettu') continue
    const { id, accountId } = entry
    if (typeof id !== 'string' || !ARTIFACT_ID.test(id) || seen.has(id)) continue
    if (typeof accountId !== 'string' || !KETTU_ACCOUNT.test(accountId)) continue
    seen.add(id)
    owners.push({ id, accountId })
  }
  return owners
}

/**
 * Reads reliable legacy Kettu artifact ownership from `<userDataPath>/published-artifacts.json`
 * without modifying or quarantining the file. Returns an empty list when absent or unreadable.
 */
export async function readLegacyKettuOwners(userDataPath: string): Promise<LegacyArtifactOwner[]> {
  try {
    const text = await readFile(path.join(userDataPath, 'published-artifacts.json'), 'utf8')
    return parseLegacyKettuOwners(JSON.parse(text))
  } catch {
    return []
  }
}
