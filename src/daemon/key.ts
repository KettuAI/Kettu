// The data folder and the host's identity. A service that starts with the computer cannot count
// on an unlocked keychain, and servers often have none, so the private key is kept as the desktop
// app keeps it without the system's encryption: in a file only the user can read, 0600 in a 0700
// folder.

import { chmod, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { loadIdentity, type IdentityCipher, type RemoteIdentity } from '../main/remote-identity'
import { keyPath } from './paths'

const PRIVATE_FOLDER = 0o700
const PRIVATE_FILE = 0o600

/** Creates a folder, or narrows an existing one, so only the user can open it. */
async function privateFolder(folder: string): Promise<void> {
  await mkdir(folder, { recursive: true, mode: PRIVATE_FOLDER })
  if (((await stat(folder)).mode & 0o777) !== PRIVATE_FOLDER) await chmod(folder, PRIVATE_FOLDER)
}

/** Creates the data folder, or narrows an existing one, so only the user can open it. */
export function prepareDataFolder(data: string): Promise<void> {
  return privateFolder(data)
}

const NO_SYSTEM_ENCRYPTION: IdentityCipher = {
  available: async () => false,
  encrypt: () => Promise.reject(new Error('The daemon keeps its key without system encryption')),
  // A key the desktop app encrypted, in a data folder copied from it.
  decrypt: () =>
    Promise.reject(
      new Error("The host's key is encrypted by the system; the daemon cannot read it"),
    ),
  plainText: () => true,
}

/** The host's identity, made on first start and kept in the data folder from then on. */
export async function loadHostKey(
  data: string,
  warn: (message: string) => void,
): Promise<RemoteIdentity> {
  const file = keyPath(data)
  await privateFolder(path.dirname(file))
  const identity = await loadIdentity(data, NO_SYSTEM_ENCRYPTION)
  if ((await keyIsPrivate(file)) === false) {
    await chmod(file, PRIVATE_FILE)
    warn(`Others could read ${file}; it is readable only by you again`)
  }
  return identity
}

/** Whether only the user can read the key file, for `kettu status`; null when it is missing. */
export async function keyIsPrivate(file: string): Promise<boolean | null> {
  try {
    return ((await stat(file)).mode & 0o077) === 0
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
