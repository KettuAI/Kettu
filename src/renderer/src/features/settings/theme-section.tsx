import { useEffect, useMemo, useRef, useState } from 'react'
import { Toggle } from '@base-ui/react/toggle'
import { ToggleGroup } from '@base-ui/react/toggle-group'
import {
  Alert02Icon,
  Copy01Icon,
  Delete02Icon,
  FileExportIcon,
  FolderOpenIcon,
  MoreHorizontalIcon,
} from '@hugeicons/core-free-icons'
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
import { Dropdown, Icon, type MenuItem } from '@renderer/components/affect/app-shell'
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
import { toast } from '@renderer/components/ui/toast'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { isCodeTheme } from '@renderer/features/session/markdown/code-themes'
import { basename, dirname } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { fileManagerName, isWeb } from '@renderer/lib/platform'
import { receiveThemes, useThemesStore } from '@renderer/stores/themes'
import { CONFIRM, ControlError, SetButton } from './controls'
import { Notice } from './rows'
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

/** The Theme group: Kettu, the installed themes by name, and the ways to add one. */
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
    window.kettu.themes
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
  const install = () => run(async () => answered(await window.kettu.themes.install()))
  const exportTheme = (theme: Theme | null) =>
    run(async () => {
      const saved = await window.kettu.themes.export(themeFile(theme))
      if (saved) {
        toast(
          t('appearance.theme.exported', {
            file: basename(saved),
            folder: basename(dirname(saved)),
          }),
        )
      }
    })
  const tile = (id: string, theme: Theme | null, item?: InstalledTheme) => (
    <ThemeTile
      key={id}
      id={id}
      theme={theme}
      source={item?.catalog ? 'catalog' : item ? 'file' : 'builtIn'}
      onExport={() => exportTheme(theme)}
      {...(item && {
        onReveal: () => run(() => window.kettu.themes.reveal(item.id)),
        onRemove: (from: HTMLElement | null) => {
          asker.current = from
          setRemoving(item)
          setRemoveOpen(true)
        },
      })}
    />
  )

  return (
    <div className="k-themes-wrap">
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
        value={[chosen]}
        onValueChange={(next) => {
          const picked = next[0] as string | undefined
          if (picked && picked !== chosen) apply({ appearance: { colorTheme: picked } })
        }}
        className="k-themes"
      >
        {tile(BUILTIN_THEME_ID, null)}
        {installed.map((item) => tile(item.id, item.theme, item))}
        <MoreThemes onInstall={install} />
      </ToggleGroup>
      <ControlError error={applyError} />
      {notice && (
        <ThemeNotice notice={notice} installed={installed} onDismiss={() => setNotice(null)} />
      )}

      <ReplaceDialog
        conflict={conflict}
        open={replaceOpen}
        onOpenChange={setReplaceOpen}
        onReplace={(token) => run(async () => answered(await window.kettu.themes.replace(token)))}
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
                  await window.kettu.themes.remove(id)
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
  /** Without it, and without the others, the tile has no menu. */
  onExport?: () => void
  onReveal?: () => void
  /** Gets the menu's button, which focus returns to once the question is answered. */
  onRemove?: (from: HTMLElement | null) => void
}) {
  const { t } = useTranslation(['settings', 'files'])
  const name = theme?.name ?? 'Kettu'
  const issues = useMemo(() => themeContrast(theme), [theme])
  // State rather than a ref, since the menu's items are built during render.
  const [more, setMore] = useState<HTMLButtonElement | null>(null)
  const items: MenuItem[] = []
  if (onExport)
    items.push({ label: t('appearance.theme.export'), icon: FileExportIcon, onSelect: onExport })
  // A browser cannot show the host's files, so it copies the file's path there.
  if (onReveal)
    items.push({
      label: isWeb ? t('files:preview.copyPath') : t('agents.showIn', { name: fileManagerName() }),
      icon: isWeb ? Copy01Icon : FolderOpenIcon,
      onSelect: onReveal,
    })
  if (onRemove)
    items.push({
      label: t('appearance.theme.remove'),
      icon: Delete02Icon,
      danger: true,
      divider: items.length > 0,
      onSelect: () => onRemove(more),
    })
  return (
    <div className="k-theme-cell">
      <Toggle value={id} className="k-theme">
        <ThemePreview light={theme?.light.colors} dark={theme?.dark.colors} />
        <span className="k-theme__name">
          <b>{name}</b>
          {issues.length > 0 && <ContrastWarning issues={issues} />}
        </span>
        <small>{t(`appearance.theme.${source}`)}</small>
      </Toggle>
      {items.length > 0 && (
        <Dropdown
          align="end"
          className="k-theme__more"
          items={items}
          trigger={({ open, toggle }) => (
            <button
              ref={setMore}
              type="button"
              className="ui-as-icon-btn"
              aria-label={t('appearance.theme.more', { name })}
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={toggle}
            >
              <Icon icon={MoreHorizontalIcon} size={16} />
            </button>
          )}
        />
      )}
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
      <TooltipTrigger
        render={
          <span role="img" aria-label={t('appearance.theme.lowContrast')} className="k-warn" />
        }
      >
        <Icon icon={Alert02Icon} size={14} />
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

/** After the themes, the ways to add one, on a hatched tile the size of a theme's picture. */
function MoreThemes({ onInstall }: { onInstall: () => void }) {
  const { t } = useTranslation('settings')
  return (
    <div className="k-theme k-theme--more">
      <b>{t('appearance.theme.moreThemes')}</b>
      <small>{t('appearance.theme.moreDescription')}</small>
      <span className="k-theme__actions">
        <BrowseThemes />
        <SetButton onClick={onInstall}>{t('appearance.theme.install')}</SetButton>
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
      <p role="alert" className="k-error" data-wrap="" data-selectable="">
        {notice.message}
      </p>
    )
  }
  if (notice.kind === 'failed') {
    return (
      <p role="alert" className="k-error" data-wrap="" data-selectable="">
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
    <Notice
      variant="warning"
      title={t('appearance.theme.installed', { name: item.theme.name })}
      action={<SetButton onClick={onDismiss}>{t('appearance.theme.gotIt')}</SetButton>}
    >
      {unused.length > 0 && (
        <p data-selectable="">{t('appearance.theme.unused', { list: unused.join(', ') })}</p>
      )}
      {low && <p>{t('appearance.theme.lowContrastNotice')}</p>}
    </Notice>
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
    <Notice
      variant="warning"
      title={t('appearance.theme.loadFailed', { id })}
      more={
        <span className="k-end">
          <SetButton onClick={onUseBuiltIn}>{t('appearance.theme.useBuiltIn')}</SetButton>
          <SetButton onClick={onInstall}>{t('appearance.theme.install')}</SetButton>
        </span>
      }
    >
      {t('appearance.theme.loadFailedDescription', {
        reason: reason(failure.code === 'invalid' ? failure.error : failure),
      })}
    </Notice>
  )
}
