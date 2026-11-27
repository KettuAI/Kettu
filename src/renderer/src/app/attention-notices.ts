import { useEffect } from 'react'
import type { AttentionNotice } from '@shared/attention'
import type { Locale } from '@shared/locale'
import { eventToast } from '@renderer/components/ui/toast'
import { currentLocale, i18n } from '@renderer/lib/i18n'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { openSession, shownLayoutSessions, useViewStore } from '@renderer/stores/view'
import type { ToastId } from '@renderer/components/affect/toaster'

// While the window is in front, a session's turn that ends, fails or waits for the user shows as
// a toast instead of a notification, unless the session is on screen. Endings that come while the
// toast shows join it, so several sessions finishing together make one toast, not a pile.

/** Maximum number of session titles named explicitly when several notices merge into one toast. */
export const MAX_MERGED_TITLES = 3

/**
 * Maximum visual width (narrow character = 1, wide CJK/fullwidth/emoji character = 2) kept per
 * session title inside a merged list so one long title cannot push the rest past the line clamp.
 */
export const MAX_MERGED_TITLE_WIDTH = 32

let shown: { id: ToastId; notices: Map<string, AttentionNotice> } | null = null

function charWidth(codePoint: number): number {
  return (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3ffff)
    ? 2
    : 1
}

/** Collapses whitespace and clips a session title for compact display in a merged toast list. */
export function clipMergedTitle(raw: string, maxWidth = MAX_MERGED_TITLE_WIDTH): string {
  const normalized = raw.replace(/\s+/g, ' ').trim()
  if (normalized.length === 0) return ''
  let total = 0
  for (const ch of normalized) total += charWidth(ch.codePointAt(0)!)
  if (total <= maxWidth) return normalized
  const budget = Math.max(1, maxWidth - 1)
  let used = 0
  let out = ''
  for (const ch of normalized) {
    const width = charWidth(ch.codePointAt(0)!)
    if (used + width > budget) break
    out += ch
    used += width
  }
  return `${out.trimEnd()}…`
}

/**
 * Formats a merged multi-session description, naming up to `MAX_MERGED_TITLES` sessions and
 * folding the rest into a localized overflow summary.
 */
export function formatMergedNoticeList(
  titles: readonly string[],
  locale: Locale = currentLocale(),
): string {
  const clipped = titles.map((title) => clipMergedTitle(title)).filter(Boolean)
  if (clipped.length === 0) return ''
  const visible = clipped.slice(0, MAX_MERGED_TITLES)
  const rest = Math.max(0, titles.length - visible.length)
  if (rest === 0) {
    return new Intl.ListFormat(locale, { type: 'conjunction' }).format(visible)
  }
  const names = new Intl.ListFormat(locale, { type: 'conjunction', style: 'narrow' }).format(
    visible,
  )
  return i18n.t('shell:turnNotice.andMore', { lng: locale, names, count: rest })
}

/** Builds the title, description and warning flag for one or more merged session notices. */
export function buildAttentionToastContent(
  notices: readonly AttentionNotice[],
  resolveTitle: (notice: AttentionNotice) => string = titleOf,
  locale: Locale = currentLocale(),
): { title: string; description: string; warning: boolean } {
  if (notices.length === 1) {
    const [only] = notices
    return { title: only!.title, description: only!.body, warning: only!.kind === 'error' }
  }
  // Most recent first so the session opened by the action button is always named first.
  const ordered = [...notices].reverse()
  return {
    title: i18n.t(
      notices.every((each) => each.kind === 'turn-ended' || each.kind === 'routine-ended')
        ? 'shell:turnNotice.finished'
        : 'shell:turnNotice.waiting',
      { lng: locale, count: notices.length },
    ),
    description: formatMergedNoticeList(
      ordered.map((each) => resolveTitle(each)),
      locale,
    ),
    warning: notices.some((each) => each.kind === 'error'),
  }
}

export function noticeOf(notice: AttentionNotice): void {
  if (shownLayoutSessions(useViewStore.getState()).includes(notice.sessionId)) return
  const notices = shown?.notices ?? new Map<string, AttentionNotice>()
  // A session's newer turn replaces its older one, and moves to the end as the latest.
  notices.delete(notice.sessionId)
  notices.set(notice.sessionId, notice)
  const latest = notice.sessionId
  const content = buildAttentionToastContent([...notices.values()])
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
  const raw = summary ? sessionTitle(summary) : notice.title
  return raw.replace(/\s+/g, ' ').trim() || notice.title.replace(/\s+/g, ' ').trim()
}

/** Shows the turns main or the host sends this window while it is in front. */
export function useAttentionNotices(): void {
  useEffect(() => window.kettu.app.onAttention(noticeOf), [])
}
