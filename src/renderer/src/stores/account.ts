import { create } from 'zustand'
import type { AccountStatus } from '@shared/account'

interface AccountStore {
  /** What main has; null until the first read. */
  status: AccountStatus | null
}

export const useAccountStore = create<AccountStore>()(() => ({ status: null }))

async function take(call: () => Promise<AccountStatus>, what: string): Promise<void> {
  try {
    useAccountStore.setState({ status: await call() })
  } catch (error) {
    console.error(`Could not ${what}`, error)
  }
}

/**
 * Reads the status and follows main's changes, then reads the account from the service, at start
 * and whenever the window comes back, so the sidebar's row stays current without Settings open.
 * Called once at bootstrap.
 */
export async function initAccount(): Promise<void> {
  window.kettu.account.onChanged((status) => useAccountStore.setState({ status }))
  window.addEventListener('focus', () => void checkAccount())
  await take(() => window.kettu.account.status(), 'read the account')
  await checkAccount()
}

/** Reads the account from the service again, as when Settings › Account shows. */
export function checkAccount(): Promise<void> {
  return take(() => window.kettu.account.check(), 'check the account')
}

export function signIn(): Promise<void> {
  return take(() => window.kettu.account.signIn(), 'start signing in')
}

export function cancelSignIn(): Promise<void> {
  return take(() => window.kettu.account.cancelSignIn(), 'cancel signing in')
}

export function signOut(): Promise<void> {
  return take(() => window.kettu.account.signOut(), 'sign out')
}
