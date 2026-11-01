// `remote/ssh.json`: the port the daemon took channels from SSH on, on 127.0.0.1, so it takes the
// same one when it starts again and the computers that added it over SSH find it at once.

import path from 'node:path'
import { isPort } from '@shared/remote/address'
import { readJsonFile, writeFileAtomic } from '../main/json-file'

export function sshPortPath(data: string): string {
  return path.join(data, 'remote', 'ssh.json')
}

/** The kept port, or null when there is none or the file is not one of ours. */
export async function readSshPort(data: string): Promise<number | null> {
  const read = await readJsonFile(sshPortPath(data))
  if (read.kind !== 'ok' || typeof read.value !== 'object' || read.value === null) return null
  const { port } = read.value as { port?: unknown }
  return isPort(port) ? port : null
}

export function writeSshPort(data: string, port: number): Promise<void> {
  return writeFileAtomic(sshPortPath(data), `${JSON.stringify({ version: 1, port })}\n`, 0o600)
}
