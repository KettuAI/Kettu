// What a thread's work shows on affectUI's Tool Call Card: each step's glyph, status and time.
// A Tool Call Group reads its cards' own props (icon, status, startedAt, duration) to sum them
// up, so a step's card takes these straight from here.

import { useMemo } from 'react'
import {
  AiBrain01Icon,
  ArrowDataTransferHorizontalIcon,
  ComputerTerminal01Icon,
  Delete02Icon,
  File01Icon,
  FileEditIcon,
  Globe02Icon,
  Layers01Icon,
  RepeatIcon,
  Search01Icon,
  Wrench01Icon,
} from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { ThreadEntry, ToolEntry, ToolKind } from '@shared/thread'
import type { ToolCallLabels, ToolCallStatus } from '@renderer/components/affect/tool-call-card'
import { toolMedia } from '../media/named'
import { toolTime } from '../tool-times'
import { toolLabel } from './helpers'
import { entryPictures, type RowPicture } from './row-pictures'

export const KIND_GLYPH: Record<ToolKind, IconSvgElement> = {
  read: File01Icon,
  edit: FileEditIcon,
  delete: Delete02Icon,
  move: ArrowDataTransferHorizontalIcon,
  search: Search01Icon,
  execute: ComputerTerminal01Icon,
  think: AiBrain01Icon,
  fetch: Globe02Icon,
  switch_mode: RepeatIcon,
  other: Wrench01Icon,
}

export const toolCallStatus = (status: ToolEntry['status']): ToolCallStatus =>
  status === 'completed'
    ? 'success'
    : status === 'failed'
      ? 'error'
      : status === 'cancelled'
        ? 'cancelled'
        : 'running'

const COMPACTION_STATUS = {
  in_progress: 'running',
  completed: 'success',
  failed: 'error',
  cancelled: 'cancelled',
} as const

/** A step's card facts: its glyph, status and, when this window saw it, its time. */
export interface StepFacts {
  glyph: IconSvgElement
  status: ToolCallStatus
  startedAt?: number
  duration?: number
  /** Whether its time is known, so the card shows one. */
  time: boolean
}

export function stepFacts(sessionId: string, entry: ThreadEntry): StepFacts | null {
  if (entry.kind === 'tool') {
    const status = toolCallStatus(entry.status)
    const time = toolTime(sessionId, entry.id)
    return {
      glyph: KIND_GLYPH[entry.toolKind],
      status,
      startedAt: time.startedAt,
      duration: time.durationMs,
      time: status === 'running' ? time.startedAt !== undefined : time.durationMs !== undefined,
    }
  }
  if (entry.kind === 'thought') {
    return {
      glyph: AiBrain01Icon,
      status: entry.streaming ? 'running' : 'success',
      duration: entry.durationMs,
      time: entry.durationMs !== undefined,
    }
  }
  if (entry.kind === 'compaction') {
    return { glyph: Layers01Icon, status: COMPACTION_STATUS[entry.status], time: false }
  }
  return null
}

/**
 * The kinds a run's row stacks: those of its latest steps, each once and up to three, oldest
 * first, each keyed by its latest step so a new step's icon pops in.
 */
export function stackedGlyphs(
  sessionId: string,
  entries: readonly ThreadEntry[],
): { id: string; glyph: IconSvgElement }[] {
  const stack: { id: string; glyph: IconSvgElement }[] = []
  for (let i = entries.length - 1; i >= 0 && stack.length < 3; i--) {
    const entry = entries[i]!
    const glyph = stepFacts(sessionId, entry)?.glyph
    if (glyph && !stack.some((s) => s.glyph === glyph)) stack.unshift({ id: entry.id, glyph })
  }
  return stack
}

/** Whether a call has details to open. */
export function toolHasBody(entry: ToolEntry, projectPath: string): boolean {
  const label = toolLabel(entry, projectPath)
  const command = label.kind === 'command' ? label.target : null
  return (
    entry.content.length > 0 ||
    toolMedia(entry).length > 0 ||
    (!!command && (command.length > 60 || command.includes('\n')))
  )
}

/** The pictures of a run's steps, in thread order. */
export function runPictures(entries: readonly (ThreadEntry | undefined)[]): RowPicture[] {
  return entries.flatMap((entry) => (entry?.kind === 'tool' ? entryPictures(entry) : []))
}

/** The card's and the group's words. */
export function useToolCallLabels(): Partial<ToolCallLabels> {
  const { t } = useTranslation('session')
  return useMemo(
    () => ({
      failed: t('status.failed'),
      cancelled: t('status.cancelled'),
      usingTools: t('toolCall.usingTools'),
      used: (count: number) => t('summary.tool', { count }),
      failedCount: (failed: number) => t('summary.failed', { failed }),
      announce: (name: string, status: ToolCallStatus) =>
        t(`toolCall.announce.${status}`, { name }),
    }),
    [t],
  )
}
