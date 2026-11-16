import type { HarnessId } from '@shared/thread'
import { readClineUsage } from './cline'
import { readDevinUsage } from './devin'
import { readFactoryLimits } from './droid'
import { readKimiCodeUsage } from './kimi-code'
import { readMiniMaxCodeUsage } from './minimax-code'
import type { StoredSignInReader } from './stored-sign-in'

/**
 * The harnesses whose plan limits are read with their own stored sign-in, each open at the harness
 * version whose sign-in place and vendor request it was written for.
 */
const READERS: Partial<Record<HarnessId, StoredSignInReader>> = {
  kimi: { version: '2.6.2', read: readKimiCodeUsage },
  minimax: { version: '0.7.0', through: '0.7.7', read: readMiniMaxCodeUsage },
  droid: { version: '0.251.0', read: readFactoryLimits },
  cline: { version: '3.0.74', read: readClineUsage },
  // Devin runs the user's own program, which updates itself.
  devin: { version: '3000.11.228', orLater: true, read: readDevinUsage },
}

export function storedSignInReader(harness: HarnessId): StoredSignInReader | null {
  return READERS[harness] ?? null
}
