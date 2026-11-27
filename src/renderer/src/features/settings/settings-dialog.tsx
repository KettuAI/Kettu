import { useId, type ReactNode } from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { Cancel01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Icon } from '@renderer/components/affect/app-shell'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogPortal,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { RadioGroupItem } from '@renderer/components/ui/radio-group'
import { cn } from '@renderer/lib/utils'
import { closeSettings, settingsBack } from '@renderer/stores/view'

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return (
    el.isContentEditable ||
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT'
  )
}

/**
 * The modal frame around Settings: full-window dimmed backdrop scrim, focus entry, outside-click
 * dismiss and Esc step-back behavior.
 */
export function SettingsDialogFrame({
  open,
  titleId,
  children,
}: {
  open: boolean
  titleId: string
  children: ReactNode
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        if (next) return
        // Esc steps back from an item's page first, and leaves a field being typed in alone.
        if (details.reason === 'escape-key') {
          details.cancel()
          if (!isEditable(details.event.target)) settingsBack()
          return
        }
        closeSettings()
      }}
    >
      <DialogPortal>
        <DialogPrimitive.Backdrop
          data-overlay-layer=""
          className="kettu-settings-scrim app-region-no-drag"
        />
        <DialogPrimitive.Popup
          // The section in the list takes the focus, so Tab starts from it, without scrolling the
          // list down to a section near its end, which would hide the search above it.
          initialFocus={() => {
            const current = document.querySelector<HTMLElement>(
              '[data-settings-dialog] nav [aria-current=page]',
            )
            if (!current) return true
            current.focus({ preventScroll: true })
            return false
          }}
          aria-labelledby={titleId}
          data-overlay-layer=""
          data-settings-dialog=""
          className="ui-as kettu-settings app-region-no-drag"
        >
          {children}
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  )
}

/**
 * A dialog over Settings, on the settings' panel: 132 px from the top of the window rather than
 * centred, so a step that grows it grows downward, with its title and close at the top and its
 * actions at the end. It carries .ui-as, so the settings screens' parts draw inside it.
 */
export function SettingsDialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogContent>) {
  return (
    <DialogContent
      showCloseButton={false}
      forceOverlay
      className={cn(
        'ui-as kettu-sd top-33 max-h-[calc(100%-164px)] max-w-[calc(100%-64px)] translate-y-0 grid-cols-1 gap-0 overflow-hidden overflow-y-auto p-0 data-open:slide-in-from-bottom-1 data-open:zoom-in-100 sm:max-w-130',
        className,
      )}
      {...props}
    >
      {children}
    </DialogContent>
  )
}

/** The title, the close button and the line under them. */
export function SettingsDialogHeader({
  title,
  children,
}: {
  title: ReactNode
  /** The line under the title. */
  children?: ReactNode
}) {
  const { t } = useTranslation('common')
  return (
    <div className="kettu-sd__head">
      <div className="kettu-sd__titles">
        <DialogTitle className="kettu-sd__title">{title}</DialogTitle>
        <DialogClose
          render={
            <button type="button" className="ui-as-icon-btn" aria-label={t('actions.close')} />
          }
        >
          <Icon icon={Cancel01Icon} size={16} />
        </DialogClose>
      </div>
      {children && <DialogDescription className="kettu-sd__desc">{children}</DialogDescription>}
    </div>
  )
}

/** The dialog's fields and steps, 14 px under its header. */
export function SettingsDialogBody({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}) {
  return <div className={cn(DIALOG_BODY, className)}>{children}</div>
}

/** The actions at the dialog's end, on the right. */
export function SettingsDialogFooter({
  children,
  start,
}: {
  children: ReactNode
  /** What sits on the left, such as a step's progress. */
  start?: ReactNode
}) {
  return (
    <div className={DIALOG_FOOTER}>
      <div className="kettu-sd__start">{start}</div>
      {children}
    </div>
  )
}

/** A field's label over it, and a hint under it. */
export function SettingsField({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: ReactNode
  htmlFor?: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="kettu-sd__field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <span className="kettu-sd__hint">{hint}</span>}
    </div>
  )
}

/** An option tile in Settings' dialogs: a hairline, blue once chosen. */
export const SETTINGS_TILE = 'kettu-sd__tile'

/** The body's frame, for a dialog that lays its body out itself. */
export const DIALOG_BODY = 'kettu-sd__body'

/** The footer's frame, for a dialog that lays it out itself. */
export const DIALOG_FOOTER = 'kettu-sd__foot'

/** A 32 px field in the code face, as an address or a key takes it. */
export const DIALOG_MONO_FIELD = 'ui-sg-input kettu-sd__input kettu-sd__input--mono'

/** A 32 px field in the dialog's text. */
export const DIALOG_FIELD = 'ui-sg-input kettu-sd__input'

/** One choice of a few as a tile, with what it does under it and anything it needs inside. */
export function Choice({
  value,
  checked,
  title,
  description,
  extra,
}: {
  value: string
  checked: boolean
  title: string
  description: string
  extra?: ReactNode
}) {
  const id = useId()
  return (
    <div className="kettu-sd__choice" data-checked={checked || undefined}>
      <label htmlFor={id}>
        <RadioGroupItem id={id} value={value} className="mt-0.5" />
        <span className="ui-sg-label">
          <b>{title}</b>
          <small>{description}</small>
        </span>
      </label>
      {extra && <div className="kettu-sd__choice-extra">{extra}</div>}
    </div>
  )
}
