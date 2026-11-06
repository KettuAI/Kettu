import { useState, type ComponentProps, type ReactNode, type Ref, type RefObject } from 'react'
import type { IconSvgElement } from '@hugeicons/react'
import {
  ArrowDown01Icon,
  Cancel01Icon,
  Copy01Icon,
  FolderOpenIcon,
  Search01Icon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Dropdown, Icon } from '@renderer/components/affect/app-shell'
import { Button, css as buttonCss, type ButtonProps } from '@renderer/components/affect/button'
import { SegmentedControl } from '@renderer/components/affect/segmented-control'
import { css as securityCss } from '@renderer/components/affect/settings-security'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { errorMessage } from '@renderer/lib/host'
import { LIMIT_FILL, LIMIT_TEXT, type LimitLevel } from '@renderer/lib/plan-limit'
import { fileManagerName, isWeb } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { useHostScope } from '@renderer/stores/host-scope'
import { useSettingsStore } from '@renderer/stores/settings'

/** The width of Settings' confirmations, whose sentences run longer than most. */
export const CONFIRM = 'data-[size=default]:sm:max-w-105'

/** A field's label above it, as the Cloudflare account and a custom proxy take them. */
export const FIELD_LABEL = 'k-field'

export function ControlError({ error, wrap }: { error: string | null; wrap?: boolean }) {
  if (!error) return null
  return (
    <span role="alert" className="k-error" data-wrap={wrap || undefined} title={error}>
      {error}
    </span>
  )
}

/** The settings' own sheet, for a control drawn outside the Settings modal, as in the thread. */
function SecurityStyles() {
  return (
    <style href="ui-settings-security" precedence="default">
      {securityCss}
    </style>
  )
}

/** A switch as affectUI's settings draw it: the blue square one. */
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
    <>
      <SecurityStyles />
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        className="ui-ss-switch"
        onClick={() => onChange(!checked)}
      />
    </>
  )
}

/** affectUI's Segmented Control at `lg`, 32 px like the selects beside it. */
export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string
  value: T
  options: { value: T; label: string; disabled?: boolean }[]
  onChange: (value: T) => void
  disabled?: boolean
}) {
  return (
    <SegmentedControl
      size="lg"
      variant="tray"
      aria-label={label}
      disabled={disabled}
      value={String(value)}
      options={options.map((o) => ({
        value: String(o.value),
        label: o.label,
        disabled: o.disabled,
      }))}
      onChange={(next) => {
        const picked = options.find((o) => String(o.value) === next)
        if (picked && picked.value !== value) onChange(picked.value)
      }}
    />
  )
}

/** A row's button: affectUI's small Button, white with a hairline unless `variant` says otherwise. */
export function SetButton({ variant = 'secondary', size = 'sm', ...props }: ButtonProps) {
  return <Button variant={variant} size={size} {...props} />
}

/** A link that opens elsewhere, drawn as the row's button: affectUI's Button has no link form. */
export function LinkButton({
  href,
  icon,
  children,
}: {
  href: string
  icon?: ReactNode
  children: ReactNode
}) {
  return (
    <>
      <style href="ui-button-clean" precedence="default">
        {buttonCss}
      </style>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="ui-buttonc"
        data-variant="secondary"
        data-size="sm"
        data-icon-left={icon ? '' : undefined}
      >
        {icon && (
          <span className="ui-buttonc__icon" aria-hidden="true">
            {icon}
          </span>
        )}
        <span className="ui-buttonc__label">{children}</span>
      </a>
    </>
  )
}

/** A destructive action, in red on a red hairline, as the settings' danger zone draws it. */
export function DangerButton({
  busy,
  className,
  children,
  disabled,
  ...props
}: ComponentProps<'button'> & { busy?: boolean }) {
  return (
    <button
      type="button"
      className={cn('ui-sg-danger', className)}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      {...props}
    >
      {busy && <Spin />}
      {children}
    </button>
  )
}

/** The settings' small spinner. */
export function Spin({ label }: { label?: string }) {
  const { t } = useTranslation('common')
  return <span role="status" aria-label={label ?? t('loading')} className="ui-ss-spinner" />
}

/** A loading line, as wide as `width`. */
export function Skel({ width, className }: { width: number | string; className?: string }) {
  return <span aria-hidden className={cn('k-skel', className)} style={{ width }} />
}

/** A state as a quiet badge: gray, green when it is fine, amber when it waits on the user. */
export function Pill({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: 'neutral' | 'attention' | 'success' | 'warning'
  className?: string
  children: ReactNode
}) {
  return (
    <span
      className={cn('ui-ss-badge', className)}
      data-tone={tone === 'success' ? 'ok' : tone === 'neutral' ? undefined : 'warn'}
    >
      {children}
    </span>
  )
}

/** A plan limit or a download as a 4 px bar and its percent, in the plan limits' level colors. */
export function Meter({
  value,
  label,
  level = 'ok',
  text,
  long,
}: {
  /** 0 to 100. */
  value: number
  /** The accessible name of the bar. */
  label: string
  level?: LimitLevel
  /** The percent as shown; the rounded value otherwise. */
  text?: string
  long?: boolean
}) {
  return (
    <span className="k-meter">
      <span
        role="progressbar"
        aria-label={label}
        aria-valuenow={Math.round(value)}
        aria-valuemin={0}
        aria-valuemax={100}
        className={cn('k-meter__bar', long && 'k-meter__bar--long')}
      >
        <span className={LIMIT_FILL[level]} style={{ width: `${Math.min(100, value)}%` }} />
      </span>
      <span className={cn('k-num k-meter__value', level !== 'ok' && LIMIT_TEXT[level])}>
        {text ?? `${Math.round(value)}%`}
      </span>
    </span>
  )
}

/** A command as it runs, in the code face on the settings' gray, which can be copied. */
export function CommandLine({ command, label }: { command: string; label?: string }) {
  const { t } = useTranslation('common')
  return (
    <span className="k-cmd">
      <code data-selectable="" title={command}>
        {command}
      </code>
      <CopyAction text={command} label={label ?? t('actions.copyCommand')} />
    </span>
  )
}

/** A field in a row, in the settings' look. */
export function SetInput({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn('ui-sg-input k-input', className)} {...props} />
}

/** A search field as the settings screens draw one; Esc clears it, then leaves it. */
export function FindField({
  value,
  onChange,
  label,
  clearLabel,
  inputRef,
  className,
  autoFocus,
}: {
  value: string
  onChange: (value: string) => void
  /** The placeholder and the field's name. */
  label: string
  clearLabel: string
  inputRef?: RefObject<HTMLInputElement | null>
  className?: string
  autoFocus?: boolean
}) {
  return (
    <label className={cn('ui-sm-search k-find', className)}>
      <Icon icon={Search01Icon} size={14} />
      <input
        ref={inputRef}
        value={value}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        placeholder={label}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
          event.stopPropagation()
          if (value) onChange('')
          else event.currentTarget.blur()
        }}
      />
      {value && (
        <button
          type="button"
          aria-label={clearLabel}
          onClick={() => {
            onChange('')
            inputRef?.current?.focus()
          }}
        >
          <Icon icon={Cancel01Icon} size={10} />
        </button>
      )}
    </label>
  )
}

/** A choice from a list on the shell's menu, framed as a field, 210 px wide unless `className` says otherwise. */
export function SettingSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  className,
  lead,
}: {
  label: string
  value: T
  options: { value: T; label: string; icon?: ReactNode; hint?: string; disabled?: boolean }[]
  onChange: (value: T) => void
  disabled?: boolean
  className?: string
  /** Shown before the value when the chosen option has no icon, as Language's globe. */
  lead?: ReactNode
}) {
  const chosen = options.find((o) => o.value === value)
  const mark = chosen?.icon ?? lead
  return (
    <>
      <SecurityStyles />
      <Dropdown
        align="end"
        items={options.map((o) => ({
          label: o.label,
          logo: o.icon,
          description: o.hint,
          checked: o.value === value,
          disabled: o.disabled,
          onSelect: () => {
            if (o.value !== value) onChange(o.value)
          },
        }))}
        trigger={({ open, toggle }) => (
          <button
            type="button"
            className={cn('ui-ss-select k-select', className)}
            aria-label={label}
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={disabled}
            onClick={toggle}
          >
            {mark && <span className="k-select__lead">{mark}</span>}
            <span className="k-select__value">{chosen?.label}</span>
            <Icon icon={ArrowDown01Icon} size={14} />
          </button>
        )}
      />
    </>
  )
}

/** An icon-only quiet button, named by its tooltip and its accessible name. */
export function IconAction({
  label,
  icon,
  onClick,
  disabled,
  busy,
  ref,
}: {
  label: string
  icon: IconSvgElement
  onClick: () => void
  disabled?: boolean
  busy?: boolean
  ref?: Ref<HTMLButtonElement>
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            ref={ref}
            variant="ghost"
            size="sm"
            aria-label={label}
            loading={busy}
            disabled={disabled}
            onClick={onClick}
            icon={<Icon icon={icon} size={14} />}
          />
        }
      />
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
      icon={copied ? Tick02Icon : Copy01Icon}
      onClick={() => {
        void navigator.clipboard.writeText(typeof text === 'function' ? text() : text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    />
  )
}

/**
 * Shows a file or folder in the platform's file manager. Neither a browser nor this computer can
 * show another host's files, and the copy action beside it already gives the path, so it shows
 * nothing there.
 */
export function RevealAction({ path }: { path: string }) {
  const { t } = useTranslation('settings')
  const { hostId } = useHostScope()
  const [error, setError] = useState<string | null>(null)
  if (isWeb || hostId !== null) return null
  return (
    <>
      <ControlError error={error} />
      <IconAction
        label={t('agents.showIn', { name: fileManagerName() })}
        icon={FolderOpenIcon}
        onClick={() => {
          setError(null)
          window.kettu.shell.showItem(path).catch((e: unknown) => setError(errorMessage(e)))
        }}
      />
    </>
  )
}

/** Show in Finder as a row's button, with the folder's icon. */
export function RevealButton({ path }: { path: string; outline?: boolean }) {
  const { t } = useTranslation('settings')
  const { hostId } = useHostScope()
  const [error, setError] = useState<string | null>(null)
  if (isWeb || hostId !== null) return null
  return (
    <>
      <ControlError error={error} />
      <SetButton
        icon={<Icon icon={FolderOpenIcon} size={14} />}
        onClick={() => {
          setError(null)
          window.kettu.shell.showItem(path).catch((e: unknown) => setError(errorMessage(e)))
        }}
      >
        {t('agents.showIn', { name: fileManagerName() })}
      </SetButton>
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
      className="k-path flex min-w-0 text-xs leading-normal whitespace-nowrap"
    >
      {parts.length > 0 && (
        // Right to left puts the ellipsis at the start; the marks keep the slashes in place.
        <span className="min-w-0 truncate [direction:rtl]">
          {'‎'}
          {parts.map((part, i) => (
            <span key={i}>
              {part}
              {slash}
            </span>
          ))}
          {'‎'}
        </span>
      )}
      <span className={cn('max-w-full shrink-0 truncate', !missing && 'k-path__name')}>{name}</span>
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
