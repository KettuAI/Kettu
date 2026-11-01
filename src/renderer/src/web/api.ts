// `window.kettu` for the web client: the agent and terminal hosts over the encrypted channel, and
// in place of main what a browser can do itself. What needs the desktop app is never offered: the
// page hides it, and a call that comes anyway is refused.

import type { HostEvent } from '@shared/agent-host'
import type { KettuApi } from '@shared/ipc'
import { matchLocale } from '@shared/locale'
import type { PortConnectionState } from '@shared/port-rpc'
import type { Platform } from '@shared/platform'
import type { TerminalEvent } from '@shared/terminal-host'
import { BUILTIN_THEME_ID } from '@shared/themes'
import { frameArtifact } from './frames'
import type { HostLink, LinkError } from './link'
import { downloadFile, mediaRequest } from './media'
import { WebSettings } from './settings'

function unsupported(what: string): Promise<never> {
  const error: LinkError = {
    name: 'PortRequestError',
    code: 'unknown_method',
    message: `The web client cannot ${what}`,
  }
  return Promise.reject(error)
}

const never = (): (() => void) => () => {}

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

export function webApi(link: HostLink, settings: WebSettings): KettuApi {
  // The last welcome's, kept while the link reconnects.
  let hostSystem: Platform | null = null
  link.onState((state) => {
    if (state.kind === 'connected') hostSystem = state.welcome.host.platform
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
      getInfo: async () => {
        const welcome = link.state.kind === 'connected' ? link.state.welcome : null
        return {
          name: 'Kettu',
          version: welcome?.host.version ?? '',
          system: navigator.userAgent,
          userDataPath: '',
          isPackaged: true,
        }
      },
      respondQuit: async () => {},
      onConfirmQuit: never,
      setUnsaved: () => {},
      onCommand: never,
      reportInteractive: () => {},
      perfMetrics: () => unsupported('measure performance'),
      onShortcut: never,
    },
    artifacts: {
      open: async (id) => ({ url: frameArtifact(id) }),
      close: async () => {},
      thumbnail: async () => null,
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
      status: () => unsupported('publish artifacts'),
      connect: () => unsupported('publish artifacts'),
      remove: () => unsupported('publish artifacts'),
      publish: () => unsupported('publish artifacts'),
      update: () => unsupported('publish artifacts'),
      unpublish: () => unsupported('publish artifacts'),
      onChanged: never,
    },
    remote: {
      status: () => unsupported('manage remote access'),
      pair: () => unsupported('manage remote access'),
      closePairing: () => unsupported('manage remote access'),
      answerPairing: () => unsupported('manage remote access'),
      renameDevice: () => unsupported('manage remote access'),
      removeDevice: () => unsupported('manage remote access'),
      activity: () => unsupported('manage remote access'),
      reset: () => unsupported('manage remote access'),
      retryDirect: () => unsupported('manage remote access'),
      onChanged: never,
      onPairing: never,
    },
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
      get: async () => settings.get(),
      update: async (patch) => settings.update(patch),
      onChanged: (listener) => settings.onChanged(listener),
      addAgent: () => unsupported('add agents'),
      renameAgent: () => unsupported('rename agents'),
      removeAgent: () => unsupported('remove agents'),
    },
    themes: {
      get: async () => ({ installed: [], chosen: BUILTIN_THEME_ID, failed: null }),
      install: () => unsupported('install themes'),
      replace: () => unsupported('install themes'),
      remove: () => unsupported('remove themes'),
      export: () => unsupported('export themes'),
      reveal: () => unsupported('show files'),
      catalog: async () => ({ status: 'unreachable' }),
      installCatalog: () => unsupported('install themes'),
      onChanged: never,
    },
    avatars: { load: async () => null },
    loginItem: { getStatus: async () => ({ available: false, requiresApproval: false }) },
    dialogs: {
      openProject: async () => null,
      chooseAgentBinary: async () => null,
      chooseAgentFolder: async () => null,
      chooseShell: async () => null,
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
      showDataFolder: () => unsupported('show files'),
      showItem: () => unsupported('show files'),
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
    notifications: { test: async () => false },
    updates: {
      getStatus: () => unsupported('update Kettu'),
      check: () => unsupported('update Kettu'),
      download: () => unsupported('update Kettu'),
      cancel: () => unsupported('update Kettu'),
      restart: () => unsupported('update Kettu'),
      dismiss: () => unsupported('update Kettu'),
      onChanged: never,
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
      restart: async () => link.wake(),
    },
    terminals: {
      request: ((method: string, params: unknown) =>
        link.request(method, params)) as KettuApi['terminals']['request'],
      onEvent: (listener) => link.onTerminalEvent((event) => listener(event as TerminalEvent)),
      onConnection: connectionListener,
      restart: async () => link.wake(),
    },
  }
}
