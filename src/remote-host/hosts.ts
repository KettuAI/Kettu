// `remote/hosts.json`: the other hosts this computer was added to as a device, which the remote
// host owns. Pairing adds one, each welcome and addresses message updates it, and the owner may
// edit its addresses here or forget it.

import path from 'node:path'
import { addressKey } from '@shared/remote/address'
import { deviceId } from '@shared/remote/device'
import {
  HOSTS_FILE,
  MAX_HOST_ADDRESSES,
  parseKnownHost,
  type KnownHost,
} from '@shared/remote/hosts'
import type { DirectAddress } from '@shared/remote/protocol'
import { JsonFile, type LogFn, type Migration } from '../agent-host/storage'
import { publicKeyBytes } from './devices'

const HOSTS_VERSION = 1
const HOSTS_MIGRATIONS: Readonly<Record<number, Migration>> = {}
const MAX_HOSTS = 100

interface HostsFile {
  version: 1
  hosts: KnownHost[]
}

function parseHostsFile(data: Record<string, unknown>): HostsFile | string {
  if (!Array.isArray(data.hosts) || data.hosts.length > MAX_HOSTS) return 'hosts is not a list'
  const hosts: KnownHost[] = []
  for (const [index, item] of data.hosts.entries()) {
    const host = parseKnownHost(item)
    if (!host || !publicKeyBytes(host.publicKey)) return `host ${index} is malformed`
    hosts.push(host)
  }
  return { version: 1, hosts }
}

/** One entry per address, in order, at most as many as are kept. */
export function uniqueAddresses(addresses: DirectAddress[]): DirectAddress[] {
  const seen = new Set<string>()
  const kept: DirectAddress[] = []
  for (const { host, port } of addresses) {
    const key = addressKey({ host, port })
    if (seen.has(key)) continue
    seen.add(key)
    kept.push({ host, port })
    if (kept.length === MAX_HOST_ADDRESSES) break
  }
  return kept
}

export class HostStore {
  private readonly byId = new Map<string, KnownHost>()

  private constructor(
    private readonly file: JsonFile<HostsFile>,
    hosts: KnownHost[],
    private readonly now: () => number,
  ) {
    for (const host of hosts) this.byId.set(host.id, host)
  }

  static async load(userDataPath: string, log: LogFn, now = Date.now): Promise<HostStore> {
    const file = new JsonFile<HostsFile>({
      file: path.join(userDataPath, ...HOSTS_FILE),
      version: HOSTS_VERSION,
      migrations: HOSTS_MIGRATIONS,
      parse: parseHostsFile,
      empty: () => ({ version: 1, hosts: [] }),
      log,
    })
    const { hosts } = await file.load()
    // An id is derived from the key; an entry whose id is not is dropped rather than trusted.
    const checked = await Promise.all(
      hosts.map(async (host) =>
        (await deviceId(publicKeyBytes(host.publicKey)!)) === host.id ? host : null,
      ),
    )
    const kept = checked.filter((host): host is KnownHost => host !== null)
    if (kept.length !== hosts.length) log('warn', 'Dropped hosts whose id is not their key')
    const store = new HostStore(file, kept, now)
    if (kept.length !== hosts.length) store.save()
    return store
  }

  list(): KnownHost[] {
    return [...this.byId.values()]
  }

  get(id: string): KnownHost | null {
    return this.byId.get(id) ?? null
  }

  /**
   * Keeps a host that just welcomed this computer from a pairing, replacing the entry of the same
   * key; null when there is no room for another.
   */
  async add(
    host: Omit<KnownHost, 'id' | 'addedAt' | 'lastOnlineAt' | 'removed'>,
  ): Promise<KnownHost | null> {
    const key = publicKeyBytes(host.publicKey)
    if (!key) return null
    const id = await deviceId(key)
    if (!this.byId.has(id) && this.byId.size >= MAX_HOSTS) return null
    const now = this.now()
    const added: KnownHost = {
      ...host,
      id,
      addresses: uniqueAddresses(host.addresses),
      addedAt: now,
      lastOnlineAt: now,
      removed: false,
    }
    const checked = parseKnownHost(added)
    if (!checked) return null
    this.byId.set(id, checked)
    this.save()
    await this.file.flush()
    return checked
  }

  /** Changes what a host's welcome or messages said; null when it is not known. */
  update(id: string, change: Partial<Omit<KnownHost, 'id' | 'publicKey'>>): KnownHost | null {
    const host = this.byId.get(id)
    if (!host) return null
    const next = parseKnownHost({
      ...host,
      ...change,
      ...(change.addresses ? { addresses: uniqueAddresses(change.addresses) } : {}),
    })
    if (!next) return null
    this.byId.set(id, next)
    this.save()
    return next
  }

  /** Notes a connection opening or ending now. */
  online(id: string): void {
    this.update(id, { lastOnlineAt: this.now() })
  }

  async remove(id: string): Promise<boolean> {
    if (!this.byId.delete(id)) return false
    this.save()
    await this.file.flush()
    return true
  }

  flush(): Promise<void> {
    return this.file.flush()
  }

  private save(): void {
    this.file.save({ version: 1, hosts: this.list() })
  }
}
