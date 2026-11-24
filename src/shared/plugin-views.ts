// Plugin views, format 1. A plugin declares its views in its manifest, and its script answers with
// the data of one when it is opened; Kettu draws that data with its own components and never runs
// the plugin's code in a window. A view has one of four kinds, and each draws one shape of data.
// A view may also be a pane, which opens as a tab of the side panel, and a plugin may declare
// actions that Search lists and that run its script.

/** The version of the view format. A version only ever adds fields, so Kettu passes over ones it does not know. */
export const PLUGIN_VIEW_FORMAT = 1

export const PLUGIN_VIEW_KINDS = ['list', 'detail', 'form', 'actions'] as const
export type PluginViewKind = (typeof PLUGIN_VIEW_KINDS)[number]

export function isPluginViewKind(value: unknown): value is PluginViewKind {
  return (PLUGIN_VIEW_KINDS as readonly unknown[]).includes(value)
}

/** What a script is asked, as events its listeners answer. */
export const PLUGIN_VIEW_EVENTS = ['view.data', 'view.action', 'action.run'] as const

/** The icons a view may use, by name; one it does not know is left out. */
export const PLUGIN_VIEW_ICONS = [
  'alert',
  'bell',
  'branch',
  'bug',
  'calendar',
  'chart',
  'check',
  'clock',
  'code',
  'comment',
  'database',
  'file',
  'flag',
  'folder',
  'globe',
  'info',
  'link',
  'list',
  'lock',
  'mail',
  'play',
  'plus',
  'pull-request',
  'reload',
  'rocket',
  'search',
  'settings',
  'sparkles',
  'star',
  'tag',
  'tool',
  'trash',
  'user',
] as const
export type PluginViewIcon = (typeof PLUGIN_VIEW_ICONS)[number]

export function isPluginViewIcon(value: unknown): value is PluginViewIcon {
  return (PLUGIN_VIEW_ICONS as readonly unknown[]).includes(value)
}

export const PLUGIN_VIEW_TONES = ['neutral', 'info', 'success', 'warning', 'danger'] as const
export type PluginViewTone = (typeof PLUGIN_VIEW_TONES)[number]

/** A view's id in a manifest, which also names what wakes the plugin when it opens. */
export const PLUGIN_VIEW_ID = /^[a-z][a-z0-9-]{0,39}$/
/** What a script is told of the view that wakes it: `view:` and its id. */
export const PLUGIN_VIEW_TRIGGER = 'view:'

export function viewTrigger(viewId: string): string {
  return `${PLUGIN_VIEW_TRIGGER}${viewId}`
}

/** What a script is told of the declared action that wakes it: `action:` and its id. */
export const PLUGIN_ACTION_TRIGGER = 'action:'

export function actionTrigger(actionId: string): string {
  return `${PLUGIN_ACTION_TRIGGER}${actionId}`
}

export const PLUGIN_VIEW_PARAM_KEY = /^[a-z][A-Za-z0-9_]{0,31}$/
export const PLUGIN_ACTION_ID = /^[A-Za-z0-9_.:-]{1,64}$/
export const PLUGIN_FIELD_KEY = /^[a-z][a-zA-Z0-9_]{0,63}$/

/**
 * What one view may hold. A text over its limit is cut; more rows than `rows` are dropped and the
 * list says so; any other list over its limit is refused, with the reason.
 */
export const PLUGIN_VIEW_LIMITS = {
  /** Views one plugin declares. */
  views: 16,
  /** Actions one plugin declares for Search. */
  searchActions: 24,
  params: 8,
  paramValue: 200,
  rows: 200,
  rowId: 128,
  title: 200,
  subtitle: 300,
  end: 40,
  scope: 4,
  scopePart: 80,
  badges: 4,
  badgeText: 40,
  rowActions: 4,
  actions: 12,
  actionLabel: 60,
  actionDescription: 200,
  confirm: 300,
  fields: 50,
  fieldLabel: 80,
  fieldValue: 500,
  body: 20_000,
  formFields: 30,
  formLabel: 120,
  formDescription: 300,
  options: 50,
  optionValue: 200,
  placeholder: 120,
  textValue: 2_000,
  textDefaultMax: 500,
  text: 500,
  emptyTitle: 120,
  emptyDescription: 300,
  notice: 300,
  error: 300,
} as const

/** What a manifest declares of a view; the script gives what it shows. */
export interface PluginViewDecl {
  id: string
  kind: PluginViewKind
  /** By language tag, such as `en` and `zh-CN`; at least one. */
  title: Record<string, string>
  description?: Record<string, string>
  icon?: PluginViewIcon
  /** The view is a pane: the side panel lists it and opens it as a tab. */
  pane?: true
}

/** What a manifest declares of an action Search lists; its script runs it. */
export interface PluginActionDecl {
  id: string
  /** By language tag, such as `en` and `zh-CN`; at least one, each at most `actionLabel` long. */
  title: Record<string, string>
  /** Each at most `actionDescription` long. */
  description?: Record<string, string>
  icon?: PluginViewIcon
}

/** The parameters a view is opened with, which its script reads. */
export type PluginViewParams = Record<string, string>

export interface PluginViewBadge {
  text: string
  tone?: PluginViewTone
}

/** A button or a row's action: it runs the script's action, or opens another view of the plugin. */
export interface PluginViewAction {
  /** What the script is told when it runs; unused by an action that opens a view. */
  id: string
  label: string
  icon?: PluginViewIcon
  /** A line under the label, where the view has room for one. */
  description?: string
  /** Drawn as the primary button; at most one of a view's actions. */
  primary?: boolean
  /** Asked about before it runs. */
  destructive?: boolean
  /** The question of that confirmation. */
  confirm?: string
  disabled?: boolean
  /** Goes to another view of the same plugin without running the script's action. */
  open?: { view: string; params?: PluginViewParams }
}

export interface PluginViewRow {
  id: string
  title: string
  subtitle?: string
  /** The subtitle in the code face, for a path or a version. */
  mono?: boolean
  icon?: PluginViewIcon
  badges?: PluginViewBadge[]
  /** A figure at the row's end. */
  end?: string
  /** The first runs when the row is clicked; every one is in the row's menu. */
  actions?: PluginViewAction[]
}

interface ViewCommon {
  /** The short parts of what the view shows, such as a project and a period, on its context bar. */
  scope?: string[]
  /** Buttons at the foot. */
  actions?: PluginViewAction[]
}

export interface PluginListContent extends ViewCommon {
  kind: 'list'
  rows: PluginViewRow[]
  /** Rows past the limit were dropped. */
  truncated?: boolean
  empty?: { title: string; description?: string }
}

export interface PluginViewField {
  label: string
  value: string
  mono?: boolean
}

export interface PluginDetailContent extends ViewCommon {
  kind: 'detail'
  title?: string
  subtitle?: string
  icon?: PluginViewIcon
  badges?: PluginViewBadge[]
  fields?: PluginViewField[]
  /** Plain Markdown, drawn as the app draws a reply's; no HTML. */
  body?: string
}

interface FormFieldCommon {
  key: string
  label: string
  description?: string
}

export type PluginFormField =
  | (FormFieldCommon & { type: 'switch'; value: boolean })
  | (FormFieldCommon & {
      type: 'choice'
      options: { value: string; label: string }[]
      value: string
    })
  | (FormFieldCommon & {
      type: 'text'
      value: string
      placeholder?: string
      maxLength: number
      required?: boolean
    })

/** The values a form sends: a switch's boolean, a choice's value or a text. */
export type PluginFormValues = Record<string, string | boolean>

export interface PluginFormContent extends ViewCommon {
  kind: 'form'
  fields: PluginFormField[]
  /** The button that sends the values; `actions` are others that send them too. */
  submit: PluginViewAction
}

export interface PluginActionsContent extends ViewCommon {
  kind: 'actions'
  text?: string
  actions: PluginViewAction[]
}

export type PluginViewContent =
  PluginListContent | PluginDetailContent | PluginFormContent | PluginActionsContent

/**
 * Why a view or an action did not come out. `not_found`: the view is not one of a plugin that is on.
 * `disabled`: the plugin crashed too often. `crashed`: its script was stopped for passing a limit.
 * `timeout`: it did not answer in time. `unavailable`: the plugin host is not running.
 * `failed`: its script threw, or has no listener. `invalid`: what it answered is not a view.
 * `request_failed`: the window's own request to the host failed, which the host never sends.
 */
export type PluginViewErrorCode =
  | 'not_found'
  | 'disabled'
  | 'crashed'
  | 'timeout'
  | 'unavailable'
  | 'failed'
  | 'invalid'
  | 'request_failed'

export interface PluginViewError {
  code: PluginViewErrorCode
  /** The technical detail, such as the script's own message or the path of the bad field. */
  detail?: string
}

export type PluginViewResult =
  { ok: true; view: PluginViewContent } | { ok: false; error: PluginViewError }

/** What an action did: it may carry a message to show, or a view to go to. */
export type PluginViewActionResult =
  | { ok: true; notice?: string; open?: { view: string; params?: PluginViewParams } }
  | { ok: false; error: PluginViewError }

/** What the script is asked on `view.data`. */
export interface PluginViewDataRequest {
  view: string
  params: PluginViewParams
  locale: string
}

/** What the script is asked on `view.action`. */
export interface PluginViewActionRequest extends PluginViewDataRequest {
  action: string
  /** The row whose action it is. */
  row?: string
  /** The form's values, for an action of a form view. */
  values?: PluginFormValues
}

/** What the script is asked on `action.run`. */
export interface PluginActionRunRequest {
  action: string
  locale: string
}

/** What `plugins.viewAction` takes beyond the view. */
export interface PluginViewActionInput {
  action: string
  row?: string
  values?: PluginFormValues
}
