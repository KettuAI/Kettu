import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import type { ExtensionWidgetPlacement } from '@shared/thread'
import { useThreadsStore } from '@renderer/stores/threads'
import { extensionStatusesOf, extensionWidgetsOf } from './extension-ui-model'

/**
 * Compact, bounded-height text widget stack published by native agent extensions (such as Pi
 * `setWidget`). Renders nothing when no widgets are active for the session and placement.
 */
export const ExtensionWidgets = memo(function ExtensionWidgets({
  sessionId,
  placement,
  enabled = true,
}: {
  sessionId: string
  placement: ExtensionWidgetPlacement
  enabled?: boolean
}) {
  const { t } = useTranslation('session')
  const extensionUi = useThreadsStore(
    (s) => s.replicas[sessionId]?.state?.session.extensionUi ?? null,
  )
  if (!enabled) return null
  const widgets = extensionWidgetsOf(extensionUi, placement)
  if (widgets.length === 0) return null

  return (
    <div
      className="ks-ext-widgets"
      role="region"
      aria-label={t('extensionUi.widgetsLabel')}
      data-extension-widgets={placement}
    >
      {widgets.map((widget) => (
        <section
          key={widget.key}
          className="ks-ext-widget"
          aria-label={widget.key}
          data-extension-widget={widget.key}
          data-placement={widget.placement}
        >
          <div className="ks-ext-widget__body" data-selectable>
            {widget.lines.map((line, index) => (
              <div key={index} className="ks-ext-widget__line">
                {line === '' ? '\u00a0' : line}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
})

/**
 * Compact muted status chip row published by native agent extensions (such as Pi `setStatus`).
 * Renders nothing when no statuses are active for the session.
 */
export const ExtensionStatusBar = memo(function ExtensionStatusBar({
  sessionId,
  enabled = true,
}: {
  sessionId: string
  enabled?: boolean
}) {
  const { t } = useTranslation('session')
  const extensionUi = useThreadsStore(
    (s) => s.replicas[sessionId]?.state?.session.extensionUi ?? null,
  )
  if (!enabled) return null
  const statuses = extensionStatusesOf(extensionUi)
  if (statuses.length === 0) return null

  return (
    <div
      className="ks-ext-status"
      role="status"
      aria-live="polite"
      aria-label={t('extensionUi.statusLabel')}
      data-extension-statuses=""
    >
      {statuses.map((status) => (
        <span
          key={status.key}
          className="ks-ext-status__pill"
          data-extension-status={status.key}
          title={status.text}
        >
          <span className="ks-ext-status__text" data-selectable>
            {status.text}
          </span>
        </span>
      ))}
    </div>
  )
})
