import type { HostEvent, HostMethod, HostParams, HostResult } from '@shared/agent-host'
import { ARTIFACT_ID, artifactRef } from '@shared/artifacts'
import { DEVICE_ID } from '@shared/remote/device'
import type {
  TerminalEvent,
  TerminalMethod,
  TerminalParams,
  TerminalResult,
} from '@shared/terminal-host'
import { hostOfPath, hostPath, onHost } from './host-paths'
import { i18n } from './i18n'
import { readJson, writeJson } from './storage'

// A request goes to the host its session or project is on: this computer's agent host, or another
// host's through main. What another host answers names its folders as the window does, so the
// stores never tell one host's sessions from another's but by their project's path.

/** The other host a session is on, learned from each summary that host sends. */
const sessionHosts = new Map<string, string>()

/** The other host an attachment was added on, for the requests that name it by id. */
const attachmentHosts = new Map<string, string>()

/** The other host a terminal runs on, learned from what that host says of it. */
const terminalHosts = new Map<string, string>()

const ARTIFACT_HOSTS_KEY = 'hosts.artifacts'

/** As many artifacts of other hosts as a window is likely to show again after a restart. */
const MAX_KEPT_ARTIFACTS = 2_000

/**
 * The other host an artifact is kept on, learned from that host's lists, events and sessions, and
 * kept in this computer's storage, so an artifact the window shows again after a restart is asked
 * of its own host before that host's lists are read.
 */
const artifactHosts = new Map<string, string>(keptArtifactHosts())

function keptArtifactHosts(): [string, string][] {
  const kept = readJson<unknown>(ARTIFACT_HOSTS_KEY, null)
  if (typeof kept !== 'object' || kept === null) return []
  return Object.entries(kept).filter(
    (entry): entry is [string, string] =>
      ARTIFACT_ID.test(entry[0]) && typeof entry[1] === 'string' && DEVICE_ID.test(entry[1]),
  )
}

let artifactHostsSave: ReturnType<typeof setTimeout> | null = null

function saveArtifactHosts(): void {
  artifactHostsSave ??= setTimeout(() => {
    artifactHostsSave = null
    writeJson(ARTIFACT_HOSTS_KEY, Object.fromEntries([...artifactHosts].slice(-MAX_KEPT_ARTIFACTS)))
  }, 2000)
}

/** The artifacts this computer keeps, which no other host may claim. */
const ownArtifacts = new Set<string>()

/** The other hosts that last heard which of their sessions the window shows. */
let showing = new Set<string>()

/** Deeper than any request, result or event nests. */
const MAX_DEPTH = 64

/** The other host the session is on, or null for this computer's and the unknown. */
export function sessionHost(sessionId: string): string | null {
  return sessionHosts.get(sessionId) ?? null
}

/** The other host an attachment was added on, or null for this computer's and the unknown. */
export function attachmentHost(id: string): string | null {
  return attachmentHosts.get(id) ?? null
}

/** Remembers the other host of an attachment a draft kept from an earlier run. */
export function learnAttachmentHost(id: string, hostId: string): void {
  attachmentHosts.set(id, hostId)
}

/** Remembers the other host of sessions the window kept from an earlier run. */
export function learnSessionHosts(hostId: string, sessionIds: readonly string[]): void {
  for (const sessionId of sessionIds) sessionHosts.set(sessionId, hostId)
}

/** Forgets a session the host removed. */
export function forgetSessionHost(sessionId: string): void {
  sessionHosts.delete(sessionId)
}

/** Forgets every session of a host this computer no longer connects to. */
export function forgetHostSessions(hostId: string): void {
  for (const [sessionId, on] of sessionHosts) if (on === hostId) sessionHosts.delete(sessionId)
  for (const [id, on] of terminalHosts) if (on === hostId) terminalHosts.delete(id)
  for (const [id, on] of artifactHosts) {
    if (on === hostId && artifactHosts.delete(id)) saveArtifactHosts()
  }
  showing.delete(hostId)
}

/** The other host a terminal runs on, or null for this computer's and the unknown. */
export function terminalHost(id: string): string | null {
  return terminalHosts.get(id) ?? null
}

/** The other host an artifact is kept on, or null for this computer's and the unknown. */
export function artifactHost(id: string): string | null {
  return artifactHosts.get(id) ?? null
}

/**
 * Remembers where an artifact is kept: on this computer when `hostId` is null. An id this computer
 * keeps stays its own whatever another host says, so no host draws its requests to itself.
 */
export function learnArtifactHost(id: string, hostId: string | null): void {
  if (hostId === null) {
    ownArtifacts.add(id)
    if (artifactHosts.delete(id)) saveArtifactHosts()
  } else if (!ownArtifacts.has(id) && artifactHosts.get(id) !== hostId) {
    artifactHosts.set(id, hostId)
    saveArtifactHosts()
  }
}

/** How main names the artifact: its id, with its host before it when another host keeps it. */
export function artifactRefOf(id: string): string {
  return artifactRef(artifactHost(id), id)
}

/** The host a request is for: its artifact's, its session's, its project's, or this computer. */
export function routeOf(method: string, params: unknown): string | null {
  if (typeof params !== 'object' || params === null) return null
  const fields = params as Record<string, unknown>
  if (method.startsWith('artifacts.')) {
    const id = typeof fields.id === 'string' ? fields.id : fields.artifactId
    if (typeof id === 'string') return artifactHost(id)
  }
  if (typeof fields.sessionId === 'string') return sessionHost(fields.sessionId)
  if (method.startsWith('attachments.') && typeof fields.id === 'string') {
    return attachmentHosts.get(fields.id) ?? null
  }
  if (typeof fields.parentId === 'string' && sessionHost(fields.parentId) !== null) {
    return sessionHost(fields.parentId)
  }
  if (typeof fields.projectPath === 'string') return hostOfPath(fields.projectPath)
  if (method.startsWith('projects.') && typeof fields.path === 'string') {
    return hostOfPath(fields.path)
  }
  const source = fields.source as Record<string, unknown> | undefined
  if (typeof source?.projectPath === 'string') return hostOfPath(source.projectPath)
  return null
}

/** A request to one host's agent host: `host` routes each to its own, `hostAt` names one. */
export type HostRequest = <M extends HostMethod>(
  method: M,
  params: HostParams<M>,
) => Promise<HostResult<M>>

export function host<M extends HostMethod>(
  method: M,
  params: HostParams<M>,
): Promise<HostResult<M>> {
  if (method === 'sessions.show') {
    return showOnHosts((params as HostParams<'sessions.show'>).sessionIds) as Promise<HostResult<M>>
  }
  return hostAt(routeOf(method, params), method, params)
}

/** A request to the host named, null being this computer. */
export function hostAt<M extends HostMethod>(
  hostId: string | null,
  method: M,
  params: HostParams<M>,
): Promise<HostResult<M>> {
  if (hostId === null) return window.kettu.agents.request(method, params)
  return window.kettu.hosts
    .request(hostId, method, toHost(method, params, 0))
    .then((result) => fromHost(hostId, method, result) as HostResult<M>)
}

/** Each host hears which of its sessions the window shows, a host that showed some none now. */
async function showOnHosts(sessionIds: string[]): Promise<void> {
  const byHost = new Map<string | null, string[]>([[null, []]])
  for (const hostId of showing) byHost.set(hostId, [])
  for (const sessionId of sessionIds) {
    const hostId = sessionHost(sessionId)
    byHost.set(hostId, [...(byHost.get(hostId) ?? []), sessionId])
  }
  showing = new Set(
    [...byHost].filter(([id, ids]) => id !== null && ids.length > 0).map(([id]) => id!),
  )
  const local = window.kettu.agents.request('sessions.show', { sessionIds: byHost.get(null)! })
  for (const [hostId, ids] of byHost) {
    if (hostId !== null) void hostAt(hostId, 'sessions.show', { sessionIds: ids }).catch(() => {})
  }
  await local
}

/** `params` as the host writes its paths: a copy, with each folder of the window's unqualified. */
export function toHost(method: string, params: unknown, depth: number): unknown {
  if (typeof params !== 'object' || params === null || depth >= MAX_DEPTH) return params
  if (params instanceof ArrayBuffer || ArrayBuffer.isView(params)) return params
  if (Array.isArray(params)) return params.map((item) => toHost(method, item, depth + 1))
  const copy: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    copy[key] =
      typeof value === 'string' &&
      (key === 'projectPath' || (key === 'path' && isProjectCall(method)))
        ? hostPath(value)
        : toHost(method, value, depth + 1)
  }
  return copy
}

function isProjectCall(method: string): boolean {
  return method === 'projects.add' || method === 'projects.remove' || method === 'projects.touch'
}

/** A host's result as the window names folders, with the sessions it lists learned. */
export function fromHost(hostId: string, method: string, result: unknown): unknown {
  if (method === 'projects.list' || method === 'projects.add') qualifyProjects(hostId, result)
  if (method === 'artifacts.list') qualifyArtifacts(hostId, result)
  const added = (result as { id?: unknown } | null)?.id
  if (method === 'attachments.add' && typeof added === 'string') attachmentHosts.set(added, hostId)
  qualify(hostId, result, 0)
  return result
}

/** A host's event as the window names folders, with the sessions it names learned. */
export function fromHostEvent(hostId: string, event: HostEvent): HostEvent {
  if (event.type === 'projects.changed') qualifyProjects(hostId, event.projects)
  if (event.type === 'session.patches') sessionHosts.set(event.batch.sessionId, hostId)
  if (event.type.startsWith('artifacts.')) {
    const { id, artifactId } = event as { id?: unknown; artifactId?: unknown }
    const named = typeof id === 'string' ? id : artifactId
    if (typeof named === 'string') learnArtifactHost(named, hostId)
  }
  qualify(hostId, event, 0)
  return event
}

/** A host's artifacts as the window names their projects, each learned as that host's. */
function qualifyArtifacts(hostId: string, value: unknown): void {
  for (const artifact of Array.isArray(value) ? value : []) {
    const record = artifact as { id?: unknown; project?: unknown } | null
    if (typeof record?.id !== 'string') continue
    learnArtifactHost(record.id, hostId)
    if (typeof record.project === 'string' && hostOfPath(record.project) === null) {
      record.project = onHost(hostId, record.project)
    }
  }
}

function qualifyProjects(hostId: string, value: unknown): void {
  const list = Array.isArray(value) ? value : [value]
  for (const project of list) {
    const record = project as { path?: unknown } | null
    if (typeof record?.path === 'string') record.path = onHost(hostId, record.path)
  }
}

/** Qualifies each project path in place, as a result is the host's own copy, and learns sessions. */
function qualify(hostId: string, value: unknown, depth: number): void {
  if (typeof value !== 'object' || value === null || depth >= MAX_DEPTH) return
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return
  if (Array.isArray(value)) {
    for (const item of value) qualify(hostId, item, depth + 1)
    return
  }
  const record = value as Record<string, unknown>
  if (typeof record.projectPath === 'string' && hostOfPath(record.projectPath) === null) {
    record.projectPath = onHost(hostId, record.projectPath)
    // A session's summary or view: its id, agent and folder.
    if (typeof record.id === 'string' && typeof record.agentId === 'string') {
      sessionHosts.set(record.id, hostId)
    }
  }
  for (const item of Object.values(record)) {
    if (typeof item === 'object' && item !== null) qualify(hostId, item, depth + 1)
  }
}

/** A terminal request to the host its terminal or project is on. */
export function terminals<M extends TerminalMethod>(
  method: M,
  params: TerminalParams<M>,
): Promise<TerminalResult<M>> {
  const { id, projectPath } = (params ?? {}) as { id?: unknown; projectPath?: unknown }
  const hostId =
    typeof id === 'string'
      ? terminalHost(id)
      : typeof projectPath === 'string'
        ? hostOfPath(projectPath)
        : null
  return terminalsAt(hostId, method, params)
}

/** A terminal request to the host named, null being this computer. */
export function terminalsAt<M extends TerminalMethod>(
  hostId: string | null,
  method: M,
  params: TerminalParams<M>,
): Promise<TerminalResult<M>> {
  if (hostId === null) return window.kettu.terminals.request(method, params)
  return window.kettu.hosts.request(hostId, method, toHost(method, params, 0)).then((result) => {
    learnTerminals(hostId, result)
    return result as TerminalResult<M>
  })
}

/** A host's terminal event as the window names folders, with the terminal it names learned. */
export function fromHostTerminalEvent(hostId: string, event: TerminalEvent): TerminalEvent {
  if (event.type === 'terminal.info') learnTerminals(hostId, event.info)
  else terminalHosts.set(event.id, hostId)
  return event
}

/** Qualifies the folders of the terminals a host describes, in place, and learns their host. */
function learnTerminals(hostId: string, value: unknown): void {
  for (const info of Array.isArray(value) ? value : [value]) {
    const record = info as { id?: unknown; projectPath?: unknown } | null
    if (typeof record?.id !== 'string' || typeof record.projectPath !== 'string') continue
    if (hostOfPath(record.projectPath) === null) {
      record.projectPath = onHost(hostId, record.projectPath)
    }
    terminalHosts.set(record.id, hostId)
  }
}

/** The code of a host or port error, if it has one. */
export function errorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code
    return typeof code === 'string' ? code : null
  }
  return null
}

/** What to show for a failed request: the host's own words, or the port's in the user's language. */
export function errorMessage(error: unknown): string {
  // The preload cannot translate, so its one error a user meets is worded here.
  if (errorCode(error) === 'host_restarted') return i18n.t('errors.hostRestarted')
  if (errorCode(error) === 'host_offline') return i18n.t('errors.hostOffline')
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}
