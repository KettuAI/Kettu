// How the window names a folder on another host: the host's id and the path as that host writes
// it, in one string no folder on this computer can have. A project's path is its key everywhere in
// the window, so two hosts' folders of the same path never meet, and a request finds its host by it.

const PREFIX = 'kettu-host:'
const QUALIFIED = /^kettu-host:([0-9a-f]{32}):([\s\S]*)$/

/** The window's name for `path` on the host `hostId`; this computer's paths stay as they are. */
export function onHost(hostId: string | null, path: string): string {
  return hostId === null ? path : `${PREFIX}${hostId}:${path}`
}

/** The host a path the window names is on, or null for this computer. */
export function hostOfPath(path: string): string | null {
  return path.startsWith(PREFIX) ? (QUALIFIED.exec(path)?.[1] ?? null) : null
}

/** The path as its host writes it, for showing and for the host's own requests. */
export function hostPath(path: string): string {
  return path.startsWith(PREFIX) ? (QUALIFIED.exec(path)?.[2] ?? path) : path
}
