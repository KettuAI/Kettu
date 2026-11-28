import { useState, type ReactNode } from 'react'
import { Copy01Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { DEBUG_OFF } from '@shared/debug'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage } from '@renderer/lib/host'
import { useHostContext } from '@renderer/lib/host-features'
import { isWeb } from '@renderer/lib/platform'
import { confirmDebugRestart } from '@renderer/stores/debug'
import { useHostScope } from '@renderer/stores/host-scope'
import { ControlError, IconAction, Pill, SetButton } from './controls'
import { BlockLine } from './rows'

/**
 * Settings › Advanced's debug mode: on this computer, Restart in debug mode while it is off; on
 * paired devices, turning debug mode on stays on the host itself while an active debug run shows
 * its ports and (on desktop hosts) Restart normally.
 */
export function DebugModeRow({
  text,
  hostName: givenHostName,
}: {
  text: ReactNode
  hostName?: string
}) {
  const { t } = useTranslation('settings')
  const scope = useHostScope()
  const remote = isWeb || scope.hostId !== null
  const contextHost = useHostContext().host ?? ''
  const hostName = givenHostName ?? contextHost
  const diagnostics = scope.useDiagnosticsStore((s) => s.status)
  const status = diagnostics?.debug ?? DEBUG_OFF
  const canRestartNormally = diagnostics?.canRestartNormally ?? !remote
  const [error, setError] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)

  if (!status.on) {
    if (remote) {
      return (
        <>
          <BlockLine text={text}>
            <Pill>{t('advanced.debugMode.off')}</Pill>
          </BlockLine>
          <p className="k-subnote">
            {t(hostName ? 'advanced.debugMode.localOnly' : 'advanced.debugMode.localOnlyGeneric', {
              host: hostName,
            })}
          </p>
        </>
      )
    }
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
    setRestarting(true)
    scope.api.diagnostics
      .restartNormally()
      .then(
        () => {
          if (remote) {
            toast(
              t(hostName ? 'advanced.debugMode.restarted' : 'advanced.debugMode.restartedGeneric', {
                host: hostName,
              }),
            )
          }
        },
        (e: unknown) => setError(errorMessage(e)),
      )
      .finally(() => setRestarting(false))
  }

  const cdpNote =
    status.cdp === 'pipe'
      ? t('advanced.debugMode.pipe')
      : status.cdp === 'failed'
        ? t('advanced.debugMode.cdpFailed')
        : undefined
  const showCdp = status.cdp !== null || canRestartNormally
  const showPorts = showCdp || status.inspectors.length > 0

  return (
    <>
      <BlockLine text={text}>
        <ControlError error={error} />
        {canRestartNormally ? (
          <SetButton loading={restarting} onClick={restart}>
            {t(restarting ? 'advanced.debugMode.restarting' : 'advanced.debugMode.restartNormally')}
          </SetButton>
        ) : (
          <Pill tone="warning">{t('advanced.debugMode.on')}</Pill>
        )}
      </BlockLine>
      {!canRestartNormally && (
        <p className="k-subnote">
          {t(
            hostName
              ? 'advanced.debugMode.restartOnHost'
              : 'advanced.debugMode.restartOnHostGeneric',
            { host: hostName },
          )}
        </p>
      )}
      {showPorts && (
        <ul className="k-inset k-list k-debug-ports">
          {showCdp && (
            <PortLine
              name={t('advanced.debugMode.cdp')}
              value={typeof status.cdp === 'number' ? `127.0.0.1:${status.cdp}` : null}
              note={cdpNote}
            />
          )}
          {status.inspectors.map(({ name, url }) => (
            <PortLine key={name} name={name} value={url} />
          ))}
        </ul>
      )}
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
