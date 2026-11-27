import type { TFunction } from 'i18next'
import type { StillRunning } from '@shared/agent-host'
import type { SessionNode } from '@renderer/stores/sessions'

/** What runs on after a turn: background commands, monitors, schedules, sub-agents, or unnamed tasks. */
export type Background = Pick<
  StillRunning,
  'commands' | 'subagents' | 'monitors' | 'scheduled' | 'unnamed'
>

/** Whether `background` has named commands, monitors, schedules, or sub-agents to enumerate. */
export function hasNamedBackground(background: Background): boolean {
  return (
    background.commands +
      background.subagents +
      (background.monitors ?? 0) +
      (background.scheduled ?? 0) >
    0
  )
}

/** What a row's status slot can show. */
export interface RowStatus {
  /** Permission requests waiting for an answer. */
  waiting: number
  failed: boolean
  running: boolean
  /** What runs on after the turn ended, null when nothing does. */
  background: Background | null
  starting: boolean
  unread: boolean
}

const failed = (node: SessionNode): boolean =>
  node.summary.attention === 'error' || node.summary.status === 'failed'

/** What these run on together, null when nothing. */
export function joinBackground(
  items: readonly (Background | null | undefined)[],
): Background | null {
  let commands = 0
  let subagents = 0
  let monitors = 0
  let scheduled = 0
  let unnamed = false
  for (const item of items) {
    commands += item?.commands ?? 0
    subagents += item?.subagents ?? 0
    monitors += item?.monitors ?? 0
    scheduled += item?.scheduled ?? 0
    if (item?.unnamed) unnamed = true
  }
  if (commands + subagents + monitors + scheduled > 0) {
    return {
      commands,
      subagents,
      ...(monitors > 0 ? { monitors } : {}),
      ...(scheduled > 0 ? { scheduled } : {}),
    }
  }
  return unnamed ? { commands: 0, subagents: 0, unnamed: true } : null
}

const sumBackground = (nodes: readonly SessionNode[]): Background | null =>
  joinBackground(nodes.map((node) => node.summary.stillRunning))

/**
 * A row's status: its own, with its sub-agents' waits and runs; with `rolledUp`, as a collapsed
 * parent shows it, the loudest of it and its sub-sessions.
 */
export function rowStatus(node: SessionNode, rolledUp: boolean): RowStatus {
  const own: RowStatus = {
    waiting: node.own.permissionCount,
    failed: failed(node),
    running: node.own.running,
    background: sumBackground([node]),
    starting: node.summary.status === 'starting',
    unread: node.summary.attention === 'unread',
  }
  if (!rolledUp || node.children.length === 0) return own
  return {
    waiting: node.permissionCount,
    failed: own.failed || node.children.some(failed),
    running: node.running,
    background: sumBackground([node, ...node.children]),
    starting: own.starting,
    unread: own.unread || node.children.some((child) => child.summary.attention === 'unread'),
  }
}

/** What runs on, in words: "2 sub-agents, 1 command". */
export function backgroundText(
  t: TFunction<'sidebar'>,
  { commands, subagents, monitors = 0, scheduled = 0 }: Background,
) {
  if (monitors === 0 && scheduled === 0) {
    const agents = t('stillRunning.subagents', { count: subagents })
    const shell = t('stillRunning.commands', { count: commands })
    if (commands === 0) return agents
    if (subagents === 0) return shell
    return t('stillRunning.both', { subagents: agents, commands: shell })
  }
  const parts: string[] = []
  if (subagents > 0) parts.push(t('stillRunning.subagents', { count: subagents }))
  if (commands > 0) parts.push(t('stillRunning.commands', { count: commands }))
  if (monitors > 0) parts.push(t('stillRunning.monitors', { count: monitors }))
  if (scheduled > 0) parts.push(t('stillRunning.scheduled', { count: scheduled }))
  return parts.join(t('stillRunning.listSeparator'))
}
