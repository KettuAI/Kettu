import { useEffect, useRef, useState } from 'react'
import { CircleAlertIcon, SearchIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  CatalogInstallError,
  CatalogInstallResult,
  CatalogTheme,
  ThemeColors,
} from '@shared/themes'
import { SearchField } from '@renderer/components/search-field'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogClose } from '@renderer/components/ui/dialog'
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from '@renderer/components/ui/empty'
import { Spinner } from '@renderer/components/ui/spinner'
import { errorMessage } from '@renderer/lib/host'
import { isMod } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { useThemesStore } from '@renderer/stores/themes'
import { catalogView, type CatalogAnswer } from './catalog-view'
import { ROW_BUTTON } from './controls'
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
      <Button
        className={ROW_BUTTON}
        variant="outline"

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
          <div className="px-6 pt-3 [--control-height:--spacing(8.5)]">
            <SearchField
              value={query}
              onChange={setQuery}
              label={t('appearance.catalog.search')}
              clearLabel={t('page.clearSearch')}
              inputRef={search}
              className="rounded-segments border-0 bg-subtle text-tertiary shadow-none [&_[data-slot=input-group-addon]]:pl-2.5 [&_[data-slot=input-group-addon]_svg]:size-3.75 [&_input]:pl-2 [&_input]:text-lede [&_[data-slot=kbd]]:hidden"
            />
          </div>
        )}
        <div className="flex min-h-0 flex-col overflow-y-auto px-6 pt-2 pb-2">
          {view.kind === 'loading' && (
            <p className="flex items-center justify-center gap-2 py-16 text-control text-secondary">
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
                <Button className={ROW_BUTTON} variant="outline" onClick={retry}>
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
            <ul className="flex flex-col">
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
            <p role="alert" className="pt-3 text-hint text-danger" data-selectable="">
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
          <DialogClose
            render={<Button variant="ghost" className={cn(ROW_BUTTON, 'text-secondary')} />}
          >
            {t('appearance.catalog.done')}
          </DialogClose>
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
    <span
      aria-hidden
      className="flex shrink-0 overflow-hidden rounded-segment shadow-[0_0_0_var(--hairline)_var(--border-default)]"
    >
      {SWATCHES.map((token) => (
        <span key={token} className="h-7 w-3.5" style={{ backgroundColor: colors[token] }} />
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
    <li className="flex items-center gap-3.5 py-3 shadow-[inset_0_calc(-1*var(--hairline))_0_var(--border-subtle)]">
      <Swatches light={theme.preview.light} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-row leading-tight text-primary">{theme.name}</span>
        <span className="truncate text-hint leading-tight text-tertiary">
          {t('appearance.catalog.byline', { author: theme.author, license: theme.license })}
        </span>
      </span>
      {theme.action === 'installed' ? (
        <span className="shrink-0 text-control text-tertiary">
          {t('appearance.catalog.installed')}
        </span>
      ) : (
        <Button
          variant="outline"
          disabled={disabled}
          onClick={onInstall}
          aria-label={
            theme.action === 'update'
              ? t('appearance.catalog.updateLabel', { name: theme.name, version: theme.version })
              : t('appearance.catalog.installLabel', { name: theme.name })
          }
          className={cn(ROW_BUTTON, 'shrink-0')}
        >
          {busy && <Spinner aria-hidden data-icon="inline-start" className="size-3" />}
          {theme.action === 'update'
            ? t('appearance.catalog.update', { version: theme.version })
            : t('appearance.catalog.install')}
        </Button>
      )}
    </li>
  )
}
