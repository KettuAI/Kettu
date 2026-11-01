// `window.kettu` for the web client: the agent and terminal hosts over the encrypted channel, the
// host's settings and host-level actions as its owner's calls to the host, and in place of main
// what a browser can do itself. What needs the desktop app's own window is never offered: the
// page hides it, and a call that comes anyway is refused.

import type { HostEvent } from '@shared/agent-host'
import type { AppCommand, KettuApi } from '@shared/ipc'
import { matchLocale } from '@shared/locale'
import type { PortConnectionState } from '@shared/port-rpc'
import type { Platform } from '@shared/platform'
import type { DirectAddress } from '@shared/remote/protocol'
import type {
  HostAdminEvent,
  HostAdminMethod,
  HostAdminParams,
  HostAdminResult,
  HostInfo,
} from '@shared/remote/host-admin'
import type { TerminalEvent } from '@shared/terminal-host'
import { useWebHostStore, type WebHost } from '@renderer/stores/web-host'
import { frameArtifact } from './frames'
import { folderOf, homeStart } from './host-path'
import { askHostPath, type HostPathPurpose } from './host-path-request'
import type { HostLink, LinkError, LinkState } from './link'
import { downloadFile, mediaRequest } from './media'
import { browserNotifications, notifyAttention, notifyTest } from './notifications'
import type { WebSettings } from './settings'
import { pickThemeFile, webThemes, type AdminCall } from './themes'

function unsupported(what: string): Promise<never> {
  const error: LinkError = {
    name: 'PortRequestError',
    code: 'unknown_method',
    message: `The web client cannot ${what}`,
  }
  return Promise.reject(error)
}

const never = (): (() => void) => () => {}

/** A call whose answer means nothing beyond having come. */
async function done(call: Promise<unknown>): Promise<void> {
  await call
}

/** The device's own system, which picks the shortcuts' modifier. */
export function devicePlatform(agent: Pick<Navigator, 'userAgent'>): Platform {
  if (/Macintosh|Mac OS X|iPhone|iPad|iPod/.test(agent.userAgent)) return 'darwin'
  if (/Windows/.test(agent.userAgent)) return 'win32'
  return 'linux'
}

/** A host's connection state as a window's port reports it. */
function portState(link: HostLink): PortConnectionState {
  const { kind } = link.state
  return kind === 'connected' ? 'connected' : kind === 'stopped' ? 'failed' : 'reconnecting'
}

/** What the web client knows of the host it connects to beyond the link. */
export interface WebHostContext {
  /** The page's own address, which this browser reaches the host at. */
  address: DirectAddress
  /** The names this browser kept from the last welcome, shown until the next one. */
  known: { name: string; deviceName: string }
  /** Clears what this browser keeps for the host and goes back to pairing. */
  forget(): Promise<void>
  /** This browser's storage for the host, which serves the page from its own origin. */
  storage: Pick<Storage, 'getItem' | 'setItem'> | null
}

/** The page's address as a direct one, with the port its scheme implies when it names none. */
export function pageAddress(
  location: Pick<Location, 'hostname' | 'port' | 'protocol'>,
): DirectAddress {
  return {
    host: location.hostname.replace(/^\[(.*)\]$/, '$1'),
    port: Number(location.port) || (location.protocol === 'https:' ? 443 : 80),
  }
}

/** The host as Settings shows it, once the link's state changed to `state` at `now`. */
export function webHost(previous: WebHost, state: LinkState, now: number): WebHost {
  switch (state.kind) {
    case 'connecting':
      return previous
    case 'connected': {
      const { host, device } = state.welcome
      return {
        ...previous,
        name: host.name,
        platform: host.platform,
        version: host.version,
        connection: { state: 'online', address: previous.address },
        lastOnlineAt: now,
        device: { id: device.id, name: device.name },
      }
    }
    case 'reconnecting':
      return {
        ...previous,
        connection: { state: 'offline' },
        lastOnlineAt: previous.connection.state === 'online' ? now : previous.lastOnlineAt,
      }
    case 'stopped':
      return { ...previous, connection: { state: 'stopped', reason: state.reason } }
  }
}

/** Copies the path and says so, where the desktop app shows the item in the file manager. */
async function copyPath(path: string): Promise<void> {
  await navigator.clipboard.writeText(path)
  const [{ toast }, { i18n }] = await Promise.all([
    import('@renderer/components/ui/toast'),
    import('@renderer/lib/i18n'),
  ])
  toast(i18n.t('web:copiedPath', { path }))
}

function askPath(
  purpose: HostPathPurpose,
  initial: string | null,
  commit?: (path: string) => Promise<void>,
): Promise<string | null> {
  const platform = window.kettu.hostPlatform()
  return askHostPath({
    purpose,
    initial: initial === null ? homeStart(platform) : folderOf(initial, platform),
    ...(commit ? { commit } : {}),
  })
}

export function webApi(link: HostLink, settings: WebSettings, context: WebHostContext): KettuApi {
  // The last welcome's, kept while the link reconnects.
  let hostSystem: Platform | null = null
  const admin: AdminCall = <M extends HostAdminMethod>(
    method: M,
    ...params: HostAdminParams<M> extends undefined ? [] : [HostAdminParams<M>]
  ): Promise<HostAdminResult<M>> => link.request(method, params[0]) as Promise<HostAdminResult<M>>
  const adminEvent = <T extends HostAdminEvent['type']>(
    type: T,
    listener: (event: Extract<HostAdminEvent, { type: T }>) => void,
  ): (() => void) =>
    link.onAdminEvent((event) => {
      if (event.type === type) listener(event as Extract<HostAdminEvent, { type: T }>)
    })

  // The host's facts, read again at each connection, as the host may have been updated.
  let info: Promise<HostInfo> | null = null
  const hostInfo = (): Promise<HostInfo> =>
    (info ??= admin('host.info').then(
      (read) => {
        useWebHostStore.setState({ info: read })
        return read
      },
      (error: unknown) => {
        info = null
        throw error
      },
    ))

  useWebHostStore.setState({
    host: {
      name: context.known.name,
      platform: null,
      version: null,
      address: context.address,
      connection: { state: 'connecting' },
      lastOnlineAt: null,
      device: { id: null, name: context.known.deviceName },
    },
    actions: {
      rename: (name) => link.send({ type: 'rename', name }),
      forget: () => context.forget(),
    },
  })
  link.onState((state) => {
    if (state.kind === 'connected') hostSystem = state.welcome.host.platform
    const { host } = useWebHostStore.getState()
    if (host) useWebHostStore.setState({ host: webHost(host, state, Date.now()) })
    if (state.kind === 'connected') {
      info = null
      hostInfo().catch((error: unknown) => console.error('Could not read the host', error))
    }
  })
  link.onMessage((message) => {
    const { host } = useWebHostStore.getState()
    if (message.type !== 'renamed' || typeof message.name !== 'string' || !host) return
    useWebHostStore.setState({ host: { ...host, device: { ...host.device, name: message.name } } })
  })

  // What a notification's click opens, as main sends a window its menu's commands.
  const commands = new Set<(command: AppCommand) => void>()
  adminEvent('attention', ({ attention }) => {
    notifyAttention(attention, {
      notifications: browserNotifications(),
      settings: () => settings.current(),
      inFront: () => document.visibilityState === 'visible' && document.hasFocus(),
      open: (command) => {
        window.focus()
        for (const listener of commands) listener(command)
      },
    })
  })

  const connectionListener = (listener: (state: PortConnectionState) => void): (() => void) => {
    let last: PortConnectionState | null = null
    return link.onState(() => {
      const state = portState(link)
      if (state === last || (last === null && link.state.kind === 'connecting')) return
      last = state
      listener(state)
    })
  }

  return {
    platform: devicePlatform(navigator),
    client: 'web',
    hostPlatform: () => hostSystem ?? devicePlatform(navigator),
    perf: false,
    systemLocale: matchLocale(navigator.languages),
    app: {
      // The web client is the host's own build, so its version is the host's.
      getInfo: () => hostInfo(),
      respondQuit: async () => {},
      onConfirmQuit: never,
      setUnsaved: () => {},
      onCommand: (listener) => {
        commands.add(listener)
        return () => commands.delete(listener)
      },
      reportInteractive: () => {},
      perfMetrics: () => unsupported('measure performance'),
      onShortcut: never,
    },
    artifacts: {
      open: async (id) => ({ url: frameArtifact(id) }),
      close: async () => {},
      // Only a desktop host captures previews; the daemon's artifacts show none.
      thumbnail: async (id, version, layout) => {
        const known = useWebHostStore.getState().info
        if (known && !known.thumbnails) return null
        return admin('artifacts.thumbnail', { id, version, layout }).catch(() => null)
      },
      openExternal: () => unsupported('open an artifact outside the app'),
      export: async (id, version) => {
        const read = (await link.request('artifacts.read', { id, version })) as {
          title: string
          html: string
        }
        downloadFile(new Blob([read.html], { type: 'text/html' }), `${read.title || id}.html`)
        return true
      },
      import: () => unsupported('import an artifact'),
      onBlocked: never,
      onStopped: never,
    },
    sharing: {
      status: () => admin('sharing.status'),
      connect: (token, accountId) => admin('sharing.connect', { token, accountId }),
      remove: () => admin('sharing.remove'),
      publish: (id, version) => admin('sharing.publish', { id, version }),
      update: (id, version) => admin('sharing.update', { id, version }),
      unpublish: (id) => admin('sharing.unpublish', { id }),
      onChanged: (listener) => adminEvent('sharing.changed', (event) => listener(event.status)),
    },
    remote: {
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
      onChanged: (listener) => adminEvent('remote.changed', (event) => listener(event.status)),
      onPairing: (listener) => adminEvent('remote.pairing', (event) => listener(event.event)),
    },
    // This page reaches only the host that served it, which Settings > Hosts shows from the
    // connection itself.
    hosts: {
      status: () => unsupported('connect to other hosts'),
      pair: () => unsupported('connect to other hosts'),
      closePairing: () => unsupported('connect to other hosts'),
      rename: () => unsupported('connect to other hosts'),
      setAddresses: () => unsupported('connect to other hosts'),
      remove: () => unsupported('connect to other hosts'),
      onChanged: never,
      onPairing: never,
    },
    settings: {
      get: () => settings.get(),
      update: (patch) => settings.update(patch),
      onChanged: (listener) => settings.onChanged(listener),
      addAgent: (harnessId, name, folder) =>
        admin('settings.addAgent', { harnessId, name, folder }),
      renameAgent: (agentId, name) => done(admin('settings.renameAgent', { agentId, name })),
      removeAgent: (agentId, trash) => done(admin('settings.removeAgent', { agentId, trash })),
    },
    themes: webThemes({
      admin,
      onHostChanged: (listener) => adminEvent('themes.changed', ({ themes }) => listener(themes)),
      onConnected: (listener) =>
        link.onState((state) => {
          if (state.kind === 'connected') listener()
        }),
      settings,
      storage: context.storage,
      pickFile: pickThemeFile,
      download: downloadFile,
      copyPath,
    }),
    avatars: { load: async () => null },
    loginItem: { getStatus: async () => ({ available: false, requiresApproval: false }) },
    // A browser has no system dialog for the host's files, so the path is typed in the page.
    dialogs: {
      // Beside the project opened last, as projects tend to share a folder.
      openProject: async () => {
        const { useProjectsStore } = await import('@renderer/stores/projects')
        return askPath('project', useProjectsStore.getState().projects[0]?.path ?? null)
      },
      chooseAgentFolder: () => askPath('agentFolder', null),
      chooseAgentBinary: (harnessId) =>
        askPath(
          'agentProgram',
          settings.current().agents[harnessId]?.binaryPath ?? null,
          async (path) =>
            settings.takeHost(await admin('settings.setAgentBinary', { harnessId, path })),
        ),
      chooseShell: () =>
        askPath('shell', settings.current().terminal.shellPath ?? null, async (path) =>
          settings.takeHost(await admin('settings.setShellPath', { path })),
        ),
    },
    diagnostics: {
      save: async (bundle) => {
        const name = `kettu-diagnostics-${new Date().toISOString().slice(0, 10)}.json`
        downloadFile(
          new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }),
          name,
        )
        return name
      },
    },
    shell: {
      showDataFolder: async () => copyPath((await hostInfo()).userDataPath),
      showItem: (path) => copyPath(path),
      openNotices: () => unsupported('show files'),
    },
    media: {
      copyImage: async (source) => {
        const blob =
          typeof source === 'string'
            ? await (await fetch(source)).blob()
            : new Blob([source.bytes as Uint8Array<ArrayBuffer>], { type: source.mimeType })
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
      },
      saveAs: async (source) => {
        if (typeof source === 'string') {
          downloadFile(await (await fetch(source)).blob(), '')
        } else {
          const blob = new Blob([source.bytes as Uint8Array<ArrayBuffer>], {
            type: source.mimeType,
          })
          downloadFile(blob, source.name)
        }
        return true
      },
      reveal: () => unsupported('show files'),
      openExternal: () => unsupported('open files in another app'),
    },
    notifications: {
      test: async () => {
        const { i18n } = await import('@renderer/lib/i18n')
        return notifyTest(
          { notifications: browserNotifications(), settings: () => settings.current() },
          {
            title: i18n.t('web:notifications.testTitle'),
            body: i18n.t('web:notifications.testBody'),
          },
        )
      },
    },
    updates: {
      getStatus: () => admin('updates.status'),
      check: () => admin('updates.check'),
      download: () => done(admin('updates.download')),
      cancel: () => done(admin('updates.cancel')),
      restart: () => done(admin('updates.restart')),
      dismiss: () => done(admin('updates.dismiss')),
      onChanged: (listener) => adminEvent('updates.changed', (event) => listener(event.status)),
    },
    browser: {
      show: () => unsupported('show the browser'),
      hide: async () => {},
      setBounds: async () => {},
      navigate: () => unsupported('show the browser'),
      back: () => unsupported('show the browser'),
      forward: () => unsupported('show the browser'),
      reload: () => unsupported('show the browser'),
      stop: () => unsupported('show the browser'),
      openExternal: () => unsupported('show the browser'),
      freeze: async () => null,
      thaw: async () => {},
      handBack: () => unsupported('show the browser'),
      stopDriving: () => unsupported('show the browser'),
      answerOrigin: () => unsupported('show the browser'),
      allowedSites: async () => [],
      removeAllowedSite: () => unsupported('show the browser'),
      clearData: () => unsupported('show the browser'),
      setSessions: () => {},
      onState: never,
      onOpened: never,
    },
    attachments: {
      // The page picks and reads files itself and sends their bytes.
      pick: async () => [],
      fromFiles: async (files) => files.map(() => null),
      fromClipboard: () => null,
    },
    agents: {
      request: ((method: string, params: unknown) =>
        mediaRequest(link, method, params) ??
        link.request(method, params)) as KettuApi['agents']['request'],
      onEvent: (listener) => link.onHostEvent((event) => listener(event as HostEvent)),
      onConnection: connectionListener,
      // The link connects again by itself; a host that stopped its agent host starts it here.
      restart: async () => {
        link.wake()
        await admin('host.restart', { process: 'agent' })
      },
    },
    terminals: {
      request: ((method: string, params: unknown) =>
        link.request(method, params)) as KettuApi['terminals']['request'],
      onEvent: (listener) => link.onTerminalEvent((event) => listener(event as TerminalEvent)),
      onConnection: connectionListener,
      restart: async () => {
        link.wake()
        await admin('host.restart', { process: 'terminal' })
      },
    },
  }
}
