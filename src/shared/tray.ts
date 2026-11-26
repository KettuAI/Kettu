// The contract between main and the menu bar panel, the page the tray icon's left click opens.

import type {
  AgentAccount,
  AgentsApi,
  HostMethod,
  HostParams,
  HostResult,
  PlanLimit,
} from './agent-host'
import type { KettuApi } from './ipc'
import type { AgentId, HarnessId } from './thread'

/** Where the panel sends the user: a page of the main window, which comes forward for it. */
export type TrayTarget =
  | { kind: 'app' }
  | { kind: 'session'; sessionId: string }
  | { kind: 'new-session' }
  | { kind: 'settings' }

const SESSION_ID_MAX_CHARS = 256

export function isTrayTarget(value: unknown): value is TrayTarget {
  if (typeof value !== 'object' || value === null) return false
  const { kind, sessionId } = value as Record<string, unknown>
  if (kind === 'session') {
    return (
      typeof sessionId === 'string' &&
      sessionId.length > 0 &&
      sessionId.length <= SESSION_ID_MAX_CHARS
    )
  }
  return kind === 'app' || kind === 'new-session' || kind === 'settings'
}

/** The panel's height in CSS pixels, which main keeps within these bounds. */
export const TRAY_PANEL_HEIGHT = { min: 120, max: 720 }

/**
 * The agent host's methods the panel may call: what it lists, the plan limits it reads again, the
 * requests it shows, the files a finished turn changed and the answers it gives. The panel's preload refuses every other method.
 */
export const TRAY_HOST_METHODS = [
  'agents.list',
  'agents.refreshLimits',
  'sessions.list',
  'sessions.requests',
  'sessions.snapshot',
  'permissions.respond',
  'browser.answerOrigin',
  'computer.answerApp',
] as const satisfies readonly HostMethod[]

export type TrayHostMethod = (typeof TRAY_HOST_METHODS)[number]

/**
 * What the menu bar panel reads of an agent on another host: only enough to match an account
 * and pick its newest plan limit reading.
 */
export interface TrayHostAgent {
  id: AgentId
  harnessId: HarnessId
  account: AgentAccount | null
  limits: PlanLimit[]
}

/** One connected host's agents, as main passes them to the menu bar panel. */
export interface TrayHostAgents {
  hostId: string
  agents: TrayHostAgent[]
}

/** What the panel's preload exposes as `window.kettu`: the reads it shares and its own calls. */
export interface TrayPanelApi {
  platform: KettuApi['platform']
  client: 'desktop'
  systemLocale: KettuApi['systemLocale']
  settings: Pick<KettuApi['settings'], 'get' | 'onChanged'>
  themes: Pick<KettuApi['themes'], 'get' | 'onChanged'>
  remote: Pick<KettuApi['remote'], 'status' | 'onChanged'>
  agents: Pick<AgentsApi, 'onEvent' | 'onConnection'> & {
    request<M extends TrayHostMethod>(method: M, params: HostParams<M>): Promise<HostResult<M>>
  }
  tray: {
    open(target: TrayTarget): void
    quit(): void
    hide(): void
    /** The page's height, which the window takes. */
    resize(height: number): void
    /** The panel came forward, so the page reads again and starts at its list. */
    onShown(listener: () => void): () => void
    /** Other connected hosts' agents, for picking each account's newest plan limit reading. */
    hostAgents(): Promise<TrayHostAgents[]>
    onHostAgentsChanged(listener: (hosts: TrayHostAgents[]) => void): () => void
  }
}
