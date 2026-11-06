import { useMemo, useState } from 'react'
import { Search01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@renderer/components/ui/dialog'
import { Kbd } from '@renderer/components/ui/kbd'
import { useSettingsStore } from '@renderer/stores/settings'
import { showShortcuts, useViewStore } from '@renderer/stores/view'
import { keyCaps, shortcutList, type Shortcut, type ShortcutGroupName } from './shortcuts'
import { Glyph } from './glyph'

/** The shortcut table over the screen, from the account menu or Mod+/ anywhere. */
export function ShortcutsDialog() {
  const { t } = useTranslation(['shell', 'common'])
  const open = useViewStore((s) => s.shortcutsOpen)
  const sendKey = useSettingsStore((s) => s.settings.general.sendKey)
  const [query, setQuery] = useState('')
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return shortcutList(sendKey).filter(
      (row) =>
        needle === '' ||
        t(`shortcuts.${row.action}`).toLowerCase().includes(needle) ||
        keyCaps(row.keys).join(' ').toLowerCase().includes(needle),
    )
  }, [query, sendKey, t])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        showShortcuts(next)
        if (!next) setQuery('')
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[min(640px,85svh)] flex-col gap-0 px-5.5 pt-5 pb-4.5 sm:max-w-[820px]"
      >
        <DialogTitle>{t('shortcuts.title')}</DialogTitle>
        <label className="mt-3.5 flex h-8.5 shrink-0 items-center gap-2 rounded-2xl bg-subtle px-2.5 text-tertiary focus-ring-within">
          <Glyph icon={Search01Icon} size={14} className="shrink-0" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('shortcuts.search')}
            aria-label={t('shortcuts.search')}
            className="min-w-0 flex-1 bg-transparent text-control text-foreground outline-none placeholder:text-tertiary"
          />
        </label>
        {/* The key caps' ring sits a pixel outside them, which the scroll box would clip. */}
        <div className="@container -mx-px mt-4 min-h-0 overflow-y-auto px-px">
          {rows.length === 0 ? (
            <p className="py-6 text-center text-control text-tertiary">{t('shortcuts.noMatch')}</p>
          ) : (
            <div className="grid grid-cols-1 gap-x-7 gap-y-5 @min-[560px]:grid-cols-2 @min-[720px]:grid-cols-3">
              <div className="flex flex-col gap-5">
                <ShortcutGroup group="general" rows={rows} />
              </div>
              <div className="flex flex-col gap-5">
                <ShortcutGroup group="sessions" rows={rows} />
                <ShortcutGroup group="terminal" rows={rows} />
              </div>
              <div className="flex flex-col gap-5">
                <ShortcutGroup group="composer" rows={rows} />
              </div>
            </div>
          )}
        </div>
        <div className="mt-4.5 flex shrink-0 items-center justify-end">
          <DialogClose render={<Button variant="outline" />}>
            {t('common:actions.done')}
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ShortcutGroup({ group, rows }: { group: ShortcutGroupName; rows: Shortcut[] }) {
  const { t } = useTranslation('shell')
  const mine = rows.filter((row) => row.group === group)
  if (mine.length === 0) return null
  return (
    <section aria-label={t(`shortcuts.groups.${group}`)} className="flex flex-col">
      <h3 className="mb-1 text-small font-semibold text-tertiary">
        {t(`shortcuts.groups.${group}`)}
      </h3>
      <dl className="flex flex-col">
        {mine.map((row) => (
          <div
            key={`${row.group}:${row.action}`}
            className="flex h-7.5 items-center gap-4 border-b border-border-soft"
          >
            <dt className="min-w-0 flex-1 truncate text-control text-foreground">
              {t(`shortcuts.${row.action}`)}
            </dt>
            <dd className="flex shrink-0 gap-0.75">
              {keyCaps(row.keys).map((cap, i) => (
                <Kbd key={i} className="h-5.5 min-w-5.5 rounded-tile px-1.5 text-small font-medium">
                  {cap}
                </Kbd>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
