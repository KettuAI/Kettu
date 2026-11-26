// agy's Plan mode as Kettu's plan card. agy 1.5.9 asks for no approval over ACP: in Plan mode it
// writes its plan as a Markdown file in its own folder, marked for the user's feedback, and asks
// for approval in its reply. Its own terminal approves by sending `[Approved] <file name>` and stays
// in Plan mode; Kettu sends the same once it has moved to the mode the user builds in.

import type * as acp from '@agentclientprotocol/sdk/unstable'
import type { ConfigOption, PermissionOption } from '@shared/thread'
import { t } from '../i18n'
import { compareVersions } from '../versions'

export const AGY_PLAN_VERSION = '1.5.9'
export const MODE_OPTION = 'mode'
export const PLAN_MODE = 'plan'
export const KEEP_PLANNING = 'keep_planning'

// The ids Claude Code's plan options have, which the plan card draws as modes to build in.
const BUILD_OPTIONS: Readonly<Record<string, string>> = {
  default: 'exit-plan-default',
  'accept-edits': 'exit-plan-accept-edits',
  auto: 'exit-plan-auto',
}

const OWN_FILE = /(?:^|\/)\.gemini\/antigravity(?:-cli)?\/brain\/([^/]+)\/[^/]+\.md$/

export function plansAgy(version: string | null): boolean {
  return version !== null && compareVersions(version, AGY_PLAN_VERSION) >= 0
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * The plan file a call writes in session `sessionId`'s own folder: one agy marks for the user's
 * feedback, or `known`, the session's plan before; null for any other call.
 */
export function planWrite(
  update: acp.ToolCallUpdate,
  sessionId: string,
  known: string | null,
): string | null {
  const paths = (update.locations ?? []).map((location) => location.path)
  if (paths.length !== 1) return null
  const file = paths[0]!
  const own = OWN_FILE.exec(file.replace(/\\/g, '/'))
  if (own?.[1] !== sessionId) return null
  const meta = record(record(update.rawInput)?.ArtifactMetadata)
  return meta?.RequestFeedback === true || file === known ? file : null
}

/** The current value of the session's mode, or null when it has none. */
export function currentMode(config: readonly ConfigOption[]): string | null {
  const option = config.find((o) => o.id === MODE_OPTION && o.type === 'select')
  return typeof option?.value === 'string' ? option.value : null
}

/**
 * A plan's approval: agy's modes to build in, in its order, with the first of `preferred` it
 * offers chosen, else Default; or Keep planning with a note. Null when the session offers none.
 */
export function planOptions(
  config: readonly ConfigOption[],
  preferred: readonly (string | null)[],
): PermissionOption[] | null {
  const option = config.find((o) => o.id === MODE_OPTION && o.type === 'select')
  const offered = (option?.choices ?? []).filter((choice) => BUILD_OPTIONS[choice.value])
  if (offered.length === 0) return null
  const values = offered.map((choice) => choice.value)
  const chosen = [...preferred, 'default'].find((mode) => mode !== null && values.includes(mode))
  return [
    ...offered.map((choice): PermissionOption => {
      const option: PermissionOption = {
        id: BUILD_OPTIONS[choice.value]!,
        name: choice.name,
        kind: 'allow_once',
      }
      if (choice.description) option.description = choice.description
      if (choice.value === (chosen ?? values[0])) option.preferred = true
      return option
    }),
    {
      id: KEEP_PLANNING,
      name: t('permission.exitPlan.keepPlanning'),
      kind: 'reject_once',
      note: true,
    },
  ]
}

/** The mode an option of `planOptions` builds in, or null for Keep planning. */
export function buildMode(optionId: string): string | null {
  return Object.entries(BUILD_OPTIONS).find(([, id]) => id === optionId)?.[0] ?? null
}

/** What agy's own terminal sends when the user approves the plan in `file`. */
export function approved(file: string): string {
  return `[Approved] ${file.replace(/\\/g, '/').split('/').pop()}`
}
