// Building and submitting a problem report, shared by the report dialog and the card of a report an
// agent drafted.

import type { ReportPrepareResult } from '@shared/ipc'
import type { HostAdminResult } from '@shared/remote/host-admin'
import {
  reportSubmitResult,
  type PreparedReport,
  type ReportRequest,
  type ReportSubmitFailure,
  type ReportSubmitResult,
} from '@shared/report'
import type { ProblemReportOutcome } from '@shared/thread'
import { host } from '@renderer/lib/host'
import type { ReportEntryRef } from '@renderer/stores/report'
import { answeredBy } from '../session/entries/helpers'

/** What the report says when it was not submitted, in the `report` namespace. */
export const NOT_SUBMITTED = {
  too_large: 'notSubmitted.tooLarge',
  rate_limited: 'notSubmitted.rateLimited',
  unauthorized: 'notSubmitted.unauthorized',
  signed_out: 'notSubmitted.signedOut',
  network: 'notSubmitted.network',
  failed: 'notSubmitted.failed',
} as const satisfies Record<ReportSubmitFailure, string>

/** A bundle as this window keeps it; `ref` is the bundle as another host keeps it, or null. */
export type Bundle = { report: PreparedReport; ref: string | null }

/**
 * A bundle for another host comes over its channel, and this computer's main keeps it the same;
 * `ref` is the bundle as that host keeps it, to submit with its sign-in.
 */
export async function prepare(
  hostId: string | null,
  request: ReportRequest,
): Promise<{ result: ReportPrepareResult; ref: string | null }> {
  if (hostId === null) return { result: await window.kettu.report.prepare(request), ref: null }
  const answer = (await window.kettu.hosts.request(hostId, 'host.report', {
    request,
  })) as HostAdminResult<'host.report'>
  if (!answer.ok) return { result: { ok: false, reason: answer.reason }, ref: null }
  return { result: await window.kettu.report.adopt(answer.zip), ref: answer.ref }
}

/** Submits what was reviewed, with the sign-in of the host that built it. */
export async function submit(hostId: string | null, bundle: Bundle): Promise<ReportSubmitResult> {
  if (hostId === null) return window.kettu.report.submit(bundle.report.id)
  if (bundle.ref === null) return { ok: false, reason: 'failed' }
  return reportSubmitResult(
    await window.kettu.hosts.request(hostId, 'host.submitReport', { ref: bundle.ref }),
  )
}

/** Records what became of a drafted report; one answered elsewhere first keeps that answer. */
export function answerReportEntry(entry: ReportEntryRef, outcome: ProblemReportOutcome): void {
  host('sessions.answerReport', { ...entry, outcome }).catch((error: unknown) => {
    if (answeredBy(error) === undefined) console.warn('Could not record the report', error)
  })
}
