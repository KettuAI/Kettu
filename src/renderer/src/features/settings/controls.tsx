import { useState, type ReactNode } from 'react'
import { CheckIcon, CopyIcon, FolderIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SegmentedControl } from '@renderer/components/segmented-control'
import { Button } from '@renderer/components/ui/button'
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
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <Switch aria-label={label} checked={checked} onCheckedChange={(value) => onChange(value)} />
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

/** An icon-only quiet button, named by its tooltip and its accessible name. */
export function IconAction({
  label,
  onClick,
  disabled,
  busy,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  busy?: boolean
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="quiet"
            size="icon-xs"
            aria-label={label}
            aria-busy={busy}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** Copies `text`; the icon turns into a check for a moment, which is the confirmation. */
export function CopyAction({ text, label }: { text: string | (() => string); label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <IconAction
      label={label}
      onClick={() => {
        void navigator.clipboard.writeText(typeof text === 'function' ? text() : text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? (
        <CheckIcon className="animate-in text-icon animation-duration-(--duration-fast) fade-in zoom-in-75" />
      ) : (
        <CopyIcon />
      )}
    </IconAction>
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
          window.overbench.shell.showItem(path).catch((e: unknown) => setError(errorMessage(e)))
        }}
      >
        <FolderIcon />
      </IconAction>
    </>
  )
}

/**
 * A path as a location, in the interface font: folders quiet, slashes quieter, the last part in
 * the label's weight. Too long, the folders truncate first, so the name stays; it shows in full in
 * its title. The separator before the name goes with the folders, so a name whose folders are cut
 * away entirely does not read as a root path.
 */
export function PathText({ path, missing }: { path: string; missing?: boolean }) {
  const parts = path.split(/(?<=.)[/\\]/)
  const separator = path.includes('\\') && !path.includes('/') ? '\\' : '/'
  const name = parts.pop() ?? ''
  const slash = <span className="mx-0.5">{separator}</span>
  return (
    <span
      title={path}
      data-selectable=""
      className="flex min-w-0 text-xs leading-normal whitespace-nowrap text-tertiary"
    >
      {parts.length > 0 && (
        <span className="min-w-0 truncate">
          {parts.map((part, i) => (
            <span key={i}>
              {part}
              {slash}
            </span>
          ))}
        </span>
      )}
      <span className={cn('max-w-full shrink-0 truncate', !missing && 'font-medium text-primary')}>
        {name}
      </span>
    </span>
  )
}

/**
 * Account details behind a mask while Settings > Agents hides them: blurred on screen, and the
 * value itself withheld from the accessibility tree and from copying. Clicking the mask shows
 * that one value until it is clicked again; the setting itself stays on.
 */
export function Masked({ children }: { children: string }) {
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
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-pressed={revealed}
            aria-label={revealed ? undefined : t('agents.hidden')}
            onClick={() => setRevealed((shown) => !shown)}
            className="pointer-events-auto -mx-1 inline-block rounded-sm px-1 outline-none transition-colors duration-(--duration-fast) hover:bg-hover focus-ring"
          />
        }
      >
        {revealed ? (
          children
        ) : (
          <span aria-hidden className="inline-block blur-xs select-none">
            {'•'.repeat(Math.min(Math.max(children.length, 6), 18))}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent>{t(revealed ? 'agents.maskAccount' : 'agents.revealAccount')}</TooltipContent>
    </Tooltip>
  )
}
