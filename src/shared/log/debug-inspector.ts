// The Node.js side of debug mode: a process's inspector, which hosts open when their parent asks,
// and the ports file a debug run keeps in its log folder.

import inspector from 'node:inspector'
import { rmSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { DEBUG_HOST, type DebugStatus } from '../debug'
import { writeLog } from './process-log'

/** Set by a parent in a debug run, so the host it forks opens its inspector. */
export const INSPECT_ENV = 'KETTU_INSPECT'

/** A host tells its parent where its inspector listens. */
export interface InspectorMessage {
  type: 'debug:inspector'
  url: string
}

export function isInspectorMessage(message: unknown): message is InspectorMessage {
  if (typeof message !== 'object' || message === null) return false
  const { type, url } = message as Record<string, unknown>
  return type === 'debug:inspector' && typeof url === 'string'
}

/**
 * Opens this process's Node.js inspector on 127.0.0.1, at a port the system picks, and returns
 * its `ws://` address. It works with Electron's `--inspect` fuse off, which only stops the flags.
 */
export function openInspector(): string {
  inspector.open(0, DEBUG_HOST, false)
  const url = inspector.url()
  if (!url) throw new Error('The inspector did not open')
  return url
}

/** In a forked host: opens the inspector when the parent asked, and tells the parent where. */
export function startHostInspector(): void {
  const asked = process.env[INSPECT_ENV] === '1'
  // Agents and shells get this process's environment; this is not theirs.
  delete process.env[INSPECT_ENV]
  if (!asked) return
  let url: string
  try {
    url = openInspector()
  } catch (error) {
    writeLog('error', 'debug', `Could not open the inspector: ${(error as Error).message}`)
    return
  }
  writeLog('info', 'debug', `Inspector listening on ${url}`)
  const message: InspectorMessage = { type: 'debug:inspector', url }
  const port = (process as { parentPort?: { postMessage(message: unknown): void } }).parentPort
  if (port) port.postMessage(message)
  else if (process.send) process.send(message)
}

/**
 * A debug run's ports, written to `file` whenever one changes and removed when the run ends, so
 * the file never names a port that no longer listens; without a file they are only kept here.
 */
export class DebugPortsFile {
  private readonly inspectors = new Map<string, string>()
  private cdp: DebugStatus['cdp'] = null
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly file: string | null,
    private readonly options: { cdp: boolean; changed?(status: DebugStatus): void },
  ) {
    if (file === null) return
    // Synchronous at exit only: nothing runs after it.
    process.once('exit', () => {
      try {
        rmSync(file, { force: true })
      } catch {
        // A file left behind is removed by the next run.
      }
    })
  }

  status(): DebugStatus {
    return {
      on: true,
      cdp: this.cdp,
      inspectors: [...this.inspectors].map(([name, url]) => ({ name, url })),
      file: this.file,
    }
  }

  setCdp(cdp: DebugStatus['cdp']): void {
    this.cdp = cdp
    this.save()
  }

  /** A process's inspector, or null once the process is gone. */
  setInspector(name: string, url: string | null): void {
    if (url === null) this.inspectors.delete(name)
    else this.inspectors.set(name, url)
    this.save()
  }

  private save(): void {
    const status = this.status()
    this.options.changed?.(status)
    const file = this.file
    if (file === null) return
    const contents = {
      // Scripts connect to a port, so anything else is none.
      ...(this.options.cdp ? { cdp: typeof status.cdp === 'number' ? status.cdp : null } : {}),
      inspectors: Object.fromEntries(this.inspectors),
    }
    this.writing = this.writing
      .then(() => writeFile(file, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 }))
      .catch((error: unknown) => {
        writeLog('warn', 'debug', `Could not write the ports file: ${(error as Error).message}`)
      })
  }
}

/** Removes a ports file a debug run left, as a run that ended without its exit handler does. */
export async function removePortsFile(file: string): Promise<void> {
  await rm(file, { force: true }).catch(() => undefined)
}
