import { useEffect, useRef, useState } from 'react'
import { CheckIcon, CircleAlertIcon, SearchIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { CatalogInstallError, CatalogInstallResult, CatalogTheme } from '@shared/themes'
import { SearchField } from '@renderer/components/search-field'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from '@renderer/components/ui/empty'
import { Spinner } from '@renderer/components/ui/spinner'
import { errorMessage } from '@renderer/lib/host'
import { isMod } from '@renderer/lib/platform'
import { useThemesStore } from '@renderer/stores/themes'
import { catalogView, type CatalogAnswer } from './catalog-view'
import { useReason } from './theme-reason'
import { ThemePreview } from './theme-preview'
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
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setOpened((count) => count + 1)
          setOpen(true)
        }}
      >
        {t('appearance.catalog.browse')}
      </Button>
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
    window.overbench.themes.catalog(true).then(
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
    window.overbench.themes.catalog(false).then(
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
    window.overbench.themes
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
      <DialogContent
        className="flex max-h-[min(640px,85svh)] flex-col gap-4 sm:max-w-[640px]"
        onKeyDown={(event) => {
          // The search field's Mod+F, before the Settings page behind takes it for its own.
          if (!isMod(event) || event.shiftKey || event.key.toLowerCase() !== 'f') return
          event.preventDefault()
          event.stopPropagation()
          search.current?.focus()
          search.current?.select()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('appearance.catalog.title')}</DialogTitle>
          <DialogDescription>{t('appearance.catalog.description')}</DialogDescription>
        </DialogHeader>
        {listed && (
          <SearchField
            value={query}
            onChange={setQuery}
            label={t('appearance.catalog.search')}
            clearLabel={t('page.clearSearch')}
            inputRef={search}
          />
        )}
        <div className="-mx-1 flex min-h-0 flex-col overflow-y-auto px-1 pb-1">
          {view.kind === 'loading' && (
            <p className="flex items-center justify-center gap-2 py-16 text-small text-secondary">
              <Spinner aria-hidden className="size-3.5" />
              {t('appearance.catalog.loading')}
            </p>
          )}
          {(view.kind === 'failed' || view.kind === 'error') && (
            <Empty className="py-12">
              <EmptyHeader>
                <CircleAlertIcon className="size-4 text-danger" />
                <EmptyTitle data-selectable="">
                  {view.kind === 'failed'
                    ? t(`appearance.catalog.errors.${view.error}`)
                    : view.message}
                </EmptyTitle>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="outline" size="compact" onClick={retry}>
                  {t('appearance.catalog.tryAgain')}
                </Button>
              </EmptyContent>
            </Empty>
          )}
          {(view.kind === 'none' || view.kind === 'no-match') && (
            <Empty className="py-12">
              <EmptyHeader>
                <SearchIcon className="size-4 text-icon" />
                <EmptyTitle>
                  {view.kind === 'none'
                    ? t('appearance.catalog.none')
                    : t('appearance.catalog.noMatch', { query: view.query })}
                </EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}
          {view.kind === 'themes' && (
            <div className="grid grid-cols-3 gap-3.5">
              {view.themes.map((theme) => (
                <CatalogTile
                  key={theme.id}
                  theme={theme}
                  busy={busy === theme.id}
                  disabled={busy !== null}
                  onInstall={() => install(theme)}
                />
              ))}
            </div>
          )}
        </div>
        {failure && (
          <p role="alert" className="text-small text-danger" data-selectable="">
            {'message' in failure
              ? failure.message
              : t('appearance.catalog.installFailed', {
                  name: failure.name,
                  reason: reason(failure.error),
                })}
          </p>
        )}
      </DialogContent>
      <ReplaceDialog
        conflict={conflict}
        open={replaceOpen}
        onOpenChange={setReplaceOpen}
        onReplace={(token) => {
          setFailure(null)
          window.overbench.themes
            .replace(token)
            .catch((e: unknown) => setFailure({ message: errorMessage(e) }))
        }}
      />
    </Dialog>
  )
}

/** A catalog theme: its picture from the index's colors, its name, author and license, and its button. */
function CatalogTile({
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
    <div className="flex min-w-0 flex-col gap-2">
      <ThemePreview light={theme.preview.light} dark={theme.preview.dark} />
      <div className="flex min-w-0 items-center gap-2 pl-0.5">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-small text-primary">{theme.name}</span>
          <span className="truncate text-xs text-tertiary">
            {t('appearance.catalog.byline', { author: theme.author, license: theme.license })}
          </span>
        </div>
        {theme.action === 'installed' ? (
          <Button variant="ghost" size="xs" disabled className="shrink-0">
            <CheckIcon data-icon="inline-start" />
            {t('appearance.catalog.installed')}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="xs"
            disabled={disabled}
            onClick={onInstall}
            aria-label={
              theme.action === 'update'
                ? t('appearance.catalog.updateLabel', { name: theme.name, version: theme.version })
                : t('appearance.catalog.installLabel', { name: theme.name })
            }
            className="shrink-0"
          >
            {busy && <Spinner aria-hidden data-icon="inline-start" className="size-3" />}
            {theme.action === 'update'
              ? t('appearance.catalog.update', { version: theme.version })
              : t('appearance.catalog.install')}
          </Button>
        )}
      </div>
    </div>
  )
}
