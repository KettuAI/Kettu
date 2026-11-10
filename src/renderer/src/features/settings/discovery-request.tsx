// A device of the same Kettu account asks to be added to this computer, in whatever window is
// open: its owner compares the code and adds it or not.

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { DEVICE_NAME_CHARS } from '@shared/remote/device'
import type { DiscoveryEnd, DiscoveryRequestState } from '@shared/remote/discovery'
import { css as generalCss } from '@renderer/components/affect/settings-general'
import { css as securityCss } from '@renderer/components/affect/settings-security'
import { Dialog } from '@renderer/components/ui/dialog'
import { toast } from '@renderer/components/ui/toast'
import { countdown } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useSeconds } from '@renderer/lib/use-now'
import { SetButton } from './controls'
import { PairCode } from './host-account'
import { closeRequest } from './pair-close'
import { DeviceIcon, DeviceTile } from './remote-parts'
import { deviceLine } from './remote-text'
import {
  DIALOG_FIELD,
  SettingsDialogBody,
  SettingsDialogContent,
  SettingsDialogFooter,
  SettingsDialogHeader,
  SettingsField,
} from './settings-dialog'

type Asking = Extract<DiscoveryRequestState, { state: 'confirm' }>

interface Request {
  requestId: number
  request: Asking
}

/** Ends worth a word once the dialog is gone; Add and Don't add were the owner's own. */
type QuietEnd = Exclude<DiscoveryEnd, 'added' | 'rejected'>

/** Mounted once for the window: shows each request as it comes, and one already waiting. */
export function DiscoveryRequestDialog() {
  const { t } = useTranslation('settings')
  const [shown, setShown] = useState<Request | null>(null)
  const [open, setOpen] = useState(false)
  const current = useRef<number | null>(null)
  // The name the owner added the device under, for the toast once it is added.
  const added = useRef<string | null>(null)
  const asker = useRef('')
  const answerRef = useRef<((add: boolean) => void) | null>(null)

  useEffect(() => {
    let live = true
    const show = (next: Request): void => {
      current.current = next.requestId
      added.current = null
      asker.current = next.request.device.name
      setShown(next)
      setOpen(true)
    }
    const off = window.kettu.remote.onDiscovery(({ requestId, request }) => {
      if (request.state === 'confirm') return show({ requestId, request })
      if (requestId !== current.current) return
      current.current = null
      setOpen(false)
      const reason = request.reason
      if (reason === 'added') {
        if (added.current) toast(t('remote.pair.added', { name: added.current }))
      } else if (reason !== 'rejected') {
        const name = asker.current
        toast(t(`remote.discovery.ended.${reason as QuietEnd}`, { name }), undefined, {
          tone: 'info',
        })
      }
    })
    window.kettu.remote
      .pendingDiscovery()
      .then((pending) => {
        if (live && pending?.request.state === 'confirm' && current.current === null) {
          show({ requestId: pending.requestId, request: pending.request })
        }
      })
      .catch((error: unknown) => console.error('Could not read the discovery request', error))
    return () => {
      live = false
      off()
    }
    // One subscription for the window; t only words the toasts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        if (next) return
        // It needs an answer: a click outside keeps it, Esc or the close button is Don't add.
        if (closeRequest(true, details.reason) === 'reject') answerRef.current?.(false)
      }}
    >
      <SettingsDialogContent className="sm:max-w-110">
        {/* Asked over any screen, so it brings the settings sheets its parts are drawn with. */}
        <style href="ui-settings-general" precedence="default">
          {generalCss}
        </style>
        <style href="ui-settings-security" precedence="default">
          {securityCss}
        </style>
        {shown && (
          <DiscoveryConfirm
            key={shown.requestId}
            request={shown}
            answerRef={answerRef}
            onAnswered={(add, name) => {
              if (add) added.current = name
              else {
                current.current = null
                setOpen(false)
              }
            }}
          />
        )}
      </SettingsDialogContent>
    </Dialog>
  )
}

function DiscoveryConfirm({
  request: { requestId, request },
  answerRef,
  onAnswered,
}: {
  request: Request
  answerRef: { current: ((add: boolean) => void) | null }
  onAnswered: (add: boolean, name: string) => void
}) {
  const { t } = useTranslation('settings')
  const { device, code, expiresAt } = request
  const [name, setName] = useState(device.name)
  const [answered, setAnswered] = useState<'add' | 'reject' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const trimmed = name.trim()
  const valid = trimmed.length > 0 && [...trimmed].length <= DEVICE_NAME_CHARS

  const answer = (add: boolean): void => {
    if (answered || (add && !valid)) return
    setAnswered(add ? 'add' : 'reject')
    setError(null)
    const named = add ? trimmed : ''
    onAnswered(add, named)
    window.kettu.remote.answerDiscovery(requestId, add, named).catch((e: unknown) => {
      // Don't add closed the dialog already; the request ends on its own when it expires.
      if (!add) return
      setAnswered(null)
      setError(errorMessage(e))
    })
  }
  useEffect(() => {
    answerRef.current = answer
    return () => {
      answerRef.current = null
    }
  })

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    answer(true)
  }
  return (
    <form className="contents" onSubmit={submit}>
      <SettingsDialogHeader title={t('remote.discovery.title')}>
        {t('remote.discovery.body', { name: device.name })}
      </SettingsDialogHeader>
      <SettingsDialogBody>
        <div className="k-inset kettu-sd__row kettu-sd__device">
          <DeviceTile large icon={<DeviceIcon device={device} />} />
          <span className="ui-sg-label">
            <b className="k-name">{device.name}</b>
            <small>
              {device.known
                ? `${deviceLine(t, device)} · ${t('remote.discovery.known')}`
                : deviceLine(t, device)}
            </small>
          </span>
        </div>
        <div className="kettu-sd__stack kettu-sd__compare">
          <PairCode code={code} />
          <p className="kettu-sd__hint">{t('remote.discovery.check')}</p>
        </div>
        <SettingsField
          label={t('remote.pair.confirm.name')}
          htmlFor="discovery-name"
          hint={
            error ? (
              <span role="alert" className="kettu-sd__error">
                {error}
              </span>
            ) : (
              t('remote.pair.confirm.nameHint')
            )
          }
        >
          <input
            id="discovery-name"
            value={name}
            autoComplete="off"
            spellCheck={false}
            className={DIALOG_FIELD}
            aria-invalid={!valid || undefined}
            disabled={answered !== null}
            onChange={(event) => setName(event.target.value)}
          />
        </SettingsField>
      </SettingsDialogBody>
      <SettingsDialogFooter start={<ExpiresIn expiresAt={expiresAt} />}>
        <SetButton
          size="md"
          type="button"
          variant="ghost"
          disabled={answered !== null}
          onClick={() => answer(false)}
        >
          {t('remote.discovery.reject')}
        </SetButton>
        <SetButton
          size="md"
          variant="primary"
          type="submit"
          loading={answered === 'add'}
          disabled={!valid || answered !== null}
        >
          {t('remote.pair.confirm.add')}
        </SetButton>
      </SettingsDialogFooter>
    </form>
  )
}

/** How long is left to answer, quietly at the footer's start. */
function ExpiresIn({ expiresAt }: { expiresAt: number }) {
  const { t } = useTranslation('settings')
  const now = useSeconds()
  return (
    <span className="k-num">
      {t('remote.pair.expiresIn', { time: countdown(expiresAt - now) })}
    </span>
  )
}
