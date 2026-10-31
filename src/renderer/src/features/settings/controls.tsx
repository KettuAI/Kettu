import { useState, type ReactNode } from 'react'
import { FolderIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { IconAction } from '@renderer/components/copy-action'
import { SegmentedControl } from '@renderer/components/segmented-control'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { Switch } from '@renderer/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { errorMessage } from '@renderer/lib/host'
import { fileManagerName } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { useSettingsStore } from '@renderer/stores/settings'

export { CopyAction, IconAction } from '@renderer/components/copy-action'

/** The width of Settings' confirmations, whose sentences run longer than most. */
export const CONFIRM = 'data-[size=default]:sm:max-w-105'

/** A quiet button at a group label's end, such as Send a test notification. */
export const GROUP_ACTION = 'px-2.25 text-xs text-secondary'

/** A field's label above it, as the Cloudflare account and a custom proxy take them. */
export const FIELD_LABEL = 'flex min-w-0 flex-col gap-1.5 text-xs font-medium text-secondary'

export function ControlError({ error }: { error: string | null }) {
  if (!error) return null
  return (
    <span className="max-w-48 truncate text-xs text-danger" title={error}>
      {error}
    </span>
  )
}

export function SettingSwitch({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}) {
  return (
    <Switch
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onCheckedChange={(value) => onChange(value)}
    />
  )
}

export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  return (
    <SegmentedControl
      aria-label={label}
      value={String(value)}
      segments={options.map((o) => ({ value: String(o.value), label: o.label }))}
      onChange={(next) => {
        const picked = options.find((o) => String(o.value) === next)
        if (picked) onChange(picked.value)
      }}
    />
  )
}

/** A choice from a list: quiet at rest, so a page of rows does not read as a form. */
export function SettingSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string; icon?: ReactNode; hint?: string; disabled?: boolean }[]
  onChange: (value: T) => void
}) {
  return (
    <Select
      value={value}
      items={options}
      onValueChange={(next) => {
        if (next !== null && next !== value) onChange(next as T)
      }}
    >
      <SelectTrigger aria-label={label} variant="quiet" className="-mr-2 text-ui">
        <SelectValue>
          {(current: T) => {
            const chosen = options.find((o) => o.value === current)
            return (
              <>
                {chosen?.icon}
                {chosen?.label}
              </>
            )
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="end">
        <SelectGroup>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
              {o.icon}
              {o.label}
              {o.hint && <span className="text-tertiary">{o.hint}</span>}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

/** Shows a file or folder in the platform's file manager. */
export function RevealAction({ path }: { path: string }) {
  const { t } = useTranslation('settings')
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <ControlError error={error} />
      <IconAction
        label={t('agents.showIn', { name: fileManagerName() })}
        onClick={() => {
          setError(null)
          window.kettu.shell.showItem(path).catch((e: unknown) => setError(errorMessage(e)))
        }}
      >
        <FolderIcon />
      </IconAction>
    </>
  )
}

/**
 * A path as a location, in the interface font: folders quiet, slashes quieter, the last part in
 * the label's weight. Too long, the folders truncate first, from their start, so the name and the
 * folders nearest it stay; it shows in full in its title. The separator before the name goes with
 * the folders, so a name whose folders are cut away entirely does not read as a root path.
 */
export function PathText({ path, missing }: { path: string; missing?: boolean }) {
  const parts = path.split(/(?<=.)[/\\]/)
  const separator = path.includes('\\') && !path.includes('/') ? '\\' : '/'
  const name = parts.pop() ?? ''
  const slash = <span>{separator}</span>
  return (
    <span
      title={path}
      data-selectable=""
      className="flex min-w-0 text-xs leading-normal whitespace-nowrap text-tertiary"
    >
      {parts.length > 0 && (
        // Right to left puts the ellipsis at the start; the marks keep the slashes in place.
        <span className="min-w-0 truncate [direction:rtl]">
          {'\u200E'}
          {parts.map((part, i) => (
            <span key={i}>
              {part}
              {slash}
            </span>
          ))}
          {'\u200E'}
        </span>
      )}
      <span className={cn('max-w-full shrink-0 truncate', !missing && 'font-medium text-primary')}>
        {name}
      </span>
    </span>
  )
}

// The padding holds the blur's soft edge, so nothing paints past the box; a shown value keeps it.
const MASK_BOX = 'inline-block rounded-full px-1.5 whitespace-nowrap'

/**
 * Account details behind a mask while Settings > Agents hides them: eight dots behind a blur,
 * the same width whatever the value, and the value itself withheld from the accessibility tree
 * and from copying. Clicking the mask shows that one value until it is clicked again; the setting
 * itself stays on. `revealable` is false where the show button cannot sit, as inside a menu item.
 */
export function Masked({
  children,
  revealable = true,
}: {
  children: string
  revealable?: boolean
}) {
  const { t } = useTranslation('settings')
  const hidden = useSettingsStore((s) => s.settings.privacy.hideAccount)
  const [revealed, setRevealed] = useState(false)
  // Hiding accounts again masks every value, including one shown by a click.
  const [hiddenBefore, setHiddenBefore] = useState(hidden)
  if (hidden !== hiddenBefore) {
    setHiddenBefore(hidden)
    setRevealed(false)
  }
  if (!hidden) return <span data-selectable="">{children}</span>
  const dots = (
    <span aria-hidden className="inline-block tracking-tighter blur-mask select-none">
      {'•'.repeat(8)}
    </span>
  )
  if (!revealable)
    return (
      <span data-slot="masked" className={MASK_BOX}>
        {dots}
      </span>
    )
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-slot="masked"
            aria-pressed={revealed}
            aria-label={revealed ? undefined : t('agents.hidden')}
            onClick={() => setRevealed((shown) => !shown)}
            className={cn(
              MASK_BOX,
              'pointer-events-auto outline-none transition-colors duration-(--duration-fast) hover:bg-hover focus-visible:shadow-[inset_0_0_0_2px_var(--focus)]',
            )}
          />
        }
      >
        {revealed ? (
          <span className="inline-block animate-in blur-in-xs fade-in-50 ease-out-quart animation-duration-(--duration-base) motion-reduce:animate-none">
            {children}
          </span>
        ) : (
          dots
        )}
      </TooltipTrigger>
      <TooltipContent>{t(revealed ? 'agents.maskAccount' : 'agents.revealAccount')}</TooltipContent>
    </Tooltip>
  )
}
