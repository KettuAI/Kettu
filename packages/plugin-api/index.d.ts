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

export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'

export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other'

export interface PullRequestInfo {
  url: string
  owner: string
  repo: string
  number: number
  /** Null until Kettu has read it. */
  state: 'open' | 'draft' | 'merged' | 'closed' | null
  /** An open one has a failing check. */
  failing: boolean
}

/** What a step of a workflow task tells; none of the task's text, notes or reports. */
export interface TaskStepInfo {
  task: { id: string; title: string; workflow: string; project: string }
  step: {
    id: string
    name: string
    /** Counted from 1: a step sent back runs again as the next round. */
    round: number
    agent: string | null
    /** The outcome the step ended with; null while it works. */
    outcome: string | null
  }
}

/**
 * Every event by name, with the value its listeners get. Kettu's own events are sent only to a
 * plugin whose manifest names them under `events` and that has the permission noted here, and only
 * for sessions the user works in: not a routine's run, a workflow step's session or a subagent's.
 * Events are in the order they happened, and no listener is waited for unless it is a hook.
 */
export interface KettuEvents {
  'app.locale': { locale: 'en' | 'zh-CN' }
  'app.colorMode': { colorMode: 'light' | 'dark' }
  /** Needs `sessions.summary`: a session came into the sidebar. */
  'session.started': { session: SessionInfo }
  /**
   * A hook, needs `prompt.attach`: a message the user wrote is about to go to the agent, after any
   * command of Kettu's was expanded. Not sent for a command of the agent's own. A listener that
   * returns `attach` adds that to the message; what the user wrote is never changed, and the
   * thread shows each plugin's attachments under the message. A listener that is not done within
   * 500 ms, counting the plugin's loading, is skipped and Kettu does not wait for it. A message
   * sent into a turn that is running is not offered.
   */
  'session.beforeSend': {
    sessionId: string
    /** Only with `sessions.summary`. */
    session?: SessionInfo
    /** The message, cut at 100,000 characters; only with `sessions.content`. */
    text?: string
  }
  /**
   * A hook, needs `requests.check`: the agent asks to use a tool, before the user is asked. A
   * listener may return `deny`, which answers the request with a refusal and says why in the
   * thread; it can do nothing else, so any other return, an error or a late answer leaves the
   * request to the user. It is never sent in Full access, where the agent does not ask, and not
   * for a question, a plan or an MCP server's request, which authorize nothing. Same deadline as
   * `session.beforeSend`.
   */
  'session.permissionRequested': {
    sessionId: string
    /** Only with `sessions.summary`. */
    session?: SessionInfo
    request: {
      /** The tool's title as the thread shows it. */
      tool: string
      kind: ToolKind
      /** The command, for a request to run one. */
      command: string | null
      paths: string[]
    }
  }
  /** Needs `sessions.summary`: a tool call completed or failed. `title` needs `sessions.content`. */
  'session.toolFinished': {
    session: SessionInfo
    kind: ToolKind
    status: 'completed' | 'failed'
    title?: string
  }
  /** Needs `sessions.summary`: a turn ended; `error` when it failed. */
  'session.turnEnded': {
    session: SessionInfo
    outcome: StopReason | 'error'
    durationMs: number
  }
  /** Needs `sessions.summary`: something waits for the user, a request or an error. */
  'session.needsUser': { session: SessionInfo; reason: 'permission' | 'error' }
  /**
   * Needs `sessions.summary`: a pull request of the session was opened in it, or its state or checks
   * changed since the plugin was told. `previous` is null for one just opened.
   */
  'session.pullRequestChanged': {
    session: SessionInfo
    pullRequest: PullRequestInfo
    previous: { state: PullRequestInfo['state']; failing: boolean } | null
  }
  /** Needs `sessions.summary`: a step of a workflow task started working. */
  'task.stepStarted': TaskStepInfo
  /** Needs `sessions.summary`: a step ended, with its outcome followed or sent back by the user. */
  'task.stepEnded': TaskStepInfo
}

export interface Attachment {
  /** What the agent reads, at most 16,000 characters. */
  text: string
  /** Shown in the thread beside the plugin's name. */
  title?: string
}

/**
 * What a listener of a hook may return, or resolve to. Up to 5 attachments and 32,000 characters of
 * them are taken from one plugin; any other event ignores what its listeners return.
 */
export interface KettuHookResults {
  'session.beforeSend': { attach?: Attachment[] } | void
  'session.permissionRequested': { deny: string } | void
}

export interface Kettu {
  call<N extends keyof KettuCalls>(
    name: N,
    ...args: KettuCalls[N]['args']
  ): Promise<KettuCalls[N]['result']>
  /** Returns a function that removes the listener. */
  on<N extends keyof KettuEvents>(
    name: N,
    listener: (
      payload: KettuEvents[N],
    ) => N extends keyof KettuHookResults
      ? KettuHookResults[N] | Promise<KettuHookResults[N]>
      : void,
  ): () => void
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
