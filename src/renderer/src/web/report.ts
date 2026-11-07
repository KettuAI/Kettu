// Problem reports in the web client: its host builds the bundle with its own logs, and the page
// keeps it to show and to hand the browser as a download.

import type { KettuApi, ReportPrepareResult } from '@shared/ipc'
import type { ReportFileInfo, ReportFileView } from '@shared/report'
import { downloadFile } from './media'
import type { AdminCall } from './themes'

const VIEW_CHARS = 2 * 1024 * 1024

interface Kept {
  bytes: Uint8Array<ArrayBuffer>
  files: ReportFileInfo[]
  zip: import('jszip') | null
}

export function webReports(admin: AdminCall): KettuApi['report'] {
  const kept = new Map<string, Kept>()
  const zipOf = async (entry: Kept): Promise<import('jszip')> => {
    if (entry.zip) return entry.zip
    const { default: JSZip } = await import('jszip')
    entry.zip = await JSZip.loadAsync(entry.bytes)
    return entry.zip
  }
  return {
    // The page cannot capture itself; the dialog offers no screenshot here.
    capture: async () => {},
    prepare: async (request): Promise<ReportPrepareResult> => {
      const answer = await admin('host.report', { request })
      if (!answer.ok) return { ok: false, reason: answer.reason }
      const id = crypto.randomUUID()
      kept.set(id, {
        bytes: Uint8Array.from(atob(answer.zip), (char) => char.charCodeAt(0)),
        files: answer.files,
        zip: null,
      })
      return { ok: true, report: { id, files: answer.files, size: answer.size } }
    },
    adopt: async () => ({ ok: false, reason: 'failed' }),
    view: async (id, path): Promise<ReportFileView> => {
      const entry = kept.get(id)
      const info = entry?.files.find((file) => file.path === path)
      if (!entry || !info) throw new Error('This report is no longer prepared')
      if (info.kind === 'binary') return { kind: 'binary' }
      const file = (await zipOf(entry)).file(path)
      if (!file) throw new Error('The bundle has no such file')
      if (info.kind === 'image') {
        return { kind: 'image', dataUrl: `data:image/png;base64,${await file.async('base64')}` }
      }
      const text = await file.async('string')
      return { kind: 'text', text: text.slice(0, VIEW_CHARS), truncated: text.length > VIEW_CHARS }
    },
    save: async (id) => {
      const entry = kept.get(id)
      if (!entry) throw new Error('This report is no longer prepared')
      const name = `kettu-report-${new Date().toISOString().slice(0, 10)}.zip`
      downloadFile(new Blob([entry.bytes], { type: 'application/zip' }), name)
      return name
    },
    discard: async (id) => void kept.delete(id),
    // Recording steps and the notice of an unexpected quit belong to the desktop app.
    recording: async () => null,
    record: async () => null,
    onRecording: () => () => {},
    crashNotice: async () => null,
    dismissCrashNotice: async () => {},
  }
}
