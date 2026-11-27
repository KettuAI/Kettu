import type { TFunction } from 'i18next'
import type { ActiveControl, ControlAsk, SurfaceControl } from '@shared/control'
import type { BackgroundTaskView, ComputerUseView } from '@shared/thread'
import { timeLeft } from '@renderer/lib/format'

export type DockPriority = 1 | 2 | 3 | 4 | 5
export type DockTone = 'amber' | 'computer' | 'neutral'
export type DockGroupKind = 'terminals' | 'devices'
export type DockPopoverMode = null | 'rest' | 'primary-group'

export interface BackgroundWork {
  commands: number
  subagents: number
  monitors: number
  scheduled: number
  reportsBack: boolean
  unnamed: boolean
}

export interface ScheduleHint {
  /** Nearest fire timestamp (ms) when a single one-shot timer is running and no cron runs. */
  fireAt: number | null
  /** Cron expression when a single recurring cron is running and no one-shot timer runs. */
  cron: string | null
}

export interface DockGroupItem {
  id: string
  name: string
  acting: boolean
  surface: 'terminal' | 'device'
}

export interface DockTerminalInput {
  id: string
  name: string
  control: SurfaceControl
  waiting: 'password' | null
}

export interface DockDeviceInput {
  id: string
  name: string
  control: ActiveControl
}

export interface DockInput {
  computer: ComputerUseView | null
  computerWaitingApp: string | null
  computerStopping: boolean
  browser: ActiveControl | null
  devices: readonly DockDeviceInput[]
  terminals: readonly DockTerminalInput[]
  background: BackgroundWork | null
  hasAgent: boolean
}

export type DockEntry =
  | {
      key: string
      kind: 'computer-waiting'
      priority: 1
      tone: 'amber'
      app: string
    }
  | {
      key: string
      kind: 'terminal-password'
      priority: 1
      tone: 'amber'
      id: string
      name: string
    }
  | {
      key: string
      kind: 'browser-asks'
      priority: 1
      tone: 'amber'
      ask: ControlAsk
    }
  | {
      key: string
      kind: 'device-asks'
      priority: 1
      tone: 'amber'
      id: string
      name: string
      ask: ControlAsk
    }
  | {
      key: string
      kind: 'terminal-asks'
      priority: 1
      tone: 'amber'
      id: string
      name: string
      ask: ControlAsk
    }
  | {
      key: string
      kind: 'computer-stopping'
      priority: 2
      tone: 'computer'
    }
  | {
      key: string
      kind: 'computer-agent'
      priority: 2
      tone: 'computer'
      app: string | null
      appPath: string | null
      looking: boolean
    }
  | {
      key: string
      kind: 'computer-you'
      priority: 3
      tone: 'neutral'
      app: string | null
    }
  | {
      key: string
      kind: 'browser-you'
      priority: 3
      tone: 'neutral'
    }
  | {
      key: string
      kind: 'device-you'
      priority: 3
      tone: 'neutral'
      id: string
      name: string
    }
  | {
      key: string
      kind: 'terminal-you'
      priority: 3
      tone: 'neutral'
      id: string
      name: string
    }
  | {
      key: string
      kind: 'browser-agent'
      priority: 4
      tone: 'neutral'
      acting: boolean
    }
  | {
      key: string
      kind: 'device-agent'
      priority: 4
      tone: 'neutral'
      id: string
      name: string
      acting: boolean
    }
  | {
      key: string
      kind: 'device-group'
      groupKind: 'devices'
      priority: 4
      tone: 'neutral'
      items: DockGroupItem[]
    }
  | {
      key: string
      kind: 'terminal-agent'
      priority: 4
      tone: 'neutral'
      id: string
      name: string
      acting: boolean
    }
  | {
      key: string
      kind: 'terminal-group'
      groupKind: 'terminals'
      priority: 4
      tone: 'neutral'
      items: DockGroupItem[]
    }
  | {
      key: string
      kind: 'background'
      priority: 5
      tone: 'neutral'
      work: BackgroundWork
    }

export type DockGroupEntry = Extract<DockEntry, { kind: 'terminal-group' | 'device-group' }>

export function isDockGroupEntry(entry: DockEntry | null | undefined): entry is DockGroupEntry {
  return entry?.kind === 'terminal-group' || entry?.kind === 'device-group'
}

/**
 * Extracts a live schedule hint for a single running timer or a single running cron task so the
 * dock can show a live countdown or cron expression when only one scheduled item is active.
 */
export function selectScheduleHint(tasks: readonly BackgroundTaskView[] | undefined): ScheduleHint {
  if (!tasks || tasks.length === 0) return { fireAt: null, cron: null }
  let fireAt: number | null = null
  let timerCount = 0
  let cron: string | null = null
  let cronCount = 0
  for (const task of tasks) {
    if (task.status !== 'running' || !task.schedule) continue
    if (task.schedule.mode === 'timer' && task.schedule.fireAt !== undefined) {
      timerCount++
      if (fireAt === null || task.schedule.fireAt < fireAt) fireAt = task.schedule.fireAt
    } else if (task.schedule.mode === 'cron' && task.schedule.cron) {
      cronCount++
      if (cron === null) cron = task.schedule.cron
    }
  }
  if (timerCount === 1 && cronCount === 0) return { fireAt, cron: null }
  if (cronCount === 1 && timerCount === 0) return { fireAt: null, cron }
  return { fireAt: null, cron: null }
}

export interface BackgroundDisplay {
  /** Primary concise label for a full dock row (e.g. "2 sub-agents running"). */
  headline: string
  /** Compact phrase for the Tier 2 summary strip (e.g. "2 sub-agents"). */
  summary: string
  /** Optional secondary hint when the background work reports back on completion. */
  hint: string | null
  /** Whether the display depends on a live countdown timer. */
  hasCountdown: boolean
}

/**
 * Formats background work into concise primary and summary phrases, preserving full support for
 * sub-agents, shell commands, monitors, scheduled timers/crons, and unnamed tasks.
 */
export function formatBackgroundDisplay(
  t: TFunction<'session'>,
  work: BackgroundWork,
  hint: ScheduleHint,
  nowMs?: number,
): BackgroundDisplay {
  const { commands, subagents, monitors, scheduled } = work
  const total = commands + subagents + monitors + scheduled
  const reportsHint = work.reportsBack ? t('stillRunning.reportsBack') : null

  if (total === 0) {
    return {
      headline: t('stillRunning.dockUnnamed'),
      summary: t('stillRunning.summaryUnnamed'),
      hint: reportsHint,
      hasCountdown: false,
    }
  }

  if (monitors === 0 && scheduled === 0) {
    const agents = t('stillRunning.subagents', { count: subagents })
    const shell = t('stillRunning.commands', { count: commands })
    const what =
      commands === 0
        ? agents
        : subagents === 0
          ? shell
          : t('stillRunning.both', { subagents: agents, commands: shell })
    return {
      headline: t('stillRunning.dockRunning', { work: what }),
      summary: what,
      hint: reportsHint,
      hasCountdown: false,
    }
  }

  const parts: string[] = []
  if (subagents > 0) parts.push(t('stillRunning.subagents', { count: subagents }))
  if (commands > 0) parts.push(t('stillRunning.commands', { count: commands }))
  if (monitors > 0) parts.push(t('stillRunning.monitors', { count: monitors }))

  let hasCountdown = false
  if (scheduled === 1 && hint.fireAt !== null) {
    hasCountdown = true
    const left = timeLeft(Math.max(0, hint.fireAt - (nowMs ?? Date.now())))
    parts.push(t('stillRunning.timerLeft', { left }))
  } else if (scheduled > 0) {
    parts.push(
      scheduled === 1 && hint.cron !== null
        ? t('stillRunning.cronExpr', { cron: hint.cron })
        : t('stillRunning.scheduled', { count: scheduled }),
    )
  }

  const what = parts.join(t('stillRunning.listSeparator'))
  return {
    headline: t('stillRunning.dockRunning', { work: what }),
    summary: what,
    hint: reportsHint,
    hasCountdown,
  }
}

/**
 * Formats the preview suffix for a folded group (first 2 names, plus overflow marker when > 2).
 */
export function formatGroupPreview(
  t: TFunction<'control'>,
  items: readonly DockGroupItem[],
): string {
  const sep = t('dock.nameSeparator')
  const shown = items
    .slice(0, 2)
    .map((item) => item.name)
    .join(sep)
  const more = items.length - 2
  if (more > 0) return t('dock.groupPreviewMore', { names: shown, more })
  return t('dock.groupPreview', { names: shown })
}

/**
 * Builds the unified live dock entry list sorted strictly from P1 (needs immediate user action)
 * down to P5 (background still-running tasks). P1 items are never folded into groups; P4 agent
 * terminals or devices fold into a single collapsible group when 2 or more are active.
 */
export function buildDockEntries(input: DockInput): DockEntry[] {
  const p1: DockEntry[] = []
  const p2: DockEntry[] = []
  const p3: DockEntry[] = []
  const p4: DockEntry[] = []
  const p5: DockEntry[] = []

  const {
    computer,
    computerWaitingApp,
    computerStopping,
    browser,
    devices,
    terminals,
    background,
    hasAgent,
  } = input

  // Computer use: stopping takes precedence over waiting app, matching ComputerLabel behavior.
  if (computer) {
    if (computerStopping) {
      p2.push({
        key: 'computer:stopping',
        kind: 'computer-stopping',
        priority: 2,
        tone: 'computer',
      })
    } else if (computerWaitingApp) {
      p1.push({
        key: 'computer:waiting',
        kind: 'computer-waiting',
        priority: 1,
        tone: 'amber',
        app: computerWaitingApp,
      })
    } else if (hasAgent) {
      if (computer.control === 'you') {
        p3.push({
          key: 'computer:you',
          kind: 'computer-you',
          priority: 3,
          tone: 'neutral',
          app: computer.app,
        })
      } else {
        p2.push({
          key: 'computer:agent',
          kind: 'computer-agent',
          priority: 2,
          tone: 'computer',
          app: computer.app,
          appPath: computer.appPath ?? null,
          looking: !!computer.app && computer.action === 'read',
        })
      }
    }
  }

  if (hasAgent) {
    // Browser
    if (browser) {
      if (browser.kind === 'asks') {
        p1.push({
          key: 'browser:asks',
          kind: 'browser-asks',
          priority: 1,
          tone: 'amber',
          ask: browser.ask,
        })
      } else if (browser.kind === 'you') {
        p3.push({ key: 'browser:you', kind: 'browser-you', priority: 3, tone: 'neutral' })
      } else {
        p4.push({
          key: 'browser:agent',
          kind: 'browser-agent',
          priority: 4,
          tone: 'neutral',
          acting: browser.acting,
        })
      }
    }

    // Devices
    const agentDevices: DockGroupItem[] = []
    for (const device of devices) {
      if (device.control.kind === 'asks') {
        p1.push({
          key: `device:asks:${device.id}`,
          kind: 'device-asks',
          priority: 1,
          tone: 'amber',
          id: device.id,
          name: device.name,
          ask: device.control.ask,
        })
      } else if (device.control.kind === 'you') {
        p3.push({
          key: `device:you:${device.id}`,
          kind: 'device-you',
          priority: 3,
          tone: 'neutral',
          id: device.id,
          name: device.name,
        })
      } else {
        agentDevices.push({
          id: device.id,
          name: device.name,
          acting: device.control.acting,
          surface: 'device',
        })
      }
    }
    if (agentDevices.length === 1) {
      const only = agentDevices[0]!
      p4.push({
        key: `device:agent:${only.id}`,
        kind: 'device-agent',
        priority: 4,
        tone: 'neutral',
        id: only.id,
        name: only.name,
        acting: only.acting,
      })
    } else if (agentDevices.length >= 2) {
      p4.push({
        key: 'group:devices',
        kind: 'device-group',
        groupKind: 'devices',
        priority: 4,
        tone: 'neutral',
        items: agentDevices,
      })
    }

    // Terminals: password requests and asks always stay ungrouped in P1.
    const agentTerminals: DockGroupItem[] = []
    for (const terminal of terminals) {
      if (terminal.waiting === 'password') {
        p1.push({
          key: `terminal:password:${terminal.id}`,
          kind: 'terminal-password',
          priority: 1,
          tone: 'amber',
          id: terminal.id,
          name: terminal.name,
        })
        continue
      }
      if (terminal.control.kind === 'idle') continue
      if (terminal.control.kind === 'asks') {
        p1.push({
          key: `terminal:asks:${terminal.id}`,
          kind: 'terminal-asks',
          priority: 1,
          tone: 'amber',
          id: terminal.id,
          name: terminal.name,
          ask: terminal.control.ask,
        })
      } else if (terminal.control.kind === 'you') {
        p3.push({
          key: `terminal:you:${terminal.id}`,
          kind: 'terminal-you',
          priority: 3,
          tone: 'neutral',
          id: terminal.id,
          name: terminal.name,
        })
      } else {
        agentTerminals.push({
          id: terminal.id,
          name: terminal.name,
          acting: terminal.control.acting,
          surface: 'terminal',
        })
      }
    }
    if (agentTerminals.length === 1) {
      const only = agentTerminals[0]!
      p4.push({
        key: `terminal:agent:${only.id}`,
        kind: 'terminal-agent',
        priority: 4,
        tone: 'neutral',
        id: only.id,
        name: only.name,
        acting: only.acting,
      })
    } else if (agentTerminals.length >= 2) {
      p4.push({
        key: 'group:terminals',
        kind: 'terminal-group',
        groupKind: 'terminals',
        priority: 4,
        tone: 'neutral',
        items: agentTerminals,
      })
    }
  }

  // Background still-running work (P5)
  if (background) {
    p5.push({
      key: 'background',
      kind: 'background',
      priority: 5,
      tone: 'neutral',
      work: background,
    })
  }

  return [...p1, ...p2, ...p3, ...p4, ...p5]
}

/**
 * Reconciles popover visibility and expanded groups against the latest entries so the popover
 * automatically closes when the dock collapses to a single row or the primary group disappears.
 */
export function reconcilePopoverState(
  mode: DockPopoverMode,
  expandedGroups: ReadonlySet<DockGroupKind>,
  entries: readonly DockEntry[],
): { mode: DockPopoverMode; expandedGroups: Set<DockGroupKind> } {
  const primary = entries[0] ?? null
  const rest = entries.slice(1)

  if (mode === 'rest') {
    if (rest.length === 0) return { mode: null, expandedGroups: new Set() }
    const available = new Set<DockGroupKind>()
    for (const entry of rest) {
      if (isDockGroupEntry(entry)) available.add(entry.groupKind)
    }
    const nextExpanded = new Set<DockGroupKind>()
    for (const kind of expandedGroups) {
      if (available.has(kind)) nextExpanded.add(kind)
    }
    return { mode: 'rest', expandedGroups: nextExpanded }
  }

  if (mode === 'primary-group') {
    if (!isDockGroupEntry(primary)) return { mode: null, expandedGroups: new Set() }
    return { mode: 'primary-group', expandedGroups: new Set() }
  }

  return { mode: null, expandedGroups: new Set() }
}
