import { memo, useEffect, useRef, useState } from 'react'
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  Settings02Icon,
  Shield01Icon,
  Tick02Icon,
  Undo02Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { Trans, useTranslation } from 'react-i18next'
import { CATALOG, parseToolId, sameValue } from '@shared/settings-catalog'
import type { SettingChangeItem, SettingsChangeEntry as Entry } from '@shared/thread'
import { Icon } from '@renderer/components/affect/app-shell'
import { PermissionRequest } from '@renderer/components/affect/permission-request'
import { Button } from '@renderer/components/ui/button'
import { toast } from '@renderer/components/ui/toast'
import { emitAppEvent } from '@renderer/app/events'
import { errorMessage, host } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { isMac, isWeb } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { hostScope, LOCAL_SCOPE, useSettingsHostStore } from '@renderer/stores/host-scope'
import { useOtherHost } from '@renderer/stores/hosts'
import { useSessionsStore } from '@renderer/stores/sessions'
import { openSettingsRow } from '@renderer/stores/view'
import { useWebHostStore } from '@renderer/stores/web-host'
import { useEntry, useEntryAnimation } from '../use-thread'
import { revealWaiting } from './helpers'
import { useAnswering } from './use-answering'

/**
 * An agent's change to Kettu's settings: the card while it waits for the user, shaped and answered
 * like a permission request, then one muted line of what came of it, with Undo while it stands.
 */
export const SettingsChangeEntry = memo(function SettingsChangeEntry({
  sessionId,
  entryId,
  agentName,
}: {
  sessionId: string
  entryId: string
  agentName: string
}) {
  const entry = useEntry(sessionId, entryId, 'settings_change')
  const animation = useEntryAnimation(sessionId, entryId)
  if (!entry) return null
  return entry.outcome === null ? (
    <SettingsCard sessionId={sessionId} entry={entry} agentName={agentName} className={animation} />
  ) : (
    <SettingsLine sessionId={sessionId} entry={entry} className={animation} />
  )
})

/** The session's host: null for this computer, with its name when it is another one. */
function useSessionHost(sessionId: string): { hostId: string | null; name: string | null } {
  const hostId = useSessionsStore((s) => hostOfPath(s.byId[sessionId]?.projectPath ?? ''))
  const other = useOtherHost(hostId)
  const served = useWebHostStore((s) => s.host?.name ?? null)
  if (hostId !== null) return { hostId, name: other?.name ?? null }
  // A browser reaches its host from elsewhere, so the host goes by its name there.
  return { hostId: null, name: isWeb ? served : null }
}

/** Settings at the row, on the host the change was for. */
function viewInSettings(hostId: string | null, item: SettingChangeItem): void {
  const parsed = parseToolId(item.id)
  const desktop = parsed ? CATALOG[parsed.id].part === 'desktop' : false
  useSettingsHostStore.setState({ hostId: desktop ? null : hostId })
  openSettingsRow(item.section, item.item, item.row)
}

function SettingsRows({ items }: { items: SettingChangeItem[] }) {
  const { t } = useTranslation('session')
  return (
    <ul className="ks-settings-rows" aria-label={t('settingsChange.rows')} data-selectable="">
      {items.map((item) => (
        <li key={item.id}>
          <div className="ks-settings-rows__row">
            <span className="ks-settings-rows__name">
              <span className="ks-settings-rows__place">{item.place} › </span>
              {item.name}
            </span>
            <span className="ks-settings-rows__value">
              <del>{item.from.text}</del>
              <span aria-hidden className="ks-settings-rows__arrow">
                →
              </span>
              <ins>{item.to.text}</ins>
            </span>
          </div>
          {item.warning && (
            <p className="ks-settings-rows__warn">
              <Icon icon={Shield01Icon} size={14} />
              <span>
                {item.warning} {t('settingsChange.alwaysAsks')}
              </span>
            </p>
          )}
        </li>
      ))}
    </ul>
  )
}

/**
 * The card: a gear and how many rows change, who asks on which computer, the rows on a sunk block,
 * View in Settings at the left and Don't change and Change at the right, as a permission request's.
 */
function SettingsCard({
  sessionId,
  entry,
  agentName,
  className,
}: {
  sessionId: string
  entry: Entry
  agentName: string
  className?: string
}) {
  const { t } = useTranslation('session')
  const { answering, error, away, send } = useAnswering(sessionId)
  const { hostId, name } = useSessionHost(sessionId)
  const card = useRef<HTMLDivElement>(null)
  // Change was given here or elsewhere: the card holds until the host says what came of it.
  const [changing, setChanging] = useState(false)

  useEffect(() => {
    revealWaiting(card.current)
  }, [])

  const answer = async (decision: 'change' | 'keep'): Promise<void> => {
    if (away || answering !== null || changing) return
    const focused = !!card.current?.contains(document.activeElement)
    const sent = await send(decision, () =>
      host('settings.answerChange', { sessionId, entryId: entry.id, decision }),
    )
    if (sent && decision === 'change') setChanging(true)
    if (sent && focused) emitAppEvent({ kind: 'focus-composer' })
  }

  const count = entry.items.length
  const who =
    name !== null
      ? t('settingsChange.whoOther', { agent: agentName, computer: name })
      : isMac
        ? t('settingsChange.whoMac', { agent: agentName })
        : t('settingsChange.whoComputer', { agent: agentName })
  const first = entry.items[0]

  return (
    <div ref={card} data-entry-id={entry.id} className={cn('min-w-0', className)}>
      <PermissionRequest
        className="ks-permission ks-settings-card"
        agent={{ name: agentName, avatar: <Icon icon={Settings02Icon} size={16} /> }}
        action={t('settingsChange.title', { count })}
        target={who}
        risk="risky"
        scopes={['once']}
        decision={null}
        onDecisionChange={(next) => {
          if (next) void answer(next.allow ? 'change' : 'keep')
        }}
        revocable={false}
        disabled={answering !== null || changing || away}
        actions={
          first && (
            <button
              type="button"
              className="ui-prc__btn ks-permission__other ks-settings-card__view"
              onClick={() => viewInSettings(hostId, first)}
            >
              {t('settingsChange.view')}
              <Icon icon={ArrowRight01Icon} size={12} />
            </button>
          )
        }
        labels={{
          title: () => <b>{t('settingsChange.title', { count })}</b>,
          risk: () => t('status.needsApproval'),
          allow: () => (
            <>
              <Icon icon={Tick02Icon} size={14} />
              {changing ? t('settingsChange.changing') : t('settingsChange.change')}
            </>
          ),
          deny: (
            <>
              <Icon icon={Cancel01Icon} size={14} />
              {t('settingsChange.keep')}
            </>
          ),
        }}
      >
        <SettingsRows items={entry.items} />
      </PermissionRequest>
      {error && (
        <p role="alert" className="ks-card-error">
          {error}
        </p>
      )}
    </div>
  )
}

/**
 * Whether a change still stands where this client can tell: every row still holds the value it set.
 * Rows of another computer's window, which this client does not see, count as standing.
 */
function useStands(hostId: string | null, items: SettingChangeItem[], live: boolean): boolean {
  const scope = live ? (hostId === null ? LOCAL_SCOPE : hostScope(hostId)) : LOCAL_SCOPE
  return scope.useSettingsStore((s) => {
    if (!live || !s.loaded) return true
    return items.every((item) => {
      const parsed = parseToolId(item.id)
      if (!parsed) return true
      const entry = CATALOG[parsed.id]
      if (!entry.get || (hostId !== null && entry.part === 'desktop')) return true
      return sameValue(entry.get(s.settings, parsed.item), item.to.value)
    })
  })
}

/** What came of a change, as one muted line: made, undone or not made, and Undo while it stands. */
function SettingsLine({
  sessionId,
  entry,
  className,
}: {
  sessionId: string
  entry: Entry
  className?: string
}) {
  const { t } = useTranslation('session')
  const { hostId, name } = useSessionHost(sessionId)
  const [open, setOpen] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const outcome = entry.outcome!
  const changed = outcome.kind === 'changed'
  const undone = changed && outcome.undone === true
  const live = changed && !undone && outcome.stale !== true
  const stands = useStands(hostId, entry.items, live)
  const items = entry.items
  const one = items.length === 1 ? items[0]! : null
  const what = (item: SettingChangeItem) => `${item.place} › ${item.name}`
  const values = one
    ? { what: what(one), from: one.from.text, to: one.to.text }
    : { count: items.length }
  const key = undone
    ? one
      ? 'settingsChange.undone'
      : 'settingsChange.undoneMany'
    : changed
      ? one
        ? 'settingsChange.changed'
        : 'settingsChange.changedMany'
      : one
        ? 'settingsChange.notChanged'
        : 'settingsChange.notChangedMany'
  const notes = [
    name,
    entry.device ? t('settingsChange.answeredOn', { device: entry.device.name }) : null,
    outcome.kind === 'expired' ? t('settingsChange.noAnswer') : null,
    outcome.kind === 'failed' ? outcome.message : null,
  ].filter((note): note is string => !!note)

  const undo = async (): Promise<void> => {
    setUndoing(true)
    try {
      await host('settings.undoChange', { sessionId, entryId: entry.id })
    } catch (error) {
      toast(errorMessage(error))
    } finally {
      setUndoing(false)
    }
  }

  return (
    <div data-entry-id={entry.id} className={cn('min-w-0', className)}>
      <div className="ks-settings-line">
        <HugeiconsIcon
          icon={undone ? Undo02Icon : changed ? CheckmarkCircle02Icon : CancelCircleIcon}
          strokeWidth={1.9}
          aria-hidden
          className={cn('size-3.5 shrink-0', changed && !undone && 'ks-settings-line__done')}
        />
        <span className="min-w-0 truncate">
          <Trans t={t} i18nKey={key} values={values} components={{ b: <b /> }} />
        </span>
        {!one && (
          <button
            type="button"
            className="ks-settings-line__toggle"
            aria-expanded={open}
            aria-label={t('settingsChange.showRows')}
            onClick={() => setOpen((o) => !o)}
          >
            <Icon icon={ArrowDown01Icon} size={12} />
          </button>
        )}
        {notes.map((note) => (
          <span key={note} className="ks-settings-line__note">
            · {note}
          </span>
        ))}
        {live && stands && (
          <Button
            variant="quiet"
            size="xs"
            disabled={undoing}
            className="ks-settings-line__undo"
            aria-label={t('settingsChange.undoLabel', {
              what: one ? what(one) : t('settingsChange.title', { count: items.length }),
            })}
            onClick={() => void undo()}
          >
            <Icon icon={Undo02Icon} size={12} />
            {t('settingsChange.undo')}
          </Button>
        )}
      </div>
      {!one && open && (
        <ul className="ks-settings-line__rows" data-selectable="">
          {items.map((item) => (
            <li key={item.id}>
              {t('settingsChange.row', {
                what: what(item),
                from: undone ? item.to.text : item.from.text,
                to: undone ? item.from.text : item.to.text,
              })}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
