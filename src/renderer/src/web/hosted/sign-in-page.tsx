import { useState } from 'react'
import { AlertCircleIcon, ArrowUpRight01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { AccountStatus } from '@shared/account'
import { BrandIcon } from '@renderer/components/brand'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'

type SignedOut = Extract<AccountStatus, { state: 'signed-out' }>

/**
 * The hosted client's first page while signed out: nothing else of Kettu shows until the browser
 * signs in, as every cloud service asks. Why it was signed out, or why the sign-in did not
 * finish, shows above the button.
 */
export function SignInPage({
  status,
  pairing,
  onSignIn,
}: {
  status: SignedOut
  /** A pairing code waits for the sign-in. */
  pairing: boolean
  onSignIn(): void
}) {
  const { t } = useTranslation('web')
  const [busy, setBusy] = useState(false)
  const problem = status.reason
    ? t(`hosted.signIn.reasons.${status.reason}`)
    : status.failure
      ? t(`hosted.signIn.failures.${status.failure}`)
      : null

  return (
    <main className="flex min-h-dvh items-center justify-center bg-app px-5 py-10 text-primary">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col items-start gap-4">
          <BrandIcon size={48} />
          <h1 className="text-xl font-semibold">{t('hosted.signIn.title')}</h1>
          <p className="text-sm text-secondary">{t('hosted.signIn.intro')}</p>
          {pairing && <p className="text-sm text-secondary">{t('hosted.signIn.pairing')}</p>}
        </div>

        {problem && (
          <Alert variant="warning">
            <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={1.9} aria-hidden />
            <AlertDescription>{problem}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy}
            onClick={() => {
              setBusy(true)
              onSignIn()
            }}
          >
            {busy && <Spinner data-icon="inline-start" />}
            {t('hosted.signIn.button')}
          </Button>
          {status.devicesUrl && (
            <a
              href={status.devicesUrl}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ variant: 'ghost' })}
            >
              {t('hosted.signIn.devices')}
              <HugeiconsIcon
                icon={ArrowUpRight01Icon}
                strokeWidth={1.9}
                data-icon="inline-end"
                aria-hidden
              />
            </a>
          )}
        </div>

        <p className="text-xs text-secondary">{t('hosted.signIn.own')}</p>
      </div>
    </main>
  )
}
