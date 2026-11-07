import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  CheckmarkCircle02Icon,
  ComputerIcon,
  MinusSignCircleIcon,
  ViewIcon,
} from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { ComputerSetupStep, ComputerUseStatus } from '@shared/computer-use'
import { Icon } from '@renderer/components/affect/app-shell'
import { ApprovalCard } from '@renderer/components/affect/approval-card'
import { BrandIcon } from '@renderer/components/brand'
import { Spinner } from '@renderer/components/ui/spinner'
import { errorMessage, host } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { isWeb, isWindows, platform } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { useOtherHost } from '@renderer/stores/hosts'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import { useWebHostStore } from '@renderer/stores/web-host'
import { linuxLine } from '../../settings/computer-section'
import { useEntry, useEntryAnimation } from '../use-thread'

/** A switch as the pictures draw it, on or off. */
function MiniSwitch({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative ml-auto h-3.5 w-6 shrink-0 rounded-full',
        on ? 'bg-switch-on' : 'bg-track',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 size-2.5 rounded-full bg-switch-thumb shadow-xs',
          on ? 'right-0.5' : 'left-0.5',
        )}
      />
    </span>
  )
}

/** A row of a picture: an app or a setting, with its switch; the one to turn on is ringed. */
function PictureRow({
  icon,
  label,
  on,
  marked = false,
}: {
  icon: ReactNode
  label: string
  on: boolean
  marked?: boolean
}) {
  return (
    <span
      className={cn(
        'flex h-6 min-w-0 items-center gap-1.75 rounded-lg bg-card px-1.75 text-key whitespace-nowrap',
        marked ? 'shadow-tile-on' : 'opacity-50 shadow-sunk',
      )}
    >
      {icon}
      <span className="min-w-0 truncate">{label}</span>
      <MiniSwitch on={on} />
    </span>
  )
}

const PANE_ICON: Record<Exclude<ComputerSetupStep, 'enable'>, IconSvgElement> = {
  accessibility: ComputerIcon,
  'screen-recording': ViewIcon,
}

/** Where the step's switch is: Kettu's own, or Kettu's row in the system's privacy list. */
function Picture({ step, waiting }: { step: ComputerSetupStep; waiting: boolean }) {
  const { t } = useTranslation('session')
  const frame =
    'flex h-26 w-42 shrink-0 flex-col justify-center gap-1.5 rounded-card bg-subtle p-2.5 shadow-sunk'
  if (waiting) {
    return (
      <div aria-hidden className={cn(frame, 'items-center text-center text-key text-tertiary')}>
        <Spinner className="size-4" />
        <span>{t('computerSetup.inSettings')}</span>
      </div>
    )
  }
  if (step === 'enable') {
    return (
      <div aria-hidden className={frame}>
        <PictureRow
          icon={<Icon icon={ComputerIcon} size={12} />}
          label={t('computerSetup.enable.switch')}
          on
          marked
        />
        <PictureRow
          icon={<span className="h-1.5 w-12 shrink-0 rounded-full bg-track" />}
          label=""
          on={false}
        />
      </div>
    )
  }
  const glyph = PANE_ICON[step]
  const blank = <span className="size-3 shrink-0 rounded-sm bg-track" />
  return (
    <div aria-hidden className={frame}>
      <span className="flex items-center gap-1 px-0.5 text-key font-medium text-tertiary">
        <Icon icon={glyph} size={12} />
        <span className="truncate">{t(`computerSetup.${step}.pane`)}</span>
      </span>
      <PictureRow icon={<BrandIcon size={12} />} label="Kettu" on marked />
      <PictureRow icon={blank} label="" on />
    </div>
  )
}

/** What the switch step adds about this computer: what Windows or a Linux desktop allows. */
function usePlatformNote(enabled: boolean): string | null {
  const { t } = useTranslation('settings')
  const [status, setStatus] = useState<ComputerUseStatus | null>(null)
  useEffect(() => {
    if (!enabled || platform !== 'linux') return
    let live = true
    window.kettu.computer.status().then(
      (next) => live && setStatus(next),
      () => {},
    )
    return () => {
      live = false
    }
  }, [enabled])
  if (!enabled) return null
  if (isWindows) return t('computer.windows.description')
  return status ? linuxLine(status, t) : null
}

/**
 * An agent's call found computer use off or a macOS permission missing and waits: the card
 * explains one missing step at a time, with a picture of what to switch and the button that does
 * it, and moves on as the host sees each done. Only this computer's window can do the steps; any
 * window or device can say Not now. Once over it is a quiet row.
 */
export const ComputerSetupEntry = memo(function ComputerSetupEntry({
  sessionId,
  entryId,
  agentName,
}: {
  sessionId: string
  entryId: string
  agentName: string
}) {
  const { t } = useTranslation('session')
  const entry = useEntry(sessionId, entryId, 'computer_setup')
  const animation = useEntryAnimation(sessionId, entryId)
  const hostId = useSessionsStore((s) => hostOfPath(s.byId[sessionId]?.projectPath ?? ''))
  const other = useOtherHost(hostId)
  const served = useWebHostStore((s) => s.host?.name ?? null)
  const here = !isWeb && hostId === null
  const [asked, setAsked] = useState<ReadonlySet<ComputerSetupStep>>(new Set())
  const [busy, setBusy] = useState<'step' | 'decline' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const card = useRef<HTMLDivElement>(null)
  const waiting = entry?.outcome === null
  const step = entry ? (entry.steps.find((s) => !entry.done.includes(s)) ?? null) : null
  const note = usePlatformNote(here && waiting && step === 'enable')

  useEffect(() => {
    if (waiting) card.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [waiting])

  if (!entry) return null

  if (!waiting || !step) {
    const ready = entry.outcome === 'ready'
    return (
      <div data-entry-id={entryId} className={cn('min-w-0', animation)}>
        <div className="ks-answered" data-kind={ready ? 'done' : 'other'}>
          <div className="ks-answered__head ks-answered__head--alone">
            <Icon icon={ready ? CheckmarkCircle02Icon : MinusSignCircleIcon} size={16} />
            <span className="ks-answered__title">
              {t(`computerSetup.outcome.${entry.outcome ?? 'timeout'}`)}
            </span>
            {entry.outcome === 'declined' && (
              <span className="ks-answered__device">
                ·{' '}
                {entry.device
                  ? t('permission.answer.onDevice', {
                      answer: t('computerSetup.declinedNote'),
                      device: entry.device.name,
                    })
                  : t('computerSetup.declinedNote')}
              </span>
            )}
          </div>
        </div>
      </div>
    )
  }

  const index = entry.steps.indexOf(step)
  const granting = step !== 'enable' && asked.has(step)

  const doStep = async () => {
    if (busy || !here) return
    setBusy('step')
    setError(null)
    try {
      if (step === 'enable') {
        await useSettingsStore.getState().update({ computerUse: { enabled: true } })
      } else {
        await window.kettu.computer.requestPermission(step)
        setAsked((was) => new Set(was).add(step))
      }
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(null)
    }
  }

  const decline = async () => {
    if (busy) return
    setBusy('decline')
    setError(null)
    try {
      await host('computer.declineSetup', { sessionId, entryId: entry.id })
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(null)
    }
  }

  const where = hostId !== null ? (other?.name ?? null) : served
  return (
    <div
      ref={card}
      data-entry-id={entryId}
      data-elsewhere={here ? undefined : ''}
      className={cn('min-w-0', animation)}
    >
      <ApprovalCard
        className="ks-setup"
        title={
          here
            ? t(`computerSetup.${step}.title`)
            : t('computerSetup.elsewhere', { host: where ?? t('computerSetup.thatComputer') })
        }
        description={
          here
            ? `${t(`computerSetup.${step}.body`, { agent: agentName })}${note ? ` ${note}` : ''}`
            : t('computerSetup.elsewhereBody', { agent: agentName })
        }
        icon={<Icon icon={ComputerIcon} size={15} />}
        label={granting ? t('computerSetup.granting') : t('computerSetup.waiting')}
        approveLabel={
          granting
            ? t('computerSetup.openAgain')
            : step === 'enable'
              ? t('computerSetup.enable.action')
              : t('computerSetup.open')
        }
        denyLabel={t('computerSetup.notNow')}
        allowAlways={false}
        shortcuts
        status="pending"
        onApprove={() => doStep()}
        onDeny={() => void decline()}
        preview={
          here ? (
            <div className="ks-setup__body">
              <Picture step={step} waiting={granting} />
              <div className="ks-setup__steps">
                <span className="ks-plan__label">
                  {t('computerSetup.step', { n: index + 1, count: entry.steps.length })}
                </span>
                {entry.steps.length > 1 && (
                  <span className="ks-setup__dots" aria-hidden>
                    {entry.steps.map((s, i) => (
                      <span
                        key={s}
                        data-state={
                          i === index ? 'current' : entry.done.includes(s) ? 'done' : undefined
                        }
                      />
                    ))}
                  </span>
                )}
              </div>
            </div>
          ) : undefined
        }
      />
      {error && (
        <p role="alert" className="ks-card-error">
          {error}
        </p>
      )}
    </div>
  )
})
