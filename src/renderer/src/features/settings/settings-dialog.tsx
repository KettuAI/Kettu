import type { ReactNode } from 'react'
import { Cancel01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Icon } from '@renderer/components/affect/app-shell'
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { cn } from '@renderer/lib/utils'

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
