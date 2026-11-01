import { useEffect, useRef, useState, type FormEvent } from 'react'
import { CircleAlertIcon, CircleXIcon, ShieldAlertIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { parseBrowserPairingLink, type PairingPayload } from '@shared/remote/pairing'
import { BrandIcon } from '@renderer/components/brand'
import { Alert, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import { Field, FieldError, FieldLabel } from '@renderer/components/ui/field'
import { Input } from '@renderer/components/ui/input'
import { Spinner } from '@renderer/components/ui/spinner'
import type { PairProgress } from './pair'

export type PairingNotice = 'removed' | null

/**
 * The page an unpaired browser shows: how to get a code from the computer, a field for its link,
 * and the pairing as it goes. A code in the page's own address starts at once.
 */
export function PairingPage({
  initial,
  notice,
  deviceName,
  onPair,
}: {
  initial: PairingPayload | null
  notice: PairingNotice
  deviceName: string
  onPair(payload: PairingPayload, progress: (state: PairProgress) => void): Promise<boolean>
}) {
  const [link, setLink] = useState('')
  const [invalid, setInvalid] = useState(false)
  const [progress, setProgress] = useState<PairProgress | null>(null)
  const [added, setAdded] = useState(false)
  const started = useRef(false)

  const start = (payload: PairingPayload): void => {
    setInvalid(false)
    void onPair(payload, setProgress).then(setAdded)
  }

  useEffect(() => {
    if (!initial || started.current) return
    started.current = true
    start(initial)
    // Only the code the page opened with starts by itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const payload = parseBrowserPairingLink(link)
    if (!payload) return setInvalid(true)
    start(payload)
  }

  return (
    <PairingView
      notice={notice}
      deviceName={deviceName}
      progress={progress}
      added={added}
      link={link}
      invalid={invalid}
      onLink={(next) => {
        setLink(next)
        setInvalid(false)
      }}
      onSubmit={submit}
    />
  )
}

/** The pairing page in one of its states. */
export function PairingView({
  notice,
  deviceName,
  progress,
  added,
  link,
  invalid,
  onLink,
  onSubmit,
}: {
  notice: PairingNotice
  deviceName: string
  progress: PairProgress | null
  added: boolean
  link: string
  invalid: boolean
  onLink(link: string): void
  onSubmit(event: FormEvent): void
}) {
  const { t } = useTranslation('web')
  const busy = added || progress?.state === 'connecting' || progress?.state === 'waiting'

  return (
    <main className="flex min-h-dvh items-center justify-center bg-app px-5 py-10 text-primary">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col items-start gap-4">
          <BrandIcon size={48} />
          <h1 className="text-xl font-semibold">{t('pair.title')}</h1>
          <p className="text-sm text-secondary">{t('pair.intro')}</p>
        </div>

        {notice === 'removed' && !progress && (
          <Alert variant="warning">
            <CircleAlertIcon />
            <AlertDescription>{t('pair.removed')}</AlertDescription>
          </Alert>
        )}

        {busy ? (
          <div className="flex items-start gap-3 rounded-xl bg-card px-4 py-3.5 shadow-card">
            <Spinner className="mt-0.5" />
            <div className="flex flex-col gap-1 text-sm" aria-live="polite">
              {added ? (
                <span>{t('pair.added')}</span>
              ) : progress?.state === 'waiting' ? (
                <>
                  <span className="font-medium">{t('pair.waiting')}</span>
                  <span className="text-secondary">
                    {t('pair.waitingHint', { name: deviceName })}
                  </span>
                </>
              ) : (
                <span>{t('pair.connecting')}</span>
              )}
            </div>
          </div>
        ) : (
          <form className="flex flex-col gap-3" onSubmit={onSubmit}>
            {progress?.state === 'failed' && (
              <Alert variant="error">
                <CircleXIcon />
                <AlertDescription>{t(`pair.failed.${progress.reason}`)}</AlertDescription>
              </Alert>
            )}
            <Field data-invalid={invalid || undefined}>
              <FieldLabel htmlFor="pairing-link">{t('pair.linkLabel')}</FieldLabel>
              <Input
                id="pairing-link"
                value={link}
                onChange={(event) => onLink(event.target.value)}
                placeholder={t('pair.linkPlaceholder')}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-invalid={invalid || undefined}
              />
              {invalid && <FieldError>{t('pair.notLink')}</FieldError>}
            </Field>
            <Button type="submit" disabled={link.trim() === ''} className="self-start">
              {progress?.state === 'failed' ? t('pair.again') : t('pair.submit')}
            </Button>
          </form>
        )}

        <InsecureNote />
      </div>
    </main>
  )
}

/** On a page opened over plain http, what that leaves open; nothing on https or localhost. */
export function InsecureNote({ className }: { className?: string }) {
  const { t } = useTranslation('web')
  if (window.isSecureContext) return null
  return (
    <Alert variant="warning" className={className}>
      <ShieldAlertIcon />
      <AlertTitle>{t('insecure.title')}</AlertTitle>
      <AlertDescription>{t('insecure.body')}</AlertDescription>
    </Alert>
  )
}
