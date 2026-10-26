import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { SettingsFile } from '@shared/settings'
import type { AgentId } from '@shared/thread'
import { AgentTile } from '@renderer/components/agents/agent-mark'
import { useRefresh } from '@renderer/components/refresh'
import { RefreshIcon } from '@renderer/components/refresh-icon'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { toast } from '@renderer/components/ui/toast'
import { bytes, longAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { currentLocale } from '@renderer/lib/i18n'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { agentName } from '@renderer/stores/agents'
import { useSettingsStore } from '@renderer/stores/settings'
import { clearUsageRecord, reimportUsage, syncUsage, useUsageStore } from '@renderer/stores/usage'
import {
  CONFIRM,
  ControlError,
  GROUP_ACTION,
  PathText,
  SettingSelect,
  SettingSwitch,
} from './controls'
import { RowLine, RowText } from './rows'
import { useApply } from './use-apply'

export function FromComputer() {
  const { t } = useTranslation('usage')
  const checked = useSettingsStore((s) => s.settings.usage.fromComputer)
  const [apply, error] = useApply()
  return (
    <>
      <ControlError error={error} />
      <SettingSwitch
        label={t('settings.fromComputer.name')}
        checked={checked}
        onChange={(v) => apply({ usage: { fromComputer: v } })}
      />
    </>
  )
}

/** Sync now at the end of the Logs label, with the running scan's progress before it. */
export function SyncLogs() {
  const { t } = useTranslation('usage')
  const scanning = useUsageStore((s) => s.status?.scanning ?? null)
  const refresh = useRefresh({ busy: scanning !== null })
  const [error, setError] = useState<string | null>(null)
  const running = refresh.phase === 'turning'
  return (
    <>
      {scanning && scanning.bytes > 0 && (
        <span role="status" className="text-xs text-tertiary tabular-nums">
          {t('page.importing', { done: bytes(scanning.doneBytes), total: bytes(scanning.bytes) })}
        </span>
      )}
      <ControlError error={error} />
      <Button
        variant="quiet"
        size="sm"
        aria-busy={running}
        disabled={running}
        onClick={() => {
          setError(null)
          void refresh.run(syncUsage).catch((e: unknown) => setError(errorMessage(e)))
        }}
        className={GROUP_ACTION}
      >
        <RefreshIcon phase={refresh.phase} data-icon="inline-start" />
        {t('page.sync')}
      </Button>
    </>
  )
}

function dateText(at: number): string {
  return new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'medium' }).format(at)
}

/** One agent's logs: what they cover, where they are, and Re-import. */
const NO_LOCATIONS: string[] = []

export function LogRow({ agentId }: { agentId: AgentId }) {
  const { t } = useTranslation(['usage', 'common'])
  const now = useNow()
  // Values only: the status is a new object at every step of a scan.
  const log = useUsageStore(
    useShallow((s) => {
      const found = s.status?.logs.find((l) => l.agentId === agentId)
      return {
        found: found?.found ?? null,
        rows: found?.rows ?? 0,
        first: found?.first ?? null,
        syncedAt: found?.syncedAt ?? null,
        error: found?.error ?? null,
      }
    }),
  )
  const locations = useUsageStore(
    useShallow((s) => s.status?.logs.find((l) => l.agentId === agentId)?.locations ?? NO_LOCATIONS),
  )
  const scanning = useUsageStore((s) => s.status?.scanning != null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = agentName(agentId)
  const facts: string[] = []
  if (log.found === null) facts.push(scanning ? t('page.syncing') : t('settings.notRead'))
  else if (!log.found) facts.push(t('settings.notFound'))
  else if (log.first !== null) {
    facts.push(
      t('settings.covers', {
        date: dateText(log.first),
        count: log.rows,
        requests: log.rows.toLocaleString(currentLocale()),
      }),
    )
  } else facts.push(t('settings.coversNone'))
  if (log.syncedAt !== null) facts.push(t('settings.synced', { ago: longAgo(log.syncedAt, now) }))
  const shownError = error ?? log.error

  const reimport = async () => {
    setError(null)
    try {
      await reimportUsage(agentId)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <>
      <RowLine
        text={
          <div className="flex min-w-0 items-center gap-3">
            <AgentTile agent={agentId} size={30} glyph={16} />
            <div className="flex min-w-0 flex-1 flex-col">
              <RowText
                name={name}
                description={
                  <span className={cn(shownError && 'text-danger')}>
                    {shownError ?? facts.join(' · ')}
                  </span>
                }
              />
              {locations.map((location) => (
                <PathText key={location} path={location} missing={log.found === false} />
              ))}
            </div>
          </div>
        }
      >
        <Button
          variant="quiet"
          size="sm"
          className="text-secondary"
          disabled={!log.found || scanning}
          onClick={() => setOpen(true)}
        >
          {t('settings.reimport.button')}
        </Button>
      </RowLine>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent className={CONFIRM}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.reimport.title', { agent: name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.reimport.description', { agent: name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void reimport()
                setOpen(false)
              }}
            >
              {t('settings.reimport.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export function SidebarEnd() {
  const { t } = useTranslation('usage')
  const value = useSettingsStore((s) => s.settings.usage.sidebar)
  const [apply, error] = useApply()
  const options: { value: SettingsFile['usage']['sidebar']; label: string }[] = [
    { value: 'today', label: t('settings.sidebar.today') },
    { value: 'cost', label: t('settings.sidebar.cost') },
    { value: 'limit', label: t('settings.sidebar.limit') },
    { value: 'off', label: t('settings.sidebar.off') },
  ]
  return (
    <>
      <ControlError error={error} />
      <SettingSelect
        label={t('settings.sidebar.name')}
        value={value}
        options={options}
        onChange={(sidebar) => apply({ usage: { sidebar } })}
      />
    </>
  )
}

export function ClearRecord() {
  const { t } = useTranslation(['usage', 'common', 'settings'])
  const empty = useUsageStore((s) => s.status?.recordSince == null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const clear = async () => {
    setBusy(true)
    setError(null)
    try {
      await clearUsageRecord()
      toast(t('settings:usage.cleared'))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <ControlError error={error} />
      <Button
        variant="destructive-outline"
        size="sm"
        disabled={empty || busy}
        onClick={() => setOpen(true)}
      >
        {busy && <Spinner data-icon="inline-start" className="size-3.5" />}
        {t('settings.clear.button')}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent className={CONFIRM}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.clear.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('settings.clear.description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                void clear()
                setOpen(false)
              }}
            >
              {t('settings.clear.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
