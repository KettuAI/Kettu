// The Kettu plugin API, version 1: the global `kettu` a plugin's script sees, and the one list
// of calls and events it may use. A call needs the permission named in its comment, declared in
// the plugin's manifest; without it the call fails with an error that names the permission.
// Within version 1 calls are only added, never changed or removed.

export type SessionState =
  'starting' | 'auth_required' | 'ready' | 'running' | 'awaiting_permission' | 'failed' | 'closed'

export type SessionPhase =
  | 'thinking'
  | 'execute'
  | 'read'
  | 'search'
  | 'fetch'
  | 'edit'
  | 'writing'
  | 'compacting'
  | 'approval'
  | 'question'
  | 'working'

/** What a plugin sees of a session: nothing that was said in it. */
export interface SessionInfo {
  id: string
  title: string | null
  /** The project's folder, or the session's scratch folder. */
  project: string
  agent: string
  state: SessionState
  /** What its running turn does now; null between turns. */
  doing: SessionPhase | null
  parentId: string | null
  /** Milliseconds since the epoch. */
  createdAt: number
  updatedAt: number
  archived: boolean
}

export interface SessionTurn {
  /** Counted from 1 over the whole conversation. */
  number: number
  agent: string
  /** What the user sent and what the agent answered; a long one is cut at its start. */
  user: string
  assistant: string
}

export interface FetchInit {
  /** GET, HEAD, POST, PUT, PATCH or DELETE; GET when left out. */
  method?: string
  /** Kettu sets Host, Content-Length and the other connection headers itself. */
  headers?: Record<string, string>
  /** Text of at most 256 KB; not for GET and HEAD. */
  body?: string
}

export interface FetchResponse {
  status: number
  /** Lowercase names; a header sent more than once is joined with ", ". */
  headers: Record<string, string>
  /** At most 256 KB of UTF-8 text. */
  body: string
}

/** Every call by name, with its arguments and what it resolves to. */
export interface KettuCalls {
  /** The newest plugin API version this Kettu speaks. */
  'api.version': { args: []; result: number }
  /** The interface language. */
  'app.locale': { args: []; result: 'en' | 'zh-CN' }
  /** The window's color mode; null where Kettu runs without a window. */
  'app.colorMode': { args: []; result: 'light' | 'dark' | null }
  /**
   * Needs `network:<domain>` for the address's host. Https only, on the default port, with no
   * redirect followed and no address on this computer or a private network.
   */
  'network.fetch': { args: [url: string, init?: FetchInit]; result: FetchResponse }
  /** Needs `sessions.summary`: the sessions the sidebar lists, newest first. */
  'sessions.list': {
    args: [options?: { project?: string; includeArchived?: boolean; limit?: number }]
    result: { sessions: SessionInfo[] }
  }
  /** Needs `sessions.content`: a session's turns, the latest first, 5 by default and at most 20. */
  'sessions.read': {
    args: [options: { id: string; before?: number; limit?: number }]
    result: { total: number; turns: SessionTurn[]; moreBefore: number | null }
  }
  /**
   * Needs `sessions.start`: starts a session in a project of the user's, or in a scratch folder
   * when `project` is left out. Its mode is never wider than Auto. At most 3 work at once and 10
   * start in a day.
   */
  'sessions.start': {
    args: [
      options: { prompt: string; project?: string; agent?: string; mode?: string; title?: string },
    ]
    result: SessionInfo
  }
  /** Needs `sessions.start`: messages a session this plugin started, and no other. */
  'sessions.send': {
    args: [options: { id: string; text: string }]
    result: { id: string; delivered: 'sent' | 'queued' | 'steered' | 'interrupted' }
  }
}

/** Every event by name, with the value its listeners get. */
export interface KettuEvents {
  'app.locale': { locale: 'en' | 'zh-CN' }
  'app.colorMode': { colorMode: 'light' | 'dark' }
}

export interface Kettu {
  call<N extends keyof KettuCalls>(
    name: N,
    ...args: KettuCalls[N]['args']
  ): Promise<KettuCalls[N]['result']>
  /** Returns a function that removes the listener. */
  on<N extends keyof KettuEvents>(name: N, listener: (payload: KettuEvents[N]) => void): () => void
}

declare global {
  /** The plugin's own log; each line goes to Kettu's log under the plugin's name. */
  const console: Readonly<
    Record<'log' | 'info' | 'warn' | 'error' | 'debug', (...args: unknown[]) => void>
  >
  const kettu: Kettu
  function setTimeout(callback: () => void, ms?: number): number
  function clearTimeout(id: number): void
}
