import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog'
import { Kbd, KbdGroup } from '@renderer/components/ui/kbd'
import { formatShortcut } from '@renderer/lib/platform'
import { showShortcuts, useViewStore } from '@renderer/stores/view'

const SHORTCUTS = [
  { group: 'sessions', keys: 'Mod+N', action: 'newSession' },
  { group: 'sessions', keys: 'Mod+Shift+[', action: 'previousSession' },
  { group: 'sessions', keys: 'Mod+Shift+]', action: 'nextSession' },
  { group: 'sessions', keys: 'Mod+L', action: 'focusComposer' },
  { group: 'sessions', keys: 'Mod+U', action: 'addFiles' },
  { group: 'sessions', keys: 'Esc', action: 'cancelTurn' },
  { group: 'sessions', keys: '1-4', action: 'answerPermission' },
  { group: 'window', keys: 'Mod+O', action: 'openProject' },
  { group: 'window', keys: 'Mod+B', action: 'toggleSidebar' },
  { group: 'window', keys: 'Mod+,', action: 'settings' },
  { group: 'window', keys: 'Mod+=', action: 'zoomIn' },
  { group: 'window', keys: 'Mod+-', action: 'zoomOut' },
  { group: 'window', keys: 'Mod+0', action: 'resetZoom' },
  { group: 'window', keys: 'Mod+/', action: 'showShortcuts' },
  { group: 'terminal', keys: 'Ctrl+`', action: 'toggleTerminal' },
  { group: 'terminal', keys: 'Ctrl+Shift+`', action: 'newTerminal' },
  { group: 'terminal', keys: 'Mod+L', action: 'askSelection', note: 'askSelectionNote' },
] as const

// "1-4" is a range of keys, not a chord.
const KEY_RANGE = /^(\d)-(\d)$/

function ShortcutKeys({ keys }: { keys: string }) {
  const range = KEY_RANGE.exec(keys)
  return (
    <KbdGroup className="shrink-0 gap-1.5">
      {range ? (
        <>
          <Kbd>{range[1]}</Kbd>
          <span aria-hidden className="text-xs text-tertiary">
            {'–'}
          </span>
          <Kbd>{range[2]}</Kbd>
        </>
      ) : (
        keys.split(/\+(?=.)/).map((key, i) => <Kbd key={i}>{formatShortcut(key)}</Kbd>)
      )}
    </KbdGroup>
  )
}

/** The shortcut table over the screen, from the sidebar's footer button or Mod+/. */
export function ShortcutsDialog() {
  const { t } = useTranslation('shell')
  const open = useViewStore((s) => s.shortcutsOpen)
  const popup = useRef<HTMLDivElement>(null)
  return (
    <Dialog open={open} onOpenChange={showShortcuts}>
      <DialogContent
        ref={popup}
        initialFocus={popup}
        className="flex max-h-[min(640px,85svh)] flex-col gap-4 sm:max-w-[760px]"
        onClick={() => showShortcuts(false)}
      >
        <DialogTitle>{t('shortcuts.title')}</DialogTitle>
        <div className="@container min-h-0 overflow-y-auto">
          <div className="grid grid-cols-1 gap-x-8 gap-y-3 @min-[600px]:grid-cols-2">
            <ShortcutGroup group="sessions" />
            <div className="flex flex-col gap-3">
              <ShortcutGroup group="window" />
              <ShortcutGroup group="terminal" />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ShortcutGroup({ group }: { group: (typeof SHORTCUTS)[number]['group'] }) {
  const { t } = useTranslation('shell')
  const rows = SHORTCUTS.filter((shortcut) => shortcut.group === group)
  return (
    <section aria-label={t(`shortcuts.groups.${group}`)} className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-tertiary">{t(`shortcuts.groups.${group}`)}</h3>
      <dl className="flex flex-col">
        {rows.map((row) => (
          <div key={row.action} className="flex min-h-8 items-center gap-6 py-0.5">
            <dt className="flex min-w-0 flex-1 flex-col">
              <span className="text-ui">{t(`shortcuts.${row.action}`)}</span>
              {'note' in row && (
                <span className="text-xs text-secondary">{t(`shortcuts.${row.note}`)}</span>
              )}
            </dt>
            <dd>
              <ShortcutKeys keys={row.keys} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
