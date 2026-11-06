import { useEffect, useRef, useState } from 'react'
import { AlertCircleIcon, Search01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type {
  CatalogInstallError,
  CatalogInstallResult,
  CatalogTheme,
  ThemeColors,
} from '@shared/themes'
import { Icon } from '@renderer/components/affect/app-shell'
import { Dialog, DialogClose } from '@renderer/components/ui/dialog'
import { errorMessage } from '@renderer/lib/host'
import { isMod } from '@renderer/lib/platform'
import { useThemesStore } from '@renderer/stores/themes'
import { catalogView, type CatalogAnswer } from './catalog-view'
import { FindField, SetButton, Spin } from './controls'
import {
  SettingsDialogContent,
  SettingsDialogFooter,
  SettingsDialogHeader,
} from './settings-dialog'
import { previewColors, type PreviewToken } from './theme-colors'
import { useReason } from './theme-reason'
import { ReplaceDialog, type Conflict } from './theme-section'

type Failure = { name: string; error: CatalogInstallError } | { message: string }

/** Browse themes, in the More themes card: the online catalog in a dialog. */
export function BrowseThemes() {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)
  // Each opening starts afresh and reads the index; nothing reads it before the first.
  const [opened, setOpened] = useState(0)
  return (
    <>
      <SetButton
        onClick={() => {
          setOpened((count) => count + 1)
          setOpen(true)
        }}
      >
        {t('appearance.catalog.browse')}
      </SetButton>
      {opened > 0 && <CatalogDialog key={opened} open={open} onOpenChange={setOpen} />}
    </>
  )
}

function CatalogDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation('settings')
  const reason = useReason()
  const [answer, setAnswer] = useState<CatalogAnswer>(null)
  const [attempt, setAttempt] = useState(0)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  // Kept while the question closes, so its text stays through the animation.
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [replaceOpen, setReplaceOpen] = useState(false)
  const search = useRef<HTMLInputElement>(null)
  const installed = useThemesStore((s) => s.state.installed)
  const listed = answer?.status === 'ok'

  // Opening reads the index from GitHub, and so does Try again.
  useEffect(() => {
    let live = true
    window.kettu.themes.catalog(true).then(
      (next) => live && setAnswer(next),
      (e: unknown) => live && setAnswer({ status: 'error', message: errorMessage(e) }),
    )
    return () => {
      live = false
    }
  }, [attempt])

  // An install or a removal anywhere changes what the buttons do; main answers from its last index.
  useEffect(() => {
    if (!listed) return
    let live = true
    window.kettu.themes.catalog(false).then(
      (next) => live && setAnswer(next),
      (e: unknown) => live && setAnswer({ status: 'error', message: errorMessage(e) }),
    )
    return () => {
      live = false
    }
  }, [installed, listed])

  const retry = () => {
    setAnswer(null)
    setAttempt((count) => count + 1)
  }
  const answered = (name: string, result: CatalogInstallResult) => {
    if (result.status === 'conflict') {
      setConflict(result)
      setReplaceOpen(true)
    } else if (result.status === 'failed') {
      setFailure({ name, error: result.error })
    }
  }
  const install = (theme: CatalogTheme) => {
    setBusy(theme.id)
    setFailure(null)
    window.kettu.themes
      .installCatalog(theme.id)
      .then(
        (result) => answered(theme.name, result),
        (e: unknown) => setFailure({ message: errorMessage(e) }),
      )
      .finally(() => setBusy(null))
  }

  const view = catalogView(answer, query)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SettingsDialogContent
        className="flex flex-col overflow-y-hidden"
        onKeyDown={(event) => {
          // The search field's Mod+F, before the Settings page behind takes it for its own.
          if (!isMod(event) || event.shiftKey || event.key.toLowerCase() !== 'f') return
          event.preventDefault()
          event.stopPropagation()
          search.current?.focus()
          search.current?.select()
        }}
      >
        <SettingsDialogHeader title={t('appearance.catalog.title')}>
          {t('appearance.catalog.description')}
        </SettingsDialogHeader>
        {listed && (
          <div className="kettu-sd__pad">
            <FindField
              value={query}
              onChange={setQuery}
              label={t('appearance.catalog.search')}
              clearLabel={t('page.clearSearch')}
              inputRef={search}
            />
          </div>
        )}
        <div className="kettu-sd__scroll">
          {view.kind === 'loading' && (
            <p className="kettu-sd__loading">
              <Spin />
              {t('appearance.catalog.loading')}
            </p>
          )}
          {(view.kind === 'failed' || view.kind === 'error') && (
            <div className="ui-as-empty" data-bare="">
              <span className="ui-as-empty__icon">
                <Icon icon={AlertCircleIcon} size={18} />
              </span>
              <b className="ui-as-empty__title" data-selectable="">
                {view.kind === 'failed'
                  ? t(`appearance.catalog.errors.${view.error}`)
                  : view.message}
              </b>
              <SetButton onClick={retry}>{t('appearance.catalog.tryAgain')}</SetButton>
            </div>
          )}
          {(view.kind === 'none' || view.kind === 'no-match') && (
            <div className="ui-as-empty" data-bare="">
              <span className="ui-as-empty__icon">
                <Icon icon={Search01Icon} size={18} />
              </span>
              <b className="ui-as-empty__title">
                {view.kind === 'none'
                  ? t('appearance.catalog.none')
                  : t('appearance.catalog.noMatch', { query: view.query })}
              </b>
            </div>
          )}
          {view.kind === 'themes' && (
            <ul className="kettu-sd__list">
              {view.themes.map((theme) => (
                <CatalogRow
                  key={theme.id}
                  theme={theme}
                  busy={busy === theme.id}
                  disabled={busy !== null}
                  onInstall={() => install(theme)}
                />
              ))}
            </ul>
          )}
          {failure && (
            <p role="alert" className="kettu-sd__error" data-selectable="">
              {'message' in failure
                ? failure.message
                : t('appearance.catalog.installFailed', {
                    name: failure.name,
                    reason: reason(failure.error),
                  })}
            </p>
          )}
        </div>
        <SettingsDialogFooter>
          <DialogClose render={<SetButton size="md" />}>{t('appearance.catalog.done')}</DialogClose>
        </SettingsDialogFooter>
      </SettingsDialogContent>
      <ReplaceDialog
        conflict={conflict}
        open={replaceOpen}
        onOpenChange={setReplaceOpen}
        onReplace={(token) => {
          setFailure(null)
          window.kettu.themes
            .replace(token)
            .catch((e: unknown) => setFailure({ message: errorMessage(e) }))
        }}
      />
    </Dialog>
  )
}

// What the strip shows of a theme, in either mode: its light window, sidebar and text.
const SWATCHES: PreviewToken[] = ['bg-app', 'bg-sidebar', 'primary-to']

function Swatches({ light }: { light?: ThemeColors }) {
  const colors = previewColors(light, 'light')
  return (
    <span aria-hidden className="kettu-sd__swatches">
      {SWATCHES.map((token) => (
        <span key={token} style={{ backgroundColor: colors[token] }} />
      ))}
    </span>
  )
}

/** A catalog theme: its colors, name, author and license, and what installing it does. */
function CatalogRow({
  theme,
  busy,
  disabled,
  onInstall,
}: {
  theme: CatalogTheme
  busy: boolean
  disabled: boolean
  onInstall: () => void
}) {
  const { t } = useTranslation('settings')
  return (
    <li className="kettu-sd__row">
      <Swatches light={theme.preview.light} />
      <span className="ui-sg-label k-lines">
        <b>{theme.name}</b>
        <small>
          {t('appearance.catalog.byline', { author: theme.author, license: theme.license })}
        </small>
      </span>
      {theme.action === 'installed' ? (
        <span className="ui-ss-badge">{t('appearance.catalog.installed')}</span>
      ) : (
        <SetButton
          loading={busy}
          disabled={disabled && !busy}
          onClick={onInstall}
          aria-label={
            theme.action === 'update'
              ? t('appearance.catalog.updateLabel', { name: theme.name, version: theme.version })
              : t('appearance.catalog.installLabel', { name: theme.name })
          }
        >
          {theme.action === 'update'
            ? t('appearance.catalog.update', { version: theme.version })
            : t('appearance.catalog.install')}
        </SetButton>
      )}
    </li>
  )
}
