import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Alert02Icon,
  ArrowDown01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Search01Icon,
  SquareLock02Icon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { Trans, useTranslation } from 'react-i18next'
import type {
  SignInChoice,
  SignInOffer,
  SignInResult,
  SignInSite,
  SignInSource,
} from '@shared/signins'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { RadioGroup, RadioGroupItem } from '@renderer/components/ui/radio-group'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage } from '@renderer/lib/host'
import { useDefaultBrowser } from '@renderer/stores/site-icons'
import {
  bringable,
  closeSignInsDialog,
  loadSources,
  preferredSource,
  useSignInsStore,
  type SignInsDialog as DialogRequest,
} from '@renderer/stores/sign-ins'
import { BrowserMark, KeychainPrompt, SiteTile } from './sign-in-parts'
import { safeStorageItem, shortBrowserName, usedAgo } from './sign-in-text'

/** The dialog that brings sign-ins from the user's own browsers, mounted once for the window. */
export function SignInsDialog() {
  const dialog = useSignInsStore((s) => s.dialog)
  // The last request stays drawn while the dialog closes.
  const [shown, setShown] = useState(dialog)
  if (dialog && dialog !== shown) setShown(dialog)
  const close = () => {
    void window.kettu.signIns.cancel().catch(() => {})
    closeSignInsDialog()
  }
  return (
    <Dialog open={!!dialog} onOpenChange={(open) => !open && close()}>
      <DialogContent
        showCloseButton={false}
        className="ksi gap-0 p-0 sm:max-w-[min(560px,calc(100vw-48px))]"
      >
        {shown?.mode === 'all' && <BringAll key={shown.id} onClose={close} />}
        {shown?.mode === 'one' && <BringOne key={shown.id} request={shown} onClose={close} />}
      </DialogContent>
    </Dialog>
  )
}

type Step = 'source' | 'sites' | 'import'

/** What bringing ended in, as the last step shows it; null while it runs. */
type Outcome = SignInResult | null

const STEPS: Step[] = ['source', 'sites', 'import']

function Head({ title, step, onClose }: { title: string; step: Step | null; onClose: () => void }) {
  const { t } = useTranslation('browser')
  const at = step ? STEPS.indexOf(step) : -1
  return (
    <header className="ksi-head">
      <span className="ksi-head__title">
        <DialogTitle>{title}</DialogTitle>
        {step && (
          <ol className="ksi-steps" aria-label={t('signIns.steps.label', { step: at + 1 })}>
            {STEPS.map((name, i) => (
              <li
                key={name}
                data-on={i === at || undefined}
                data-done={i < at || undefined}
                aria-current={i === at ? 'step' : undefined}
              >
                {i < at ? (
                  <HugeiconsIcon icon={Tick02Icon} size={11} strokeWidth={1.9} aria-hidden />
                ) : (
                  <i aria-hidden>{i + 1}</i>
                )}
                {t(`signIns.steps.${name === 'source' ? 'browser' : name}`)}
              </li>
            ))}
          </ol>
        )}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t('signIns.actions.close')}
        onClick={onClose}
      >
        <HugeiconsIcon icon={Cancel01Icon} strokeWidth={1.9} />
      </Button>
    </header>
  )
}

function Foot({ note, children }: { note?: ReactNode; children: ReactNode }) {
  return (
    <footer className="ksi-foot">
      <span className="ksi-note">{note}</span>
      {children}
    </footer>
  )
}

/** The three steps: a browser and profile, its sites, then the import. */
function BringAll({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('browser')
  const defaultBrowser = useDefaultBrowser().name
  const [sources, setSources] = useState<SignInSource[] | null>(null)
  const [sourcesError, setSourcesError] = useState<string | null>(null)
  const [choice, setChoice] = useState<SignInChoice | null>(null)
  const [step, setStep] = useState<Step>('source')
  const [sites, setSites] = useState<{ choice: SignInChoice; list: SignInSite[] } | null>(null)
  const [sitesError, setSitesError] = useState<string | null>(null)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [outcome, setOutcome] = useState<Outcome>(null)
  const [reads, setReads] = useState(0)

  useEffect(() => {
    let cancelled = false
    loadSources(true).then(
      (list) => {
        if (cancelled) return
        setSources(list)
        const preferred = preferredSource(list, defaultBrowser)
        if (preferred) setChoice({ browser: preferred.browser, profile: preferred.profiles[0]!.id })
      },
      (error: unknown) => {
        if (!cancelled) setSourcesError(errorMessage(error))
      },
    )
    return () => {
      cancelled = true
    }
    // Read once a time the dialog opens; the default browser only picks the first choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reads])

  const source = sources?.find((s) => s.browser === choice?.browser) ?? null
  const listed = sites && same(sites.choice, choice) ? sites.list : null

  const toSites = () => {
    if (!choice) return
    setStep('sites')
    if (listed) return
    setSites(null)
    setSitesError(null)
    const asked = choice
    window.kettu.signIns.sites(asked).then(
      (list) => {
        setSites({ choice: asked, list })
        setPicked(new Set(list.filter((site) => site.group === 'recent').map((site) => site.site)))
      },
      (error: unknown) => setSitesError(errorMessage(error)),
    )
  }

  const bring = () => {
    if (!choice || picked.size === 0) return
    setStep('import')
    setOutcome(null)
    window.kettu.signIns.bring({ ...choice, sites: [...picked] }).then(
      (result) => {
        if (result.ok || result.reason !== 'cancelled') setOutcome(result)
        else setStep('sites')
      },
      () => setOutcome({ ok: false, reason: 'unreadable' }),
    )
  }

  const browserName = shortBrowserName(source?.name ?? '')
  const keychain = !!source?.keychain
  const done = step === 'import' && outcome?.ok === true

  return (
    <>
      <Head title={t('signIns.title')} step={done ? null : step} onClose={onClose} />
      <div className="ksi-body" key={step + (outcome ? 'end' : '')}>
        {step === 'source' && (
          <Sources
            sources={sources}
            error={sourcesError}
            choice={choice}
            onChoose={setChoice}
            onRetry={() => {
              setSourcesError(null)
              setReads((n) => n + 1)
            }}
          />
        )}
        {step === 'sites' && (
          <Sites
            sites={listed}
            error={sitesError}
            browser={browserName}
            picked={picked}
            onPick={(site, on) =>
              setPicked((current) => {
                const next = new Set(current)
                if (on) next.add(site)
                else next.delete(site)
                return next
              })
            }
          />
        )}
        {step === 'import' &&
          (outcome === null ? (
            keychain && choice ? (
              <Unlock browser={choice.browser} name={browserName}>
                {t('signIns.unlock.body', { count: picked.size })}
              </Unlock>
            ) : (
              <Working />
            )
          ) : (
            <End outcome={outcome} browser={browserName} />
          ))}
      </div>
      {step === 'source' && (
        <Foot
          note={
            keychain && (
              <>
                <HugeiconsIcon icon={SquareLock02Icon} size={13} strokeWidth={1.9} aria-hidden />
                {t('signIns.nothingUnlocked')}
              </>
            )
          }
        >
          <Button size="sm" variant="outline" onClick={onClose}>
            {t('signIns.actions.cancel')}
          </Button>
          <Button size="sm" disabled={!choice} onClick={toSites}>
            {t('signIns.actions.continue')}
          </Button>
        </Foot>
      )}
      {step === 'sites' && (
        <Foot
          note={
            listed && (
              <span>
                <Trans
                  t={t}
                  i18nKey={keychain ? 'signIns.pickedKeychain' : 'signIns.picked'}
                  values={{ picked: picked.size, total: listed.length }}
                  components={{ b: <b /> }}
                />
              </span>
            )
          }
        >
          <Button size="sm" variant="outline" onClick={() => setStep('source')}>
            {t('signIns.actions.back')}
          </Button>
          <Button size="sm" disabled={picked.size === 0} onClick={bring}>
            {t('signIns.bring', { count: picked.size })}
          </Button>
        </Foot>
      )}
      {step === 'import' && outcome === null && (
        <Foot
          note={
            <>
              <Spinner className="size-3.5" />
              {keychain ? t('signIns.waiting') : t('signIns.bringing')}
            </>
          }
        >
          <Button
            size="sm"
            variant="outline"
            onClick={() => void window.kettu.signIns.cancel().catch(() => {})}
          >
            {t('signIns.actions.cancel')}
          </Button>
        </Foot>
      )}
      {step === 'import' && outcome?.ok && (
        <Foot note={t('signIns.done.note')}>
          <Button size="sm" onClick={onClose}>
            {t('signIns.actions.done')}
          </Button>
        </Foot>
      )}
      {step === 'import' && outcome && !outcome.ok && (
        <Foot>
          <Button size="sm" variant="outline" onClick={onClose}>
            {t('signIns.actions.close')}
          </Button>
          <Button size="sm" onClick={bring}>
            {t('signIns.actions.tryAgain')}
          </Button>
        </Foot>
      )}
    </>
  )
}

function same(a: SignInChoice | null, b: SignInChoice | null): boolean {
  return !!a && !!b && a.browser === b.browser && a.profile === b.profile
}

function Sources({
  sources,
  error,
  choice,
  onChoose,
  onRetry,
}: {
  sources: SignInSource[] | null
  error: string | null
  choice: SignInChoice | null
  onChoose: (choice: SignInChoice) => void
  onRetry: () => void
}) {
  const { t } = useTranslation('browser')
  return (
    <>
      <p className="ksi-lead">{t('signIns.lead')}</p>
      {error ? (
        <div className="ksi-list">
          <p className="ksi-empty">
            {t('signIns.readFailed', { error })}{' '}
            <Button size="xs" variant="link" onClick={onRetry}>
              {t('signIns.actions.tryAgain')}
            </Button>
          </p>
        </div>
      ) : sources === null ? (
        <div className="ksi-list" aria-busy>
          {[0.42, 0.3, 0.36].map((width) => (
            <div key={width} className="ksi-src">
              <Skeleton className="size-5.5 rounded-full" />
              <span className="ksi-src__text">
                <Skeleton className="h-3" style={{ width: `${width * 100}%` }} />
                <Skeleton className="h-2.5 w-24" />
              </span>
            </div>
          ))}
        </div>
      ) : sources.length === 0 ? (
        <div className="ksi-list">
          <p className="ksi-empty">{t('signIns.noBrowsers')}</p>
        </div>
      ) : (
        <RadioGroup
          aria-label={t('signIns.browsers')}
          value={choice?.browser ?? null}
          onValueChange={(browser) => {
            const source = sources.find((s) => s.browser === browser)
            if (source?.profiles[0])
              onChoose({ browser: source.browser, profile: source.profiles[0].id })
          }}
          className="ksi-list gap-0"
        >
          {sources.map((source) => (
            <SourceRow
              key={source.browser}
              source={source}
              chosen={choice?.browser === source.browser ? choice : null}
              onProfile={(profile) => onChoose({ browser: source.browser, profile })}
            />
          ))}
        </RadioGroup>
      )}
    </>
  )
}

function SourceRow({
  source,
  chosen,
  onProfile,
}: {
  source: SignInSource
  chosen: SignInChoice | null
  onProfile: (profile: string) => void
}) {
  const { t } = useTranslation('browser')
  const usable = bringable(source)
  const profile =
    source.profiles.find((p) => p.id === chosen?.profile) ?? source.profiles[0] ?? null
  const reason =
    source.unavailable === 'safari'
      ? t('signIns.unavailable.safari')
      : source.unavailable === 'windows-locked'
        ? t('signIns.unavailable.windowsLocked', { browser: shortBrowserName(source.name) })
        : source.unavailable === 'linux-keyring'
          ? t('signIns.unavailable.linuxKeyring', { browser: shortBrowserName(source.name) })
          : null
  return (
    <label className="ksi-src" data-disabled={usable ? undefined : ''}>
      <span className="ksi-src__mark">
        <BrowserMark browser={source} size={22} />
      </span>
      <span className="ksi-src__text">
        <b>{source.name}</b>
        <small>
          {reason ??
            (profile && (
              <>
                {source.profiles.length > 1 ? (
                  <ProfileMenu
                    source={source}
                    profile={profile.id}
                    label={profileLabel(profile)}
                    onProfile={onProfile}
                  />
                ) : (
                  source.profiles.length === 1 &&
                  profile.email && <span>{profileLabel(profile)}</span>
                )}
                <span>{t('signIns.sites', { count: profile.sites })}</span>
              </>
            ))}
        </small>
      </span>
      <RadioGroupItem value={source.browser} disabled={!usable} />
    </label>
  )
}

function profileLabel(profile: { name: string; email: string | null }): string {
  return profile.email ? `${profile.name} · ${profile.email}` : profile.name
}

function ProfileMenu({
  source,
  profile,
  label,
  onProfile,
}: {
  source: SignInSource
  profile: string
  label: string
  onProfile: (profile: string) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="ksi-profile">
        {label}
        <HugeiconsIcon icon={ArrowDown01Icon} size={12} strokeWidth={1.9} aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={profile} onValueChange={(value: string) => onProfile(value)}>
          {source.profiles.map((p) => (
            <DropdownMenuRadioItem key={p.id} value={p.id}>
              {profileLabel(p)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Sites({
  sites,
  error,
  browser,
  picked,
  onPick,
}: {
  sites: SignInSite[] | null
  error: string | null
  browser: string
  picked: ReadonlySet<string>
  onPick: (site: string, on: boolean) => void
}) {
  const { t } = useTranslation('browser')
  const [query, setQuery] = useState('')
  const [more, setMore] = useState(false)
  const search = useRef<HTMLInputElement>(null)
  useEffect(() => search.current?.focus(), [sites])
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matching = (sites ?? []).filter((site) => !q || site.site.includes(q))
    return {
      recent: matching.filter((site) => site.group === 'recent'),
      held: matching.filter((site) => site.group === 'held'),
      google: matching.some((site) => site.group === 'google'),
      other: matching.filter((site) => site.group === 'other'),
      none: matching.length === 0,
    }
  }, [sites, query])
  if (error) return <p className="ksi-empty">{error}</p>
  if (!sites) {
    return (
      <div className="flex flex-col gap-2.5 py-1" aria-busy>
        <Skeleton className="h-8.5 w-full rounded-[10px]" />
        {[0.5, 0.38, 0.44, 0.32].map((width) => (
          <div key={width} className="flex items-center gap-2.5 px-2">
            <Skeleton className="size-4 rounded-sm" />
            <Skeleton className="h-3" style={{ width: `${width * 100}%` }} />
          </div>
        ))}
      </div>
    )
  }
  if (sites.length === 0) return <p className="ksi-empty">{t('signIns.noSites', { browser })}</p>
  const searching = query.trim() !== ''
  return (
    <>
      <label className="ksi-search">
        <HugeiconsIcon icon={Search01Icon} size={14} strokeWidth={1.9} aria-hidden />
        <input
          ref={search}
          value={query}
          placeholder={t('signIns.search', { count: sites.length })}
          aria-label={t('signIns.searchLabel')}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </label>
      <div className="ksi-scroll">
        {groups.none && (
          <p className="ksi-empty">{t('signIns.noMatch', { query: query.trim() })}</p>
        )}
        {groups.recent.length > 0 && (
          <SiteGroup title={t('signIns.groups.recent')} note={t('signIns.groups.recentNote')}>
            {groups.recent.map((site) => (
              <SiteRow key={site.site} site={site} on={picked.has(site.site)} onPick={onPick} />
            ))}
          </SiteGroup>
        )}
        {groups.held.length > 0 && (
          <SiteGroup title={t('signIns.groups.held')} note={t('signIns.groups.heldNote')}>
            {groups.held.map((site) => (
              <SiteRow key={site.site} site={site} on={picked.has(site.site)} onPick={onPick} />
            ))}
          </SiteGroup>
        )}
        {groups.google && (
          <SiteGroup title={t('signIns.groups.google')}>
            <div className="ksi-site" data-off="">
              <SiteTile site="google.com" />
              <span className="ksi-site__text">
                <b>accounts.google.com</b>
                <small>{t('signIns.google', { browser })}</small>
              </span>
            </div>
          </SiteGroup>
        )}
        {groups.other.length > 0 &&
          (more || searching ? (
            <SiteGroup>
              {groups.other.map((site) => (
                <SiteRow key={site.site} site={site} on={picked.has(site.site)} onPick={onPick} />
              ))}
            </SiteGroup>
          ) : (
            <button
              type="button"
              className="ksi-more"
              aria-expanded={false}
              onClick={() => setMore(true)}
            >
              <HugeiconsIcon icon={ArrowDown01Icon} size={13} strokeWidth={1.9} aria-hidden />
              {t('signIns.more', { count: groups.other.length })}
            </button>
          ))}
      </div>
    </>
  )
}

function SiteGroup({
  title,
  note,
  children,
}: {
  title?: string
  note?: string
  children: ReactNode
}) {
  return (
    <section className="ksi-group" aria-label={title}>
      {title && (
        <span className="ksi-group__label">
          {title}
          {note && <small>{note}</small>}
        </span>
      )}
      {children}
    </section>
  )
}

function SiteRow({
  site,
  on,
  onPick,
}: {
  site: SignInSite
  on: boolean
  onPick: (site: string, on: boolean) => void
}) {
  const { t } = useTranslation('browser')
  return (
    <label className="ksi-site">
      <Checkbox checked={on} onCheckedChange={(checked) => onPick(site.site, checked)} />
      <SiteTile site={site.site} />
      <span className="ksi-site__text">
        <b>{site.site}</b>
      </span>
      <small className="ksi-site__note">
        {site.kind ? t(`signIns.kind.${site.kind}`) : usedAgo(site.lastUsed, t)}
      </small>
    </label>
  )
}

/** macOS's prompt drawn beside what to do in it, while Kettu waits for the answer. */
function Unlock({
  browser,
  name,
  site,
  children,
}: {
  browser: SignInChoice['browser']
  name: string
  site?: ReactNode
  children: ReactNode
}) {
  const { t } = useTranslation('browser')
  return (
    <div className="ksi-unlock">
      <KeychainPrompt item={safeStorageItem(browser)} />
      <div className="ksi-how">
        {site}
        <b>{t('signIns.unlock.title')}</b>
        <p>{children}</p>
        <p>{t('signIns.unlock.always', { browser: name })}</p>
      </div>
    </div>
  )
}

function Working() {
  const { t } = useTranslation('browser')
  return (
    <div className="ksi-result">
      <Spinner className="size-5 text-(--shell-muted)" />
      <p>{t('signIns.bringing')}</p>
    </div>
  )
}

function End({ outcome, browser }: { outcome: SignInResult; browser: string }) {
  const { t } = useTranslation('browser')
  if (outcome.ok && outcome.sites.length > 0) {
    return (
      <div className="ksi-result">
        <span className="ksi-result__mark">
          <HugeiconsIcon icon={CheckmarkCircle02Icon} size={26} strokeWidth={1.9} aria-hidden />
        </span>
        <b>{t('signIns.done.title', { count: outcome.sites.length })}</b>
        <p>{t('signIns.done.body')}</p>
        <span className="ksi-chips">
          {outcome.sites.map((site) => (
            <span key={site} className="ksi-chip">
              <SiteTile site={site} />
              {site}
            </span>
          ))}
        </span>
      </div>
    )
  }
  const [title, body] = outcome.ok
    ? [t('signIns.done.none'), t('signIns.done.noneBody', { browser })]
    : outcome.reason === 'denied'
      ? [t('signIns.denied.title', { browser }), t('signIns.denied.body')]
      : [t('signIns.failed.title', { browser }), t('signIns.failed.body', { browser })]
  return (
    <div className="ksi-result" data-tone="warn" role="alert">
      <span className="ksi-result__mark">
        <HugeiconsIcon icon={Alert02Icon} size={26} strokeWidth={1.9} aria-hidden />
      </span>
      <b>{title}</b>
      <p>{body}</p>
    </div>
  )
}

/**
 * One site's sign-in from the browser that offers it: macOS asks at once, and on success the
 * dialog closes and the session's page loads again, signed in.
 */
function BringOne({
  request,
  onClose,
}: {
  request: Extract<DialogRequest, { mode: 'one' }>
  onClose: () => void
}) {
  const { t } = useTranslation('browser')
  const { offer, sessionId } = request
  const [outcome, setOutcome] = useState<Outcome>(null)
  const [tries, setTries] = useState(0)
  const browser = shortBrowserName(offer.browserName)

  useEffect(() => {
    let cancelled = false
    window.kettu.signIns
      .bring({ browser: offer.browser, profile: offer.profile, sites: [offer.site] })
      .then(
        (result) => {
          if (cancelled) return
          if (result.ok && result.sites.length > 0) {
            toast(t('signIns.signedIn', { site: offer.site, browser }))
            if (sessionId) void window.kettu.browser.reload(sessionId).catch(() => {})
            closeSignInsDialog()
          } else if (result.ok || result.reason !== 'cancelled') setOutcome(result)
        },
        () => {
          if (!cancelled) setOutcome({ ok: false, reason: 'unreadable' })
        },
      )
    return () => {
      cancelled = true
    }
    // Each try asks once; the offer stays the same while the dialog is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tries])

  return (
    <>
      <Head title={t('signIns.titleOne', { browser })} step={null} onClose={onClose} />
      <div className="ksi-body" key={outcome ? 'end' : `wait-${tries}`}>
        {outcome ? (
          <End outcome={outcome} browser={browser} />
        ) : offer.keychain ? (
          <Unlock browser={offer.browser} name={browser} site={<OneSite offer={offer} />}>
            {t('signIns.unlock.bodyOne')}
          </Unlock>
        ) : (
          <Working />
        )}
      </div>
      {outcome ? (
        <Foot>
          <Button size="sm" variant="outline" onClick={onClose}>
            {sessionId ? t('signIns.actions.signInHere') : t('signIns.actions.close')}
          </Button>
          {!outcome.ok && (
            <Button
              size="sm"
              onClick={() => {
                setOutcome(null)
                setTries((n) => n + 1)
              }}
            >
              {t('signIns.actions.tryAgain')}
            </Button>
          )}
        </Foot>
      ) : (
        <Foot
          note={
            <>
              <Spinner className="size-3.5" />
              {offer.keychain ? t('signIns.waiting') : t('signIns.bringing')}
            </>
          }
        >
          <Button size="sm" variant="outline" onClick={onClose}>
            {t('signIns.actions.cancel')}
          </Button>
        </Foot>
      )}
    </>
  )
}

function OneSite({ offer }: { offer: SignInOffer }) {
  const { t } = useTranslation('browser')
  return (
    <span className="ksi-onesite">
      <SiteTile site={offer.site} />
      <b>{offer.site}</b>
      <small>
        {t('signIns.from', {
          browser: shortBrowserName(offer.browserName),
          profile: offer.profileName,
        })}
      </small>
    </span>
  )
}
