import { useEffect } from 'react'
import type { AttentionNotice } from '@shared/attention'
import { eventToast } from '@renderer/components/ui/toast'
import { currentLocale, i18n } from '@renderer/lib/i18n'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { openSession, shownLayoutSessions, useViewStore } from '@renderer/stores/view'
import type { ToastId } from '@renderer/components/affect/toaster'

// While the window is in front, a session's turn that ends, fails or waits for the user shows as
// a toast instead of a notification, unless the session is on screen. Endings that come while the
// toast shows join it, so several sessions finishing together make one toast, not a pile.

let shown: { id: ToastId; notices: Map<string, AttentionNotice> } | null = null

function noticeOf(notice: AttentionNotice): void {
  if (shownLayoutSessions(useViewStore.getState()).includes(notice.sessionId)) return
  const notices = shown?.notices ?? new Map<string, AttentionNotice>()
  // A session's newer turn replaces its older one, and moves to the end as the latest.
  notices.delete(notice.sessionId)
  notices.set(notice.sessionId, notice)
  const latest = notice.sessionId
  const all = [...notices.values()]
  const content =
    all.length === 1
      ? { title: notice.title, description: notice.body, warning: notice.kind === 'error' }
      : {
          title: i18n.t(
            all.every((each) => each.kind === 'turn-ended' || each.kind === 'routine-ended')
              ? 'shell:turnNotice.finished'
              : 'shell:turnNotice.waiting',
            { count: all.length },
          ),
          description: new Intl.ListFormat(currentLocale(), { type: 'conjunction' }).format(
            all.map((each) => titleOf(each)),
          ),
          warning: all.some((each) => each.kind === 'error'),
        }
  const id = eventToast(
    content,
    {
      label: i18n.t('shell:turnNotice.open'),
      onClick: () => {
        const summary = useSessionsStore.getState().byId[latest]
        if (summary) openSession(summary.id, summary.projectPath)
      },
    },
    {
      ...(shown && { id: shown.id }),
      onClose: () => {
        if (shown?.id === id) shown = null
      },
    },
  )
  shown = { id, notices }
}

function titleOf(notice: AttentionNotice): string {
  const summary = useSessionsStore.getState().byId[notice.sessionId]
  return summary ? sessionTitle(summary) : notice.title
}

/** Shows the turns main or the host sends this window while it is in front. */
export function useAttentionNotices(): void {
  useEffect(() => window.kettu.app.onAttention(noticeOf), [])
}
