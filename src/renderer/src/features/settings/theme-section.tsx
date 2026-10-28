import { useEffect, useMemo, useRef, useState } from 'react'
import { EllipsisIcon, FileDownIcon, FolderIcon, TrashIcon, TriangleAlertIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  BUILTIN_THEME_ID,
  THEME_MODES,
  type ContrastIssue,
  type InstalledTheme,
  type Theme,
  type ThemeFileError,
  type ThemeInstallResult,
  type ThemeLoadFailure,
} from '@shared/themes'
import { Alert, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { toast } from '@renderer/components/ui/toast'
import { ToggleGroup, ToggleGroupItem } from '@renderer/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { isCodeTheme } from '@renderer/features/session/markdown/code-themes'
import { basename, dirname } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { fileManagerName } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { receiveThemes, useThemesStore } from '@renderer/stores/themes'
import { CONFIRM, ControlError } from './controls'
import { RadioDot } from './sections'
import { BrowseThemes } from './theme-catalog'
import { themeContrast, themeFile } from './theme-colors'
import { ThemePreview } from './theme-preview'
import { useReason } from './theme-reason'
import { useApply } from './use-apply'

type InstallError = ThemeFileError | { code: 'unreadable' }
export type Conflict = Extract<ThemeInstallResult, { status: 'conflict' }>

type Notice =
  | { kind: 'installed'; id: string; ignored: string[] }
  | { kind: 'failed'; file: string; error: InstallError }
  | { kind: 'error'; message: string }

// The pairs a low-contrast tooltip lists, the lowest first; the rest are counted.
const CONTRAST_SHOWN = 10

/** Truncates, never rounds up, as the contrast check does, so 4.49 never shows as 4.50. */
const formatRatio = (ratio: number) => (Math.floor(ratio * 100) / 100).toFixed(2)

/** The Theme group: OverBench, the installed themes by name, and the ways to add one. */
export function ThemeTiles() {
  const { t } = useTranslation(['settings', 'common'])
  const { installed, chosen, failed } = useThemesStore((s) => s.state)
  const [apply, applyError] = useApply()
  const [notice, setNotice] = useState<Notice | null>(null)
  // Kept while a dialog closes, so its text stays through the animation.
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [removing, setRemoving] = useState<InstalledTheme | null>(null)
  const [removeOpen, setRemoveOpen] = useState(false)
  // The menu button that asked, which takes focus back when the dialog closes.
  const asker = useRef<HTMLElement | null>(null)

  // The folder is read again each time the page shows, so a file changed by hand shows here.
  useEffect(() => {
    window.overbench.themes
      .get()
      .then(receiveThemes, (e: unknown) => setNotice({ kind: 'error', message: errorMessage(e) }))
  }, [])

  const run = (action: () => Promise<void>) => {
    setNotice(null)
    action().catch((e: unknown) => setNotice({ kind: 'error', message: errorMessage(e) }))
  }
  const answered = (result: ThemeInstallResult) => {
    if (result.status === 'conflict') {
      setConflict(result)
      setReplaceOpen(true)
    } else if (result.status === 'failed') {
      setNotice({ kind: 'failed', file: result.file, error: result.error })
    } else if (result.status === 'installed') {
      setNotice({ kind: 'installed', id: result.id, ignored: result.ignored })
    }
  }
  const install = () => run(async () => answered(await window.overbench.themes.install()))
  const tile = (id: string, theme: Theme | null, item?: InstalledTheme) => (
    <ThemeTile
      key={id}
      id={id}
      theme={theme}
      source={item?.catalog ? 'catalog' : item ? 'file' : 'builtIn'}
      onExport={() =>
        run(async () => {
          const saved = await window.overbench.themes.export(themeFile(theme))
          if (saved) {
            toast(
              t('appearance.theme.exported', {
                file: basename(saved),
                folder: basename(dirname(saved)),
              }),
            )
          }
        })
      }
      {...(item && {
        onReveal: () => run(() => window.overbench.themes.reveal(item.id)),
        onRemove: (from: HTMLElement | null) => {
          asker.current = from
          setRemoving(item)
          setRemoveOpen(true)
        },
      })}
    />
  )

  return (
    <div className="@container flex flex-col gap-3.5 pt-1">
      {failed && (
        <LoadFailure
          id={failed.id}
          failure={failed.failure}
          onUseBuiltIn={() => apply({ appearance: { colorTheme: BUILTIN_THEME_ID } })}
          onInstall={install}
        />
      )}
      <ToggleGroup
        aria-label={t('appearance.theme.name')}
        variant="tile"
        size="tile"
        spacing={3}
        value={[chosen]}
        onValueChange={(next) => {
          const picked = next[0] as string | undefined
          if (picked && picked !== chosen) apply({ appearance: { colorTheme: picked } })
        }}
        className="grid w-full grid-cols-1 items-stretch @min-[440px]:grid-cols-2"
      >
        {tile(BUILTIN_THEME_ID, null)}
        {installed.map((item) => tile(item.id, item.theme, item))}
        <MoreThemes bar={installed.length % 2 === 1} onInstall={install} />
      </ToggleGroup>
      <ControlError error={applyError} />
      {notice && (
        <ThemeNotice notice={notice} installed={installed} onDismiss={() => setNotice(null)} />
      )}

      <ReplaceDialog
        conflict={conflict}
        open={replaceOpen}
        onOpenChange={setReplaceOpen}
        onReplace={(token) =>
          run(async () => answered(await window.overbench.themes.replace(token)))
        }
      />

      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent finalFocus={asker} className={CONFIRM}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('appearance.theme.removeTitle', { name: removing?.theme.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('appearance.theme.removeDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setRemoveOpen(false)
                if (!removing) return
                const { id, theme } = removing
                run(async () => {
                  await window.overbench.themes.remove(id)
                  toast(t('appearance.theme.removed', { name: theme.name }))
                })
              }}
            >
              {t('appearance.theme.removeConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** A theme's card: its picture in the chosen color mode, its name, and its menu at the end. */
function ThemeTile({
  id,
  theme,
  source,
  onExport,
  onReveal,
  onRemove,
}: {
  id: string
  theme: Theme | null
  /** Where it came from, which the tile names. */
  source: 'builtIn' | 'file' | 'catalog'
  onExport: () => void
  onReveal?: () => void
  /** Gets the menu's button, which focus returns to once the question is answered. */
  onRemove?: (from: HTMLElement | null) => void
}) {
  const { t } = useTranslation('settings')
  const name = theme?.name ?? 'OverBench'
  const issues = useMemo(() => themeContrast(theme), [theme])
  const more = useRef<HTMLButtonElement>(null)
  return (
    <div className="group/tile relative min-w-0">
      <ToggleGroupItem
        value={id}
        className="w-full group-hover/tile:not-aria-pressed:shadow-outline-hover"
      >
        <ThemePreview light={theme?.light.colors} dark={theme?.dark.colors} />
        {/* The end keeps the More button's slot, so nothing moves when it shows. */}
        <span className="flex h-10 min-w-0 items-center gap-1.75 pr-8.5 pl-1.5">
          <RadioDot />
          <span className="truncate font-medium text-primary">{name}</span>
          {issues.length > 0 && <ContrastWarning issues={issues} />}
          <span className="ml-auto shrink-0 pl-2 text-xs text-tertiary">
            {t(`appearance.theme.${source}`)}
          </span>
        </span>
      </ToggleGroupItem>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              ref={more}
              variant="quiet"
              size="icon-xs"
              aria-label={t('appearance.theme.more', { name })}
              className="absolute right-2 bottom-2 opacity-0 transition-opacity duration-(--duration-fast) group-hover/tile:opacity-100 group-has-focus-visible/tile:opacity-100 data-popup-open:opacity-100"
            />
          }
        >
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-47.5">
          <DropdownMenuItem onClick={onExport}>
            <FileDownIcon />
            {t('appearance.theme.export')}
          </DropdownMenuItem>
          {onReveal && (
            <DropdownMenuItem onClick={onReveal}>
              <FolderIcon />
              {t('agents.showIn', { name: fileManagerName() })}
            </DropdownMenuItem>
          )}
          {onRemove && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => onRemove(more.current)}>
                <TrashIcon />
                {t('appearance.theme.remove')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** Asks before a theme takes the place of the installed one with its id. */
export function ReplaceDialog({
  conflict,
  open,
  onOpenChange,
  onReplace,
}: {
  conflict: Conflict | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onReplace: (token: string) => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className={CONFIRM}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('appearance.theme.replaceTitle', { name: conflict?.installedName })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('appearance.theme.replaceDescription', { name: conflict?.name })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              onOpenChange(false)
              if (conflict) onReplace(conflict.token)
            }}
          >
            {t('appearance.theme.replace')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function ContrastWarning({ issues }: { issues: ContrastIssue[] }) {
  const { t } = useTranslation('settings')
  const lowest = [...issues].sort((a, b) => a.ratio - b.ratio)
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0 text-warning" />}>
        <TriangleAlertIcon
          role="img"
          aria-label={t('appearance.theme.lowContrast')}
          className="size-3.5"
        />
      </TooltipTrigger>
      <TooltipContent className="flex-col items-start gap-0.5">
        <span className="font-medium">{t('appearance.theme.lowContrast')}</span>
        {lowest.slice(0, CONTRAST_SHOWN).map((issue) => (
          <span key={`${issue.mode} ${issue.fg} ${issue.bg}`}>
            {t('appearance.theme.contrastPair', {
              mode: t(`appearance.colorMode.${issue.mode}`),
              fg: issue.fg,
              bg: issue.bg,
              ratio: formatRatio(issue.ratio),
            })}
          </span>
        ))}
        {lowest.length > CONTRAST_SHOWN && (
          <span>
            {t('appearance.theme.contrastMore', { count: lowest.length - CONTRAST_SHOWN })}
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * After the themes, the ways to add one: in the cell beside the last theme, or across the row as a
 * bar when the themes fill theirs, so a lone theme never leaves half a row empty.
 */
function MoreThemes({ bar, onInstall }: { bar: boolean; onInstall: () => void }) {
  const { t } = useTranslation('settings')
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col justify-center gap-3 rounded-xl bg-subtle p-3.5 shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)]',
        bar &&
          'col-span-full flex-row flex-wrap items-center justify-between gap-x-4 py-3 pr-3 pl-4',
      )}
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-ui font-medium text-primary">{t('appearance.theme.moreThemes')}</span>
        <span className="text-small text-secondary">{t('appearance.theme.moreDescription')}</span>
      </span>
      <span className="flex flex-wrap gap-1.5">
        <BrowseThemes />
        <Button variant="outline" size="sm" onClick={onInstall}>
          {t('appearance.theme.install')}
        </Button>
      </span>
    </div>
  )
}

/** Under the grid: what an install left unused or a warning on its contrast, or why it failed. */
function ThemeNotice({
  notice,
  installed,
  onDismiss,
}: {
  notice: Notice
  installed: InstalledTheme[]
  onDismiss: () => void
}) {
  const { t } = useTranslation('settings')
  const reason = useReason()
  if (notice.kind === 'error') {
    return (
      <p role="alert" className="text-small text-danger" data-selectable="">
        {notice.message}
      </p>
    )
  }
  if (notice.kind === 'failed') {
    return (
      <p role="alert" className="text-small text-danger" data-selectable="">
        {t('appearance.theme.installFailed', { file: notice.file, reason: reason(notice.error) })}
      </p>
    )
  }
  const item = installed.find(({ id }) => id === notice.id)
  if (!item) return null
  // A Shiki theme this build does not bundle is ignored too; main cannot tell which those are.
  const unused = [
    ...notice.ignored,
    ...THEME_MODES.flatMap((mode) => {
      const code = item.theme[mode].code
      return code !== undefined && !isCodeTheme(code) ? [`${mode}.code`] : []
    }),
  ]
  const low = themeContrast(item.theme).length > 0
  if (unused.length === 0 && !low) return null
  return (
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertTitle>{t('appearance.theme.installed', { name: item.theme.name })}</AlertTitle>
      <AlertDescription className="flex flex-col gap-2.5">
        {unused.length > 0 && (
          <span className="break-words" data-selectable="">
            {t('appearance.theme.unused', { list: unused.join(', ') })}
          </span>
        )}
        {low && <span>{t('appearance.theme.lowContrastNotice')}</span>}
        <span>
          <Button variant="outline" size="compact" onClick={onDismiss}>
            {t('appearance.theme.gotIt')}
          </Button>
        </span>
      </AlertDescription>
    </Alert>
  )
}

/** Above the grid while the chosen theme cannot load, so the built-in one shows. */
function LoadFailure({
  id,
  failure,
  onUseBuiltIn,
  onInstall,
}: {
  id: string
  failure: ThemeLoadFailure
  onUseBuiltIn: () => void
  onInstall: () => void
}) {
  const { t } = useTranslation('settings')
  const reason = useReason()
  return (
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertTitle>{t('appearance.theme.loadFailed', { id })}</AlertTitle>
      <AlertDescription className="flex flex-col gap-2.5">
        <span>
          {t('appearance.theme.loadFailedDescription', {
            reason: reason(failure.code === 'invalid' ? failure.error : failure),
          })}
        </span>
        <span className="flex flex-wrap gap-1.5">
          <Button variant="outline" size="compact" onClick={onUseBuiltIn}>
            {t('appearance.theme.useBuiltIn')}
          </Button>
          <Button variant="outline" size="compact" onClick={onInstall}>
            {t('appearance.theme.install')}
          </Button>
        </span>
      </AlertDescription>
    </Alert>
  )
}
