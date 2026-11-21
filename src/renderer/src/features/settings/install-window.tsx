// The install window every Install opens first: the ways to install a harness, and for the one
// picked what it installs, which version, where it comes from, the folder it goes into, its size
// when known and what it needs, before anything runs.

import { useEffect, useState, type ReactNode } from 'react'
import { ArrowUpRight01Icon, Cancel01Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type {
  AgentStatus,
  InstallDetails,
  InstallNeed,
  InstallOffer,
  InstallRoute,
  InstallSource,
} from '@shared/agent-host'
import type { HarnessId } from '@shared/thread'
import { Icon } from '@renderer/components/affect/app-shell'
import { Dialog, DialogClose } from '@renderer/components/ui/dialog'
import { RadioGroup, RadioGroupTile } from '@renderer/components/ui/radio-group'
import { bytes } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { hostScope, HostScopeContext, LOCAL_SCOPE, useHostScope } from '@renderer/stores/host-scope'
import { useAction, VENDORS } from './agent-helpers'
import { WithCode } from './agent-parts'
import { ControlError, CopyAction, LinkButton, PathText, SetButton, Skel } from './controls'
import { closeInstall, startInstall, useInstallWindow } from './harness-install'
import {
  SETTINGS_TILE,
  SettingsDialogBody,
  SettingsDialogContent,
  SettingsDialogFooter,
  SettingsDialogHeader,
  SettingsField,
} from './settings-dialog'

type SettingsT = ReturnType<typeof useTranslation<'settings'>>['t']

/** Mounted once for the window, from the first time an Install opens it. */
export default function InstallWindow() {
  const target = useInstallWindow((s) => s.target)
  // The last harness stays drawn while the window closes.
  const [shown, setShown] = useState(target)
  if (target && target !== shown) setShown(target)
  if (!shown) return null
  const scope = shown.hostId ? hostScope(shown.hostId) : LOCAL_SCOPE
  return (
    <HostScopeContext.Provider value={scope}>
      <InstallDialog
        key={`${shown.hostId ?? ''} ${shown.harness}`}
        harness={shown.harness}
        open={!!target}
        onOpenChange={(open) => !open && closeInstall()}
      />
    </HostScopeContext.Provider>
  )
}

/** Whether the route can be installed now: its tool is there and so is all it needs. */
function installable(route: InstallRoute): boolean {
  return route.available && !route.firstStart && route.details.needs.every((need) => need.ok)
}

/**
 * The offer for the harness, asked when the window opens and again when the environment or the
 * harness's state changes, as after Reload environment.
 */
function useOffer(
  harness: HarnessId,
  open: boolean,
): { offer: InstallOffer | null; error: string | null } {
  const { request, useAgentsStore } = useHostScope()
  const environment = useAgentsStore((s) => s.environment)
  const state = useAgentsStore((s) => s.byId[harness]?.state)
  const [answer, setAnswer] = useState<{ offer: InstallOffer | null; error: string | null }>({
    offer: null,
    error: null,
  })
  useEffect(() => {
    if (!open) return
    let current = true
    request('agents.installOffer', { agentId: harness }).then(
      (offer) => current && setAnswer({ offer, error: null }),
      (e: unknown) => current && setAnswer({ offer: null, error: errorMessage(e) }),
    )
    return () => {
      current = false
    }
  }, [request, harness, open, environment, state])
  return answer
}

function InstallDialog({
  harness,
  open,
  onOpenChange,
}: {
  harness: HarnessId
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { useAgentsStore, useSettingsStore } = useHostScope()
  const { t } = useTranslation(['settings', 'common'])
  const status = useAgentsStore((s) => s.byId[harness])
  const { offer, error: offerError } = useOffer(harness, open)
  const [picked, setPicked] = useState<InstallRoute['id'] | null>(null)
  const [reload, reloading, reloadError] = useAction()
  if (!status) return null
  const routes = offer?.routes ?? []
  const route = routes.find((r) => r.id === picked) ?? routes.find(installable) ?? routes[0] ?? null
  const ready = !!route && installable(route)
  const body = introText(t, status, offer)
  // A missing program or Node.js sends the user to its page; otherwise the vendor's own guide.
  const guide = status.installUrl ?? offer?.guide ?? null
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The body scrolls between the title and the actions in a short window. */}
      <SettingsDialogContent className="flex flex-col overflow-y-hidden sm:max-w-125">
        <SettingsDialogHeader title={t('harnesses.install.title', { name: status.harnessName })}>
          {body}
        </SettingsDialogHeader>
        <SettingsDialogBody className="min-h-0 overflow-y-auto">
          {routes.length > 1 && (
            <SettingsField label={t('harnesses.install.method')}>
              <RadioGroup
                aria-label={t('harnesses.install.method')}
                value={route?.id ?? null}
                onValueChange={(id) => setPicked(id as InstallRoute['id'])}
                className="kettu-sd__choices"
              >
                {routes.map((r, index) => (
                  <RadioGroupTile
                    key={r.id}
                    value={r.id}
                    disabled={!r.available && !r.firstStart}
                    className={SETTINGS_TILE}
                  >
                    <span className="ui-sg-label">
                      <b className="k-row-title">
                        {routeName(t, r)}
                        {index === 0 && r.available && (
                          <span className="ui-ss-badge" data-tone="ok">
                            {t('harnesses.install.recommended')}
                          </span>
                        )}
                      </b>
                      {!r.available && !r.firstStart ? (
                        <small>{t('agents.install.notFound')}</small>
                      ) : (
                        routes[0]?.id === 'copy' &&
                        r.id !== 'copy' &&
                        status.program && (
                          <small>
                            {t('harnesses.install.usesYours', { command: status.program.command })}
                          </small>
                        )
                      )}
                    </span>
                  </RadioGroupTile>
                ))}
              </RadioGroup>
            </SettingsField>
          )}
          {!offer && !offerError && <FactsLoading />}
          {offerError && <ControlError error={offerError} wrap />}
          {offer && routes.length === 0 && status.detail && (
            <p className="kettu-sd__text" data-selectable="">
              <WithCode text={status.detail} />
            </p>
          )}
          {route && <Facts route={route} />}
          {route?.command && <CommandField route={route} />}
          {route && route.id !== 'copy' && status.installNotice && (
            <p className="kettu-sd__text" data-selectable="">
              {status.installNotice}
            </p>
          )}
          {route && !route.details.needs.every((need) => need.ok) && (
            <p className="kettu-sd__hint">{t('harnesses.install.needsFirst')}</p>
          )}
          {guide && (
            <span>
              <LinkButton href={guide} icon={<Icon icon={ArrowUpRight01Icon} size={14} />}>
                {t('harnesses.install.guide')}
              </LinkButton>
            </span>
          )}
          {(status.program ?? status.binaryCommand) && (
            <ChooseElsewhere harness={harness} onChosen={() => onOpenChange(false)} />
          )}
          <ControlError error={reloadError} />
        </SettingsDialogBody>
        <SettingsDialogFooter>
          <DialogClose render={<SetButton size="md" variant="ghost" />}>
            {t(route?.firstStart && ready ? 'common:actions.close' : 'common:actions.cancel')}
          </DialogClose>
          {route && ready ? (
            <SetButton
              size="md"
              variant="primary"
              onClick={() => {
                void startInstall(useAgentsStore, useSettingsStore, harness, route.id)
                onOpenChange(false)
              }}
            >
              {t('agents.install.button')}
            </SetButton>
          ) : (
            (offer || offerError) &&
            !(route?.firstStart && route.details.needs.every((need) => need.ok)) && (
              <SetButton
                size="md"
                variant="primary"
                loading={reloading}
                onClick={() => reload(() => useAgentsStore.getState().reloadEnvironment())}
              >
                {t('agents.environment.reload')}
              </SetButton>
            )
          )}
        </SettingsDialogFooter>
      </SettingsDialogContent>
    </Dialog>
  )
}

/**
 * The line under the title: who installs what, by the routes the harness has, or while they load
 * by what its status says, so the line does not change once they arrive.
 */
function introText(t: SettingsT, status: AgentStatus, offer: InstallOffer | null): ReactNode {
  const name = status.harnessName
  const first = offer?.routes[0]
  const pkg = status.package
  const uvx = offer ? !!first?.firstStart : !pkg && status.program?.onPath === false
  const copy = offer ? first?.id === 'copy' : !!pkg && !pkg.isSdk
  if (uvx) return t('harnesses.install.bodyUvx', { name })
  if (copy) {
    return status.program?.onPath
      ? t('harnesses.install.bodyCopy', { name, command: status.program.command })
      : t('harnesses.install.bodyCopyPlain', { name })
  }
  if (offer?.routes.length === 0 || (!offer && status.installMethods.length === 0)) {
    return t('harnesses.install.setupBody', { name })
  }
  const vendor = VENDORS[status.harnessId]
  // With one route there is nothing to pick.
  const one = offer ? offer.routes.length === 1 : status.installMethods.length === 1
  if (one) {
    return t(vendor ? 'harnesses.install.bodyOne' : 'harnesses.install.bodyOnePlain', {
      name,
      vendor,
    })
  }
  return t(vendor ? 'harnesses.install.body' : 'harnesses.install.bodyPlain', { name, vendor })
}

function routeName(t: SettingsT, route: InstallRoute): string {
  return route.id === 'copy' ? t('harnesses.install.copyRoute') : t(`harnesses.methods.${route.id}`)
}

/** The host of an address, as the window names where a file comes from. */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

function sourceText(t: SettingsT, source: InstallSource): string {
  switch (source.kind) {
    case 'npm':
      return source.registry
        ? t('harnesses.install.fromNpm', { host: hostOf(source.registry) })
        : t('harnesses.install.fromNpmUnknown')
    case 'registry':
      return t('harnesses.install.fromRegistry', { host: hostOf(source.url) })
    case 'vendor':
      return hostOf(source.url)
    case 'brew':
      return t('harnesses.methods.brew')
    case 'winget':
      return t('harnesses.methods.winget')
    case 'pypi':
      return t('harnesses.install.fromPypi')
  }
}

function needName(t: SettingsT, need: InstallNeed): string {
  if (need.kind !== 'node') return need.kind
  return need.minimum
    ? t('harnesses.install.needsNode', { version: need.minimum })
    : t('harnesses.install.needsNodeAny')
}

/** One need, with a check when it is there, else what was found instead. */
function Need({ need }: { need: InstallNeed }) {
  const { t } = useTranslation('settings')
  const found = need.kind === 'node' && need.found
  return (
    <span className="kettu-sd__need" data-ok={need.ok || undefined}>
      <Icon icon={need.ok ? Tick02Icon : Cancel01Icon} size={14} />
      <span>{needName(t, need)}</span>
      {!need.ok && (
        <span className="k-muted">
          {found
            ? t('harnesses.install.foundVersion', { version: found })
            : t('agents.install.notFound')}
        </span>
      )}
    </span>
  )
}

/** What the picked route installs, as label and value lines. */
function Facts({ route }: { route: InstallRoute }) {
  const { t } = useTranslation('settings')
  const details: InstallDetails = route.details
  const { what, size } = details
  const lines: [string, ReactNode][] = []
  if (what.kind !== 'command') {
    lines.push([t('harnesses.install.factWhat'), <span className="k-mono">{what.name}</span>])
  }
  lines.push([
    t('harnesses.install.factVersion'),
    details.version ? (
      <span className="k-mono">{details.version}</span>
    ) : (
      t('harnesses.install.newest')
    ),
  ])
  lines.push([t('harnesses.install.factSource'), sourceText(t, details.source)])
  if (details.folder) {
    lines.push([t('harnesses.install.factFolder'), <PathText path={details.folder} />])
  } else if (what.kind === 'uvx') {
    lines.push([t('harnesses.install.factFolder'), t('harnesses.install.uvCache')])
  }
  if (size) {
    lines.push([
      t('harnesses.install.factSize'),
      size.packageOnly
        ? t('harnesses.install.sizePackage', { size: bytes(size.bytes) })
        : bytes(size.bytes),
    ])
  }
  if (details.needs.length > 0) {
    lines.push([
      t('harnesses.install.factNeeds'),
      <span className="kettu-sd__needs">
        {details.needs.map((need) => (
          <Need key={need.kind} need={need} />
        ))}
      </span>,
    ])
  }
  return (
    <dl className="kettu-sd__facts">
      {lines.map(([name, value]) => (
        <div key={name} className="kettu-sd__fact">
          <dt>{name}</dt>
          <dd data-selectable="">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function FactsLoading() {
  return (
    <div className="kettu-sd__facts" aria-busy>
      {[140, 90, 180, 220].map((width) => (
        <div key={width} className="kettu-sd__fact">
          <Skel width={56} />
          <Skel width={width} />
        </div>
      ))}
    </div>
  )
}

/** The command a vendor's route runs, or the address of the archive it downloads, to copy. */
function CommandField({ route }: { route: InstallRoute }) {
  const { t } = useTranslation(['settings', 'common'])
  const command = route.command ?? ''
  const archive = route.id === 'archive'
  return (
    <SettingsField label={t(archive ? 'harnesses.install.downloads' : 'harnesses.install.runs')}>
      <div className="k-cmd k-cmd--wrap">
        <code data-selectable="" title={command}>
          {command}
        </code>
        <CopyAction
          text={command}
          label={t(archive ? 'common:actions.copy' : 'harnesses.install.copy')}
        />
      </div>
      <span className="kettu-sd__hint">
        {t(archive ? 'harnesses.install.downloadBody' : 'harnesses.install.ownTerminal')}
      </span>
    </SettingsField>
  )
}

/**
 * The window's link to a program installed elsewhere, and why main refused the one chosen. It
 * mounts with the window's content, so a refusal is gone when the window opens again.
 */
function ChooseElsewhere({ harness, onChosen }: { harness: HarnessId; onChosen: () => void }) {
  const { api } = useHostScope()
  const { t } = useTranslation('settings')
  const [act, , error] = useAction()
  return (
    <>
      <button
        type="button"
        onClick={() =>
          act(() => api.dialogs.chooseAgentBinary(harness).then((path) => path && onChosen()))
        }
        className="k-link k-self-start"
      >
        {t('agents.install.elsewhere')}
      </button>
      {error && <p className="kettu-sd__error">{error}</p>}
    </>
  )
}
