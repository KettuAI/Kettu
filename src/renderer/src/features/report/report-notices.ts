import { useEffect } from 'react'
import { noticeToast } from '@renderer/components/ui/toast'
import { i18n } from '@renderer/lib/i18n'
import { isWeb } from '@renderer/lib/platform'
import { openReport, watchRecording } from '@renderer/stores/report'

/** Follows the recording of steps, and tells once of an unexpected quit, with Report a problem. */
export function useReportNotices(): void {
  useEffect(() => {
    if (isWeb) return
    const unwatch = watchRecording()
    void window.kettu.report.crashNotice().then((at) => {
      if (at === null) return
      const t = i18n.getFixedT(null, 'report')
      noticeToast(
        t('crashNotice'),
        // The last run's start is all that is known of it; today covers the usual case.
        { label: t('reportProblem'), onClick: () => void openReport({ range: { kind: 'today' } }) },
        () => void window.kettu.report.dismissCrashNotice(),
      )
    })
    return unwatch
  }, [])
}
