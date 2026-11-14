// SOPs in the Marketplace's directory: their rows, the SOP tab's three groups, their section on
// Installed, and adding one from a GitHub file or a .yaml file. They come from the host's SOP
// library, not the catalogs.

import { useId, useState, type CSSProperties, type FormEvent } from 'react'
import { File02Icon, GithubIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { SopEntry } from '@shared/sop'
import { EmptyState, Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { Dialog, DialogClose } from '@renderer/components/ui/dialog'
import { SetButton } from '@renderer/features/settings/controls'
import {
  DIALOG_MONO_FIELD,
  SettingsDialogBody,
  SettingsDialogContent,
  SettingsDialogFooter,
  SettingsDialogHeader,
  SettingsField,
} from '@renderer/features/settings/settings-dialog'
import { errorMessage } from '@renderer/lib/host'
import { currentLocale } from '@renderer/lib/i18n'
import { useHostScope } from '@renderer/stores/host-scope'
import { openMarketplace, type MarketplaceTab } from '@renderer/stores/view'
import { itemKey } from './model'
import { addSopFile, retrySops, showAdded, useSops } from './sop-actions'
import { InstalledCheck, ItemRow, KindTag, QuietNote, SkeletonRows } from './rows'
import {
  flowLine,
  githubRepo,
  isSopFileUrl,
  sopGroup,
  sopMatches,
  sopName,
  sopState,
  type SopGroup,
  type SopState,
} from './sop-model'
import { sopSubject } from './tile-art'
import { PlainTile } from './tiles'

/** Who an SOP comes from, after its name: Kettu, a repository's owner, a file, an agent or you. */
export function SopByline({ entry }: { entry: SopEntry }) {
  const { t } = useTranslation('marketplace')
  const origin = entry.origin
  const text =
    entry.source === 'official'
      ? t('sop.by.kettu')
      : origin?.kind === 'github'
        ? t('sop.by.github', { owner: githubRepo(origin.url)?.split('/')[0] ?? 'GitHub' })
        : entry.source === 'file'
          ? t('sop.by.file')
          : entry.source === 'agent'
            ? t('sop.by.agent')
            : t('sop.by.you')
  return <span className="k-sop-by">{text}</span>
}

/** What keeps an SOP from starting tasks, as a pill at its row's end or its page's top. */
export function SopStateBadge({ state }: { state: Exclude<SopState, 'ready'> }) {
  const { t } = useTranslation('marketplace')
  return (
    <span
      className="k-sop-state"
      data-tone={state === 'pending' || state === 'changed' ? 'wait' : 'bad'}
      title={t(`sop.stateTitle.${state}`)}
    >
      {t(`sop.state.${state}`)}
    </span>
  )
}

/** A row's line: the steps in order, or why the file does not read. */
function rowLine(entry: SopEntry, locale: string): string | null {
  if (entry.sop) return flowLine(entry.sop, locale)
  return entry.problems[0]?.message ?? null
}

export function SopRow({
  entry,
  tab,
  showKind = false,
  fresh,
}: {
  entry: SopEntry
  tab: MarketplaceTab
  showKind?: boolean
  fresh?: boolean
}) {
  const { i18n } = useTranslation('marketplace')
  const locale = i18n.language
  const name = sopName(entry, locale)
  const state = sopState(entry)
  const open = () => openMarketplace({ item: itemKey({ kind: 'sop', id: entry.id }), tab })
  return (
    <ItemRow
      title={name}
      subject={sopSubject(entry)}
      tag={
        <>
          {showKind && <KindTag kind="sop" />}
          <SopByline entry={entry} />
        </>
      }
      line={rowLine(entry, locale)}
      fresh={fresh}
      onOpen={open}
      end={
        state === 'ready' ? (
          <InstalledCheck name={name} onOpen={open} />
        ) : (
          <SopStateBadge state={state} />
        )
      }
    />
  )
}

const GROUPS: readonly SopGroup[] = ['official', 'added', 'yours']

/** The SOP tab: what an SOP is, then Official, Added from GitHub and Yours. */
export function SopSections({ query }: { query: string }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const { entries, loaded, error } = useSops()
  const locale = currentLocale()
  const searching = query.trim() !== ''
  const [adding, setAdding] = useState(false)

  if (!loaded) {
    return (
      <>
        <p className="k-sop-intro">{t('sop.intro')}</p>
        {GROUPS.map((group) => (
          <section key={group} className="ui-as-int-section" aria-busy>
            <h2 className="ui-as-int-section__title">{t(`sop.groups.${group}`)}</h2>
            <SkeletonRows rows={2} />
          </section>
        ))}
      </>
    )
  }
  const shown = entries.filter((entry) => sopMatches(entry, query, locale))
  const note = error && (
    <div className="k-mkt-notes">
      <QuietNote action={<RetryButton onRetry={() => retrySops(scope)} />}>
        {t('sop.readFailed', { error })}
      </QuietNote>
    </div>
  )
  if (searching && shown.length === 0) {
    return (
      <>
        {note}
        <div className="ui-as-rise ui-as-int-empty">
          <EmptyState title={t('search.noneTitle')} text={t('search.none', { query })} />
        </div>
      </>
    )
  }
  const added = shown.filter((entry) => sopGroup(entry) === 'added')
  const title = (group: SopGroup): string =>
    group === 'added' && added.some((entry) => entry.source === 'file')
      ? t('sop.groups.addedOrFile')
      : t(`sop.groups.${group}`)
  return (
    <>
      {!searching && <p className="k-sop-intro">{t('sop.intro')}</p>}
      {note}
      {GROUPS.map((group, index) => {
        const rows = shown.filter((entry) => sopGroup(entry) === group)
        if (searching && rows.length === 0) return null
        return (
          <section
            key={group}
            className="ui-as-int-section ui-as-rise"
            style={{ '--i': index } as CSSProperties}
          >
            <h2 className="ui-as-int-section__title">{title(group)}</h2>
            {rows.length === 0 && group === 'yours' && (
              <p className="k-mkt-section-note">{t('sop.yoursEmpty')}</p>
            )}
            {(rows.length > 0 || group === 'added') && (
              <div className="ui-as-int-grid">
                {rows.map((entry) => (
                  <SopRow key={entry.id} entry={entry} tab="sop" />
                ))}
                {group === 'added' && !searching && <AddSopRow onAdd={() => setAdding(true)} />}
              </div>
            )}
          </section>
        )
      })}
      <AddSopDialog open={adding} onOpenChange={setAdding} />
    </>
  )
}

/** The last row of Added from GitHub: where an SOP someone shared comes in. */
function AddSopRow({ onAdd }: { onAdd: () => void }) {
  const { t } = useTranslation('marketplace')
  return (
    <ItemRow
      title={t('sop.add.rowTitle')}
      icon={
        <PlainTile>
          <Icon icon={GithubIcon} />
        </PlainTile>
      }
      line={t('sop.add.rowLine')}
      end={
        <Button size="md" variant="secondary" onClick={onAdd}>
          {t('sop.add.rowButton')}
        </Button>
      }
    />
  )
}

/** Installed's SOP section: every SOP the host keeps, Kettu's own with them. */
export function InstalledSops({ query, index }: { query: string; index: number }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const { entries, loaded, error } = useSops()
  const locale = currentLocale()
  const shown = entries.filter((entry) => sopMatches(entry, query, locale))
  if (loaded && query.trim() && shown.length === 0) return null
  return (
    <section className="ui-as-int-section ui-as-rise" style={{ '--i': index } as CSSProperties}>
      <h2 className="ui-as-int-section__title">
        {t('installed.sops')}
        {shown.length > 0 && <span className="k-mkt-count">{shown.length}</span>}
      </h2>
      {!loaded ? (
        <SkeletonRows rows={2} />
      ) : error && entries.length === 0 ? (
        <QuietNote action={<RetryButton onRetry={() => retrySops(scope)} />}>
          {t('sop.readFailed', { error })}
        </QuietNote>
      ) : (
        <div className="ui-as-int-grid">
          {shown.map((entry) => (
            <SopRow key={entry.id} entry={entry} tab="installed" />
          ))}
        </div>
      )}
    </section>
  )
}

function RetryButton({ onRetry }: { onRetry: () => Promise<void> }) {
  const { t } = useTranslation('common')
  const [busy, setBusy] = useState(false)
  return (
    <Button
      size="md"
      variant="ghost"
      loading={busy}
      onClick={() => {
        setBusy(true)
        void onRetry().finally(() => setBusy(false))
      }}
    >
      {t('actions.retry')}
    </Button>
  )
}

export function AddSopDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SettingsDialogContent>
        {open && <AddSopForm onDone={() => onOpenChange(false)} />}
      </SettingsDialogContent>
    </Dialog>
  )
}

function AddSopForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation(['marketplace', 'common'])
  const scope = useHostScope()
  const id = useId()
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState<'url' | 'file' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const trimmed = url.trim()
  const ready = isSopFileUrl(trimmed)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!ready || busy) return
    setBusy('url')
    setError(null)
    try {
      const entry = await scope.request('sops.add', { kind: 'url', url: trimmed })
      await showAdded(scope, entry)
      onDone()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(null)
    }
  }
  const chooseFile = async () => {
    setBusy('file')
    setError(null)
    const result = await addSopFile(scope)
    setBusy(null)
    if (typeof result === 'object') setError(result.error)
    else if (result === 'added') onDone()
  }
  return (
    <form onSubmit={(event) => void submit(event)}>
      <SettingsDialogHeader title={t('sop.add.title')}>
        {t('sop.add.description')}
      </SettingsDialogHeader>
      <SettingsDialogBody>
        <SettingsField
          label={t('sop.add.url')}
          htmlFor={`${id}-url`}
          hint={trimmed && !ready ? t('sop.add.urlInvalid') : t('sop.add.urlHint')}
        >
          <input
            id={`${id}-url`}
            className={DIALOG_MONO_FIELD}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            inputMode="url"
            aria-invalid={trimmed && !ready ? true : undefined}
            placeholder={t('sop.add.urlPlaceholder')}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </SettingsField>
        {error && (
          <p role="alert" className="k-mkt-error" data-selectable="">
            {t('sop.add.failed', { error })}
          </p>
        )}
      </SettingsDialogBody>
      <SettingsDialogFooter
        start={
          <SetButton
            size="md"
            variant="ghost"
            icon={<Icon icon={File02Icon} size={14} />}
            loading={busy === 'file'}
            disabled={busy !== null}
            onClick={() => void chooseFile()}
          >
            {t('sop.add.chooseFile')}
          </SetButton>
        }
      >
        <DialogClose render={<SetButton size="md" variant="ghost" />}>
          {t('common:actions.cancel')}
        </DialogClose>
        <SetButton
          size="md"
          variant="primary"
          type="submit"
          loading={busy === 'url'}
          disabled={!ready || busy !== null}
        >
          {t('sop.add.submit')}
        </SetButton>
      </SettingsDialogFooter>
    </form>
  )
}
