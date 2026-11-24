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
   * What one of the settings the manifest declares holds now, its default until the user or an
   * agent sets it. Fails for a key the manifest does not declare and for a secret.
   */
  'settings.get': { args: [key: string]; result: string | boolean }
  /** A secret the manifest declares, or null while it is not set. */
  'settings.secret': { args: [key: string]; result: string | null }
  /**
   * `length` bytes from the system's cryptographic random source, as lowercase hex, so
   * `2 * length` characters: for secrets such as one-time tokens, which `Math.random` is no good
   * for. `length` is a whole number of 1 to 256.
   */
  'random.bytes': { args: [length: number]; result: string }
  /**
   * The plugin's own storage, kept on the host and removed with the plugin: a value is any JSON,
   * null for a key not set. All of it holds at most 256 KB of JSON and 1,000 keys of at most 128
   * characters, past which `storage.set` fails.
   */
  'storage.get': { args: [key: string]; result: unknown }
  'storage.set': { args: [key: string, value: unknown]; result: null }
  'storage.delete': { args: [key: string]; result: null }
  /** Every key, sorted. */
  'storage.keys': { args: []; result: string[] }
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
  /**
   * Needs `requests.answer`: relays the answer the user gave elsewhere to a permission request that
   * a `channel.notice` told this plugin of, as the answer the user gave in Kettu would. `decision`
   * is `allow_once` or `deny`; an answer is never relayed as always allowing, and nothing but a
   * plain permission request can be answered, never a question or a plan. It fails for a request
   * no notice of this plugin's channels told it of, one that no longer waits, and when the user no
   * longer sends permission requests to a channel of this plugin. `from` says where the user gave
   * the answer, at most 60 characters; the thread shows it with the plugin's name.
   */
  'requests.answer': {
    args: [options: { request: string; decision: 'allow_once' | 'deny'; from?: string }]
    result: { request: string; decision: 'allow_once' | 'deny' }
  }
}

export type NoticeKind = 'permission' | 'turnEnded' | 'error' | 'routines' | 'planLimits'

/** A notice of Kettu's that the user sent to one of this plugin's channels. */
export interface ChannelNotice {
  /** The id the manifest declares the channel by. */
  channel: string
  kind: NoticeKind
  /**
   * At most 200 characters. A notice of a session names the session, so without `sessions.content`
   * its title is a plain one for the kind; with `requests.answer` a permission request's title is
   * the session's. A plan limit and a paused routine always have their own.
   */
  title: string
  /**
   * At most 500 characters. What a notice of a session says comes only with `sessions.content`; a
   * plan limit and a paused routine always have it.
   */
  text?: string
  /**
   * For a plain permission request, with `requests.answer`: what it asks for, as
   * `session.permissionRequested` gives it, and the `id` `requests.answer` names it by. A request
   * that is a question, a plan or a command of several steps has none, and cannot be answered.
   */
  request?: {
    id: string
    /** The tool's title as the thread shows it. */
    tool: string
    kind: ToolKind
    /** The command, for a request to run one. */
    command: string | null
    paths: string[]
  }
}

export type ViewIcon =
  | 'alert'
  | 'bell'
  | 'branch'
  | 'bug'
  | 'calendar'
  | 'chart'
  | 'check'
  | 'clock'
  | 'code'
  | 'comment'
  | 'database'
  | 'file'
  | 'flag'
  | 'folder'
  | 'globe'
  | 'info'
  | 'link'
  | 'list'
  | 'lock'
  | 'mail'
  | 'play'
  | 'plus'
  | 'pull-request'
  | 'reload'
  | 'rocket'
  | 'search'
  | 'settings'
  | 'sparkles'
  | 'star'
  | 'tag'
  | 'tool'
  | 'trash'
  | 'user'

/** What a view is told when it opens, and what an action is told when it runs. */
export interface ViewRequest {
  /** The id the manifest declares the view by. */
  view: string
  /** What the view was opened with, from an action's `open.params`; at most 8 entries of 200 characters. */
  params: Record<string, string>
  locale: 'en' | 'zh-CN'
}

export interface ViewActionRequest extends ViewRequest {
  action: string
  /** The row whose action it is, in a list. */
  row?: string
  /** A form's values: switches as booleans, choices and texts as text. */
  values?: Record<string, string | boolean>
}

/** What an action a manifest declares under `actions` is told when it runs from Search. */
export interface ActionRunRequest {
  /** The id the manifest declares the action by. */
  action: string
  locale: 'en' | 'zh-CN'
}

/**
 * A button, or a row's action. It runs the script's `view.action` listener, or with `open` goes to
 * another view of the same plugin without running it. Within one list `id`s are unique and at most
 * one action is `primary`; `destructive` ones are confirmed before they run.
 */
export interface ViewAction {
  id: string
  /** At most 60 characters. */
  label: string
  icon?: ViewIcon
  /** At most 200 characters, shown where the view has room for it. */
  description?: string
  primary?: boolean
  destructive?: boolean
  /** The question of the confirmation, at most 300 characters. */
  confirm?: string
  disabled?: boolean
  open?: { view: string; params?: Record<string, string> }
}

export interface ViewBadge {
  /** At most 40 characters. */
  text: string
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger'
}

interface ViewCommon {
  /** Up to 4 short parts of what is shown, such as a project and a period, of at most 80 characters. */
  scope?: string[]
  /** Up to 12 buttons at the foot. */
  actions?: ViewAction[]
}

export interface ViewRow {
  /** Unique in the list, at most 128 characters. */
  id: string
  /** At most 200 characters. */
  title: string
  /** At most 300 characters; line breaks are kept, up to three lines shown. */
  subtitle?: string
  /** The subtitle in the code face. */
  mono?: boolean
  icon?: ViewIcon
  /** At most 4. */
  badges?: ViewBadge[]
  /** A figure at the row's end, at most 40 characters. */
  end?: string
  /** At most 4. The first runs when the row is clicked; every one is in the row's menu. */
  actions?: ViewAction[]
}

/** For a view of kind `list`. Rows past 200 are dropped. */
export interface ListViewData extends ViewCommon {
  rows: ViewRow[]
  empty?: { title: string; description?: string }
}

/** For a view of kind `detail`. */
export interface DetailViewData extends ViewCommon {
  title?: string
  /** Line breaks are kept. */
  subtitle?: string
  icon?: ViewIcon
  badges?: ViewBadge[]
  /** Up to 50 labels with values of at most 500 characters; line breaks in a value are kept. */
  fields?: { label: string; value: string; mono?: boolean }[]
  /** Plain Markdown of at most 20,000 characters, drawn as a reply is; HTML is not drawn. */
  body?: string
}

interface FormFieldBase {
  /** Unique in the form, as `values` names it. */
  key: string
  label: string
  description?: string
}

export type FormField =
  | (FormFieldBase & { type: 'switch'; value?: boolean })
  | (FormFieldBase & {
      type: 'choice'
      /** Up to 50. */
      options: { value: string; label: string }[]
      value?: string
    })
  | (FormFieldBase & {
      type: 'text'
      value?: string
      placeholder?: string
      /** At most 2,000; 500 when left out. */
      maxLength?: number
      /** The form cannot be sent while it is empty. */
      required?: boolean
    })

/** For a view of kind `form`: up to 30 fields. Every action of the view is told the values. */
export interface FormViewData extends ViewCommon {
  fields: FormField[]
  /** The button that sends the values; it may not open a view. */
  submit: ViewAction
}

/** For a view of kind `actions`: one to 12 buttons, one per line. */
export interface ActionsViewData extends ViewCommon {
  /** At most 500 characters; line breaks are kept. */
  text?: string
  actions: ViewAction[]
}

export type ViewData = ListViewData | DetailViewData | FormViewData | ActionsViewData

/**
 * What an action may answer. `error` refuses it, in the script's own words; `notice` is shown after
 * it; `open` goes to another view of the plugin instead of reloading the one that was shown. For
 * an action run from Search, `open` names a view the manifest marks as a `pane`, which opens as a
 * tab of the side panel.
 */
export interface ViewActionResult {
  notice?: string
  error?: string
  open?: { view: string; params?: Record<string, string> }
}

/** What the script is asked on `mention.search`: the user typed `@` and then `query`. */
export interface MentionSearchRequest {
  /** The id the manifest declares the source by. */
  source: string
  /** What follows the `@`, at most 200 characters; empty right after the `@`. */
  query: string
  locale: 'en' | 'zh-CN'
}

/** What the script is asked on `mention.content`: the user chose one of the items it listed. */
export interface MentionContentRequest {
  source: string
  /** The `id` of the item. */
  item: string
  locale: 'en' | 'zh-CN'
}

/** What the script is asked on `link.card`: an address the manifest's patterns name. */
export interface LinkCardRequest {
  /** The id the manifest declares the kind of link by. */
  link: string
  url: string
  /** What the pattern's `{name}` parts matched, decoded, at most 200 characters each. */
  match: Record<string, string>
  locale: 'en' | 'zh-CN'
}

export interface MentionItem {
  /** Unique in the answer, at most 128 characters; sent back as `mention.content`'s `item`. */
  id: string
  /** At most 200 characters. */
  title: string
  /** At most 300 characters, in the code face. */
  subtitle?: string
  /** A short figure at the row's end, such as a state, at most 40 characters. */
  end?: string
  icon?: ViewIcon
  /**
   * The word written after the `@` in the message: letters and digits, with `.`, `_`, `#`, `/` and
   * `-` between them, at most 40 characters. Made from the id or the title when left out or unusable.
   */
  word?: string
}

/** What `mention.search` answers: up to 20 items, the rest dropped. */
export interface MentionSearchResult {
  items: MentionItem[]
}

/** What `mention.content` answers: what the agent reads of the item. */
export interface MentionContent {
  /** At most 16,000 characters; one message takes 48,000 of all the items it mentions. */
  text: string
  /** At most 200 characters, shown beside the plugin's name; the item's title when left out. */
  title?: string
}

/** What `link.card` answers: the card the link shows on hover, and its label in a line. */
export interface LinkCard {
  /** At most 60 characters; the short form of a bare address in a line, such as an issue key. */
  label?: string
  /** At most 200 characters. */
  title: string
  /** At most 300 characters. */
  subtitle?: string
  icon?: ViewIcon
  /** Up to 3 are drawn; the first is the state in the card's head. */
  badges?: ViewBadge[]
  /** Up to 4. */
  fields?: { label: string; value: string; mono?: boolean }[]
  /** Plain text of at most 400 characters. */
  body?: string
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
  /**
   * One of the plugin's settings was set, in Settings or by an agent. A secret's value is never
   * sent: `value` is null and `secret` true, and the script reads it with `settings.secret`.
   */
  'settings.changed': { key: string; secret: boolean; value: string | boolean | null }
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
  /**
   * One of Kettu's notices that the user sent to a channel the manifest declares under `channels`,
   * which wakes the script for it. Kettu's own notice has gone before it is told, and a listener
   * that is not done within 2 s is stopped, so a channel never delays anything. No notice is sent
   * to a channel until the user picks its kinds on the plugin's page in Settings.
   */
  'channel.notice': ChannelNotice
  /**
   * A hook that needs no permission: a view the manifest declares under `views` was opened or
   * refreshed. The first listener that returns data answers, in the shape the view's kind takes;
   * a window draws it with Kettu's own components. The script is woken by the view, and the
   * answer may take as long as a call (30 seconds); one that does not fit shows as an error in
   * that view alone.
   */
  'view.data': ViewRequest
  /**
   * A hook that needs no permission: one of a view's actions ran. The first listener that returns
   * decides what the window shows, and a listener that returns nothing means it went well; the
   * view is read again unless the answer opens another.
   */
  'view.action': ViewActionRequest
  /**
   * A hook that needs no permission: an action the manifest declares under `actions` was run from
   * Search. The first listener that returns decides what the window shows; one that returns
   * nothing means it went well. Answered like `view.action`, within the same limits.
   */
  'action.run': ActionRunRequest
  /**
   * A hook that needs no permission, for a source the manifest declares under `mentions`, which
   * needs `prompt.attach`: the user typed an `@` in the composer. The first listener that returns
   * items answers; the menu shows them in a group of the plugin's own, beside the project's files,
   * and never waits for it. A listener that is not done in 3 seconds is skipped. When none returns
   * items and one threw, the menu shows its message, as plain text cut at 300 characters.
   */
  'mention.search': MentionSearchRequest
  /**
   * A hook for the same sources: the message that mentions one of the items is being sent. The
   * first listener that returns text adds it to the message as an attachment of the plugin, which
   * the thread shows under the message; what the user wrote is never changed. Answered within 5
   * seconds, or the message goes with a line saying the item could not be added.
   */
  'mention.content': MentionContentRequest
  /**
   * A hook for a link the manifest declares under `links`, whose patterns name only hosts the
   * plugin has `network:` access to: a reply holds an address of that kind and is on screen. The
   * first listener that returns a card answers; replies draw the link as a reference with that
   * card on hover. A listener that is not done in 3 seconds is skipped and the link stays plain; one
   * that throws leaves it plain too, and its message, cut at 300 characters, shows on hover.
   */
  'link.card': LinkCardRequest
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
  'view.data': ViewData | void
  'view.action': ViewActionResult | void
  'action.run': ViewActionResult | void
  'mention.search': MentionSearchResult | void
  'mention.content': MentionContent | void
  'link.card': LinkCard | void
}

/**
 * A tool the manifest declares under `tools`, which needs the `tools` permission, is a function the
 * script exports under the tool's name. It gets the arguments as one object, already checked
 * against the declared schema, and answers with the text the agent reads: a string, or any value,
 * which is sent as JSON. A throw, a crash or an answer past the time limit is an error the agent
 * reads; it never waits for ever. Agents may call it only while the plugin is on.
 *
 *     exports.lookup = async ({ query }) => `Nothing found for ${query}`
 */
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
