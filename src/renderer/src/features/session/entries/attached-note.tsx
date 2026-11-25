import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PLUGIN_VIEW_LIMITS } from '@shared/plugin-views'
import type { PluginAttached } from '@shared/thread'

/** The plugin's own word on a failure, on one line and cut short, as it is untrusted text. */
function pluginSaid(detail: string | undefined): string | null {
  const line = detail?.replace(/\s+/g, ' ').trim().slice(0, PLUGIN_VIEW_LIMITS.error)
  return line ? line : null
}

/**
 * Under a message a plugin attached to: which plugin and what it added, which opens from the line.
 * The message itself stays as the user wrote it.
 */
export function AttachedNote({ attached }: { attached: PluginAttached }) {
  const { t } = useTranslation('session')
  const [open, setOpen] = useState(false)
  const added = attached.items.filter((item) => item.failed === undefined)
  const missed = attached.items.filter((item) => item.failed !== undefined)
  const titles = added.flatMap((item) => (item.title ? [item.title] : []))
  const line =
    titles.length > 0
      ? t('userEntry.attachedItems', { plugin: attached.plugin, items: titles.join(', ') })
      : t('userEntry.attached', { plugin: attached.plugin })
  return (
    <>
      {added.length > 0 && (
        <span className="ks-user__note flex items-center gap-1">
          <span className="truncate">{line}</span>
          <span aria-hidden>·</span>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((shown) => !shown)}
            className="shrink-0 rounded-sm underline-offset-2 outline-none hover:underline focus-visible:focus-ring"
          >
            {open ? t('userEntry.hideAttached') : t('userEntry.showAttached')}
          </button>
        </span>
      )}
      {open && (
        <div className="ks-user__sent" data-selectable="">
          {added.map((item) => item.text).join('\n\n')}
        </div>
      )}
      {missed.map((item, i) => {
        const failed = t('userEntry.attachedFailed', {
          items: item.title ?? attached.plugin,
          why:
            pluginSaid(item.detail) ??
            t(`userEntry.attachedWhy.${item.failed}`, {
              defaultValue: t('userEntry.attachedWhy.failed'),
            }),
        })
        return (
          <span key={i} className="ks-user__note flex items-center gap-1">
            <span className="truncate" title={failed}>
              {failed}
            </span>
          </span>
        )
      })}
    </>
  )
}
