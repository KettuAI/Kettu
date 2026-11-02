// The host Settings' host sections show: this computer, which its main and agent host serve, or
// another host this computer connects to, whose parent answers its owner's calls over the
// encrypted channel and checks them as its own Settings page does. Another host's part is kept in
// stores of its own, so the rest of the window never mixes it with this computer's.

import { createContext, useContext } from 'react'
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { HostEvent } from '@shared/agent-host'
import type { GitTools } from '@shared/git'
import type { AppInfo, KettuApi } from '@shared/ipc'
import type { Platform } from '@shared/platform'
import {
  hostSettingsPart,
  isHostAdminEvent,
  splitSettingsPatch,
  withHostSettings,
  type HostAdminEvent,
  type HostAdminMethod,
  type HostAdminParams,
  type HostAdminResult,
  type HostInfo,
  type HostSettingsPart,
} from '@shared/remote/host-admin'
import { DEFAULT_SETTINGS, type SettingsFile } from '@shared/settings'
import type { HarnessId } from '@shared/thread'
import type { UsageStatus } from '@shared/usage'
import { copyPath } from '@renderer/lib/copy-path'
import { errorMessage, host, hostAt, type HostRequest } from '@renderer/lib/host'
import { folderOf, homeStart } from '@renderer/web/host-path'
import { askHostPath, type HostPathPurpose } from '@renderer/web/host-path-request'
import { createAgentsStore, useAgentsStore, type AgentsStoreHook } from './agents'
import { loadGitTools, useGitStore } from './git'
import { otherHosts, useHostsStore } from './hosts'
import { createMcpStore, useMcpStore, type McpStoreHook } from './mcp'
import { useRemoteStore, type RemoteStore } from './remote'
import { useSettingsStore, type SettingsStore } from './settings'
import { createSharing, localSharing, type Sharing } from './sharing'
import { useUsageStore } from './usage'
import { useWebHostStore } from './web-host'

/** What the host sections ask of their host beyond its agent host. */
export interface ScopeApi {
  settings: Pick<KettuApi['settings'], 'addAgent' | 'renameAgent' | 'removeAgent'>
  remote: KettuApi['remote']
  dialogs: Pick<KettuApi['dialogs'], 'chooseAgentFolder' | 'chooseAgentBinary' | 'chooseShell'>
  /** Shows a file of the host in this computer's file manager, or copies a path it cannot show. */
  showItem(path: string): Promise<void>
  getInfo(): Promise<AppInfo>
  restart(process: 'agent' | 'terminal'): Promise<void>
}

/** A store the host sections only read. */
export type ReadStore<S> = (<T>(selector: (state: S) => T) => T) & { getState(): S }

export interface HostScope {
  /** Another host the sections show, or null for this computer's own. */
  hostId: string | null
  request: HostRequest
  api: ScopeApi
  useSettingsStore: UseBoundStore<StoreApi<SettingsStore>>
  useAgentsStore: AgentsStoreHook
  useMcpStore: McpStoreHook
  useRemoteStore: ReadStore<RemoteStore>
  sharing: Sharing
  useUsageStore: ReadStore<{ status: UsageStatus | null }>
  useGitStore: ReadStore<{ tools: GitTools | null; toolsError: string | null }>
  loadGitTools(): Promise<void>
  /** What the host offers beyond its sessions, as it said; null until it has. */
  useInfoStore: ReadStore<{ info: HostInfo | null }>
}

/** This computer's own, which the rest of the window shows too. */
export const LOCAL_SCOPE: HostScope = {
  hostId: null,
  request: host,
  api: {
    get settings() {
      return window.kettu.settings
    },
    get remote() {
      return window.kettu.remote
    },
    get dialogs() {
      return window.kettu.dialogs
    },
    showItem: (path) => window.kettu.shell.showItem(path),
    getInfo: () => window.kettu.app.getInfo(),
    restart: (process) =>
      process === 'agent' ? window.kettu.agents.restart() : window.kettu.terminals.restart(),
  },
  useSettingsStore,
  useAgentsStore,
  useMcpStore,
  useRemoteStore,
  sharing: localSharing,
  useUsageStore,
  useGitStore,
  loadGitTools,
  useInfoStore: useWebHostStore,
}

export const HostScopeContext = createContext<HostScope>(LOCAL_SCOPE)

/** The host the section showing this component belongs to. */
export function useHostScope(): HostScope {
  return useContext(HostScopeContext)
}

interface OtherScope {
  scope: HostScope
  part: UseBoundStore<StoreApi<{ part: HostSettingsPart | null }>>
  remote: UseBoundStore<StoreApi<RemoteStore>>
  usage: UseBoundStore<StoreApi<{ status: UsageStatus | null }>>
  git: UseBoundStore<StoreApi<{ tools: GitTools | null; toolsError: string | null }>>
  info: UseBoundStore<StoreApi<{ info: HostInfo | null }>>
  adminListeners: Set<(event: HostAdminEvent) => void>
}

const scopes = new Map<string, OtherScope>()

/** The scope of another host this computer connects to, made the first time it is asked for. */
export function hostScope(hostId: string): HostScope {
  let other = scopes.get(hostId)
  if (!other) {
    other = createScope(hostId)
    scopes.set(hostId, other)
    void load(other)
  }
  return other.scope
}

/** One of another host's events, for its scope, if Settings has shown it. */
export function hostScopeEvent(hostId: string, event: HostEvent | HostAdminEvent): void {
  const other = scopes.get(hostId)
  if (!other) return
  if (isHostAdminEvent(event)) return adminEvent(other, event)
  const agents = other.scope.useAgentsStore
  switch (event.type) {
    case 'agent.status':
      agents.getState().setOne(event.status)
      break
    case 'agent.removed':
      agents.getState().remove(event.agentId)
      break
    case 'environment.changed':
      agents.setState({ environment: event.info })
      break
    case 'git.tools':
      other.git.setState({ tools: event.tools, toolsError: null })
      break
    case 'usage.status':
      other.usage.setState({ status: event.status })
      break
  }
}

/** A new session with the host opened: what changed while away is read again. */
export function hostScopeOpened(hostId: string): void {
  const other = scopes.get(hostId)
  if (other) void load(other)
}

function adminEvent(other: OtherScope, event: HostAdminEvent): void {
  if (event.type === 'settings.changed') other.part.setState({ part: event.settings })
  else if (event.type === 'remote.changed') other.remote.setState({ status: event.status })
  else if (event.type === 'sharing.changed') {
    other.scope.sharing.useSharingStore.setState({ status: event.status })
  }
  for (const listener of other.adminListeners) listener(event)
}

async function load(other: OtherScope): Promise<void> {
  const { scope } = other
  const admin = adminCall(scope.hostId!)
  const reads: Promise<unknown>[] = [
    admin('settings.get').then((part) => other.part.setState({ part })),
    admin('host.info').then(async (info) => {
      other.info.setState({ info })
      if (!info.sharing) return
      const status = await admin('sharing.status')
      scope.sharing.useSharingStore.setState({ status })
    }),
    scope.useAgentsStore.getState().refresh(),
    admin('remote.status').then((status) => other.remote.setState({ status })),
    scope.request('usage.status', undefined).then((status) => other.usage.setState({ status })),
    scope.loadGitTools(),
  ]
  for (const result of await Promise.allSettled(reads)) {
    if (result.status === 'rejected') console.warn('Could not read a host', result.reason)
  }
}

type AdminCall = <M extends HostAdminMethod>(
  method: M,
  ...params: HostAdminParams<M> extends undefined ? [] : [HostAdminParams<M>]
) => Promise<HostAdminResult<M>>

function adminCall(hostId: string): AdminCall {
  return (method, ...params) =>
    window.kettu.hosts.request(hostId, method, params[0]) as Promise<HostAdminResult<typeof method>>
}

async function done(call: Promise<unknown>): Promise<void> {
  await call
}

function createScope(hostId: string): OtherScope {
  const admin = adminCall(hostId)
  const request: HostRequest = (method, params) => hostAt(hostId, method, params)
  const part = create<{ part: HostSettingsPart | null }>()(() => ({ part: null }))
  const remote = create<RemoteStore>()(() => ({ status: null }))
  const usage = create<{ status: UsageStatus | null }>()(() => ({ status: null }))
  const git = create<{ tools: GitTools | null; toolsError: string | null }>()(() => ({
    tools: null,
    toolsError: null,
  }))
  const info = create<{ info: HostInfo | null }>()(() => ({ info: null }))
  const adminListeners = new Set<(event: HostAdminEvent) => void>()
  const listen = <T extends HostAdminEvent['type']>(
    type: T,
    listener: (event: Extract<HostAdminEvent, { type: T }>) => void,
  ): (() => void) => {
    const each = (event: HostAdminEvent): void => {
      if (event.type === type) listener(event as Extract<HostAdminEvent, { type: T }>)
    }
    adminListeners.add(each)
    return () => adminListeners.delete(each)
  }

  // The window's own keys stay this computer's; the host's come from the host, at their
  // defaults until it answers, never this computer's values in their place.
  const merged = (): SettingsFile =>
    withHostSettings(
      useSettingsStore.getState().settings,
      part.getState().part ?? hostSettingsPart(DEFAULT_SETTINGS),
    )
  const takePart = (next: HostSettingsPart): void => part.setState({ part: next })
  const settings = create<SettingsStore>()(() => ({
    settings: merged(),
    loaded: false,
    async update(patch) {
      const split = splitSettingsPatch(patch)
      if (split.host) takePart(await admin('settings.update', { patch: split.host }))
      if (split.client) await useSettingsStore.getState().update(split.client)
    },
  }))
  const follow = (): void =>
    settings.setState({ settings: merged(), loaded: part.getState().part !== null })
  part.subscribe(follow)
  useSettingsStore.subscribe((state, previous) => {
    if (state.settings !== previous.settings) follow()
  })

  const on = (): { hostId: string; name: string; platform: Platform } => {
    const known = otherHosts(useHostsStore.getState()).find((h) => h.id === hostId)
    return { hostId, name: known?.name ?? '', platform: known?.platform ?? 'linux' }
  }
  const askPath = (
    purpose: HostPathPurpose,
    initial: string | null,
    commit?: (path: string) => Promise<void>,
  ): Promise<string | null> => {
    const where = on()
    return askHostPath({
      purpose,
      initial: initial === null ? homeStart(where.platform) : folderOf(initial, where.platform),
      on: where,
      ...(commit ? { commit } : {}),
    })
  }

  const remoteApi: KettuApi['remote'] = {
    status: () => admin('remote.status'),
    pair: () => admin('remote.pair'),
    closePairing: (codeId) => done(admin('remote.closePairing', { codeId })),
    answerPairing: (codeId, add, name) =>
      done(admin('remote.answerPairing', { codeId, add, name })),
    renameDevice: (id, name) => admin('remote.renameDevice', { id, name }),
    removeDevice: (id) => admin('remote.removeDevice', { id }),
    activity: (id) => admin('remote.activity', { id }),
    reset: () => done(admin('remote.reset')),
    retryDirect: () => done(admin('remote.retryDirect')),
    onChanged: (listener) => listen('remote.changed', (event) => listener(event.status)),
    onPairing: (listener) => listen('remote.pairing', (event) => listener(event.event)),
  }
  const sharingApi: KettuApi['sharing'] = {
    status: () => admin('sharing.status'),
    connect: (token, accountId) => admin('sharing.connect', { token, accountId }),
    remove: () => admin('sharing.remove'),
    publish: (id, version) => admin('sharing.publish', { id, version }),
    update: (id, version) => admin('sharing.update', { id, version }),
    unpublish: (id) => admin('sharing.unpublish', { id }),
    onChanged: (listener) => listen('sharing.changed', (event) => listener(event.status)),
  }

  const scope: HostScope = {
    hostId,
    request,
    api: {
      settings: {
        addAgent: (harnessId, name, folder) =>
          admin('settings.addAgent', { harnessId, name, folder }),
        renameAgent: (agentId, name) => done(admin('settings.renameAgent', { agentId, name })),
        removeAgent: (agentId, trash) => done(admin('settings.removeAgent', { agentId, trash })),
      },
      remote: remoteApi,
      dialogs: {
        chooseAgentFolder: () => askPath('agentFolder', null),
        chooseAgentBinary: (harnessId: HarnessId) =>
          askPath(
            'agentProgram',
            settings.getState().settings.agents[harnessId]?.binaryPath ?? null,
            async (path) => takePart(await admin('settings.setAgentBinary', { harnessId, path })),
          ),
        chooseShell: () =>
          askPath('shell', settings.getState().settings.terminal.shellPath ?? null, async (path) =>
            takePart(await admin('settings.setShellPath', { path })),
          ),
      },
      showItem: (path) => copyPath(path),
      getInfo: async () => {
        const read = await admin('host.info')
        info.setState({ info: read })
        return read
      },
      restart: (process) => done(admin('host.restart', { process })),
    },
    useSettingsStore: settings,
    useAgentsStore: createAgentsStore(request),
    useMcpStore: createMcpStore(request),
    useRemoteStore: remote,
    sharing: createSharing(() => sharingApi),
    useUsageStore: usage,
    useGitStore: git,
    loadGitTools: async () => {
      git.setState({ toolsError: null })
      try {
        git.setState({ tools: await request('git.tools', undefined) })
      } catch (error) {
        git.setState({ tools: null, toolsError: errorMessage(error) })
      }
    },
    useInfoStore: info,
  }
  return { scope, part, remote, usage, git, info, adminListeners }
}

/** Which host Settings' host sections show; null for this computer. */
export const useSettingsHostStore = create<{ hostId: string | null }>()(() => ({ hostId: null }))
