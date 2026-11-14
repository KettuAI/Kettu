// The password a Chromium browser on macOS keeps its cookies' key under, the keychain item
// "<Browser> Safe Storage". macOS asks the user before handing it out; the answer is all Kettu
// learns of a refusal.

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'

export type KeyAnswer = { ok: true; password: string } | { ok: false; reason: 'denied' | 'missing' }

/** Reads a Safe Storage password; aborting it stops the wait for the user's answer. */
export type KeySource = (service: string, signal: AbortSignal) => Promise<KeyAnswer>

const SECURITY = '/usr/bin/security'
// errSecItemNotFound, as the security tool exits with it.
const ITEM_NOT_FOUND = 44
const MAX_PASSWORD_BYTES = 1024

/**
 * Through the system's `security` tool, which shows the system's own prompt. The password is read
 * from its output and never written anywhere.
 */
export const keychainKeySource: KeySource = (service, signal) =>
  new Promise((resolve, reject) => {
    execFile(
      SECURITY,
      ['find-generic-password', '-w', '-s', service],
      { signal, encoding: 'utf8', maxBuffer: MAX_PASSWORD_BYTES, windowsHide: true },
      (error, stdout) => {
        if (signal.aborted) {
          reject(new Error('cancelled'))
          return
        }
        if (!error) {
          const password = stdout.replace(/\r?\n$/, '')
          resolve(password ? { ok: true, password } : { ok: false, reason: 'missing' })
          return
        }
        const code = (error as NodeJS.ErrnoException & { code?: unknown }).code
        if (typeof code === 'string') {
          reject(new Error(`Could not run the security tool: ${code}`))
          return
        }
        // Deny, a wrong password and a closed prompt all end in an error of their own.
        resolve({ ok: false, reason: code === ITEM_NOT_FOUND ? 'missing' : 'denied' })
      },
    )
  })

/**
 * For development only: the passwords in a JSON file by service, so a throwaway profile made with
 * Chrome's mock keychain can be read without the real keychain. A service set to null is denied.
 */
export function fileKeySource(path: string): KeySource {
  return async (service) => {
    const passwords = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    const password = passwords[service]
    if (typeof password === 'string') return { ok: true, password }
    return { ok: false, reason: password === null ? 'denied' : 'missing' }
  }
}
