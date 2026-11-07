import { useState, type ReactNode } from 'react'
import { Copy01Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '@renderer/lib/host'
import { confirmDebugRestart, useDebugStore } from '@renderer/stores/debug'
import { ControlError, IconAction, SetButton } from './controls'
import { BlockLine } from './rows'

/**
 * Settings › Advanced's debug mode: Restart in debug mode while it is off; while it is on, each
 * port with a copy button, and Restart normally.
 */
export function DebugModeRow({ text }: { text: ReactNode }) {
  const { t } = useTranslation('settings')
  const status = useDebugStore((s) => s.status)
  const [error, setError] = useState<string | null>(null)
  if (!status.on) {
    return (
      <BlockLine text={text}>
        <SetButton onClick={() => confirmDebugRestart()}>
          {t('advanced.debugMode.restart')}
        </SetButton>
      </BlockLine>
    )
  }
  const restart = () => {
    setError(null)
    window.kettu.debug.restart(false).catch((e: unknown) => setError(errorMessage(e)))
  }
  const cdpNote =
    status.cdp === 'pipe'
      ? t('advanced.debugMode.pipe')
      : status.cdp === 'failed'
        ? t('advanced.debugMode.cdpFailed')
        : undefined
  return (
    <>
      <BlockLine text={text}>
        <ControlError error={error} />
        <SetButton onClick={restart}>{t('advanced.debugMode.restartNormally')}</SetButton>
      </BlockLine>
      <ul className="k-inset k-list k-debug-ports">
        <PortLine
          name={t('advanced.debugMode.cdp')}
          value={typeof status.cdp === 'number' ? `127.0.0.1:${status.cdp}` : null}
          note={cdpNote}
        />
        {status.inspectors.map(({ name, url }) => (
          <PortLine key={name} name={name} value={url} />
        ))}
      </ul>
    </>
  )
}

/** A port's address with a copy button; `note` stands in for one that has none, else it waits. */
function PortLine({ name, value, note }: { name: string; value: string | null; note?: string }) {
  const { t } = useTranslation('settings')
  const [copied, setCopied] = useState(false)
  return (
    <li className="k-list__row">
      <span className="k-list__name">{name}</span>
      <span data-selectable="" className="k-mono" title={value ?? undefined}>
        {value ?? note ?? t('advanced.debugMode.waiting')}
      </span>
      {value !== null && (
        <IconAction
          label={t('advanced.debugMode.copy', { name })}
          icon={copied ? Tick02Icon : Copy01Icon}
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
        />
      )}
    </li>
  )
}
