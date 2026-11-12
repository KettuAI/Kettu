import { create } from 'zustand'
import type { ReportRecording } from '@shared/ipc'
import {
  REPORT_ERROR_MAX,
  type ReportContext,
  type ReportExtra,
  type ReportRange,
} from '@shared/report'

/** A report an agent drafted, which the dialog answers once it is sent or saved. */
export interface ReportEntryRef {
  sessionId: string
  entryId: string
}

/** The report dialog as opened: for which host, from where, with what chosen already. */
export interface ReportDialog {
  /** The other host the report is about; null for this computer, or the web client's host. */
  hostId: string | null
  context: ReportContext | null
  range: ReportRange
  extras: ReportExtra[]
  /** The description it starts with, such as an agent's draft. */
  description?: string
  /** The agent's drafted report it was opened from, which sending or saving answers. */
  entry?: ReportEntryRef
  /** Starts the dialog afresh each time it opens. */
  key: number
}

interface ReportState {
  dialog: ReportDialog | null
  recording: ReportRecording | null
}

export const useReportStore = create<ReportState>()(() => ({ dialog: null, recording: null }))

/**
 * Opens the report dialog. The window is captured first, as it looks before the dialog covers it,
 * for the screenshot the user may add.
 */
export async function openReport(options: Partial<Omit<ReportDialog, 'key'>> = {}): Promise<void> {
  const hostId = options.hostId ?? null
  if (hostId === null) {
    await window.kettu.report.capture().catch((e: unknown) => console.warn('No screenshot', e))
  }
  useReportStore.setState({
    dialog: {
      hostId,
      context: options.context
        ? { ...options.context, error: options.context.error?.slice(0, REPORT_ERROR_MAX) ?? null }
        : null,
      range: options.range ?? { kind: 'hour' },
      extras: options.extras ?? [],
      ...(options.description !== undefined ? { description: options.description } : {}),
      ...(options.entry ? { entry: options.entry } : {}),
      key: Date.now(),
    },
  })
}

export function closeReport(): void {
  useReportStore.setState({ dialog: null })
}

/** Follows the recording of steps to reproduce, which main keeps across reloads. */
export function watchRecording(): () => void {
  void window.kettu.report.recording().then((recording) => useReportStore.setState({ recording }))
  return window.kettu.report.onRecording((recording) => useReportStore.setState({ recording }))
}
