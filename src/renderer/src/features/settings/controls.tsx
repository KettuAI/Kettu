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
    <span className="max-w-48 truncate text-xs text-destructive" title={error}>
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
              {o.hint && <span className="text-muted-foreground">{o.hint}</span>}
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
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
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
        <CheckIcon className="animate-in text-success animation-duration-(--duration-fast) fade-in zoom-in-75" />
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
 * the label's weight. It truncates from the end and shows in full in its title.
 */
export function PathText({ path, missing }: { path: string; missing?: boolean }) {
  const parts = path.split(/(?<=.)[/\\]/)
  const separator = path.includes('\\') && !path.includes('/') ? '\\' : '/'
  return (
    <span
      title={path}
      data-selectable=""
      className="block min-w-0 truncate text-xs leading-normal text-muted-foreground"
    >
      {parts.map((part, i) => {
        const last = i === parts.length - 1
        return (
          <span key={i}>
            {i > 0 && <span className="mx-0.5">{separator}</span>}
            <span className={cn(last && !missing && 'font-medium text-foreground')}>{part}</span>
          </span>
        )
      })}
    </span>
  )
}

/**
 * Account details behind a mask while Settings › Agents hides them: blurred on screen, and the
 * value itself withheld from the accessibility tree and from copying.
 */
export function Masked({ children }: { children: string }) {
  const { t } = useTranslation('settings')
  const hidden = useSettingsStore((s) => s.settings.privacy.hideAccount)
  if (!hidden) return <span data-selectable="">{children}</span>
  return (
    <span role="img" aria-label={t('agents.hidden')} className="inline-block blur-xs select-none">
      {'•'.repeat(Math.min(Math.max(children.length, 6), 18))}
    </span>
  )
}
