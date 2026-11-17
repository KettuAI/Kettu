import type { HarnessId } from '@shared/thread'
import { readClineUsage } from './cline'
import { readCursorUsage } from './cursor'
import { readDevinUsage } from './devin'
import { readFactoryLimits } from './droid'
import { readKimiCodeUsage } from './kimi-code'
import { readMiniMaxCodeUsage } from './minimax-code'
import type { StoredSignInReader } from './stored-sign-in'

/**
 * The harnesses whose plan limits are read with their own stored sign-in, each open from the
 * harness version whose sign-in place and vendor request it was written for.
 */
const READERS: Partial<Record<HarnessId, StoredSignInReader>> = {
  kimi: { version: '2.6.2', read: readKimiCodeUsage },
  minimax: { version: '0.7.0', read: readMiniMaxCodeUsage },
  droid: { version: '0.251.0', read: readFactoryLimits },
  cline: { version: '3.0.74', read: readClineUsage },
  devin: { version: '3000.11.228', read: readDevinUsage },
  // Its version carries the build, which semver would read as a prerelease of 2026.10.22.
  cursor: { version: '2026.10.22-27dcf5f', read: readCursorUsage },
}

export function storedSignInReader(harness: HarnessId): StoredSignInReader | null {
  return READERS[harness] ?? null
}
