import type { ReactNode } from 'react'
import { XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { cn } from '@renderer/lib/utils'

/**
 * A dialog over Settings: 132 px from the top of the window rather than centred, so a step that
 * grows it grows downward, with its title and close at the top and its actions at the end.
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
        'top-33 max-h-[calc(100%-164px)] max-w-[calc(100%-64px)] translate-y-0 grid-cols-1 gap-0 overflow-hidden overflow-y-auto rounded-dialog p-0 data-open:slide-in-from-bottom-1 data-open:zoom-in-100 sm:max-w-130',
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
    <div className="px-6 pt-5.5 pb-1">
      <div className="flex items-center gap-2">
        <DialogTitle className="flex-1 text-sheet-title">{title}</DialogTitle>
        <DialogClose
          render={
            <Button
              variant="ghost"
              size="icon"
              className="size-7.5 rounded-segment text-tertiary"
              aria-label={t('actions.close')}
            />
          }
        >
          <XIcon className="size-4" />
        </DialogClose>
      </div>
      {children && (
        <DialogDescription className="mt-1.5 text-lede leading-normal text-tertiary">
          {children}
        </DialogDescription>
      )}
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
  return (
    <div className={cn('flex min-w-0 flex-col gap-3.5 px-6 pt-3.5 pb-1', className)}>
      {children}
    </div>
  )
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
    <div className="flex items-center gap-2 px-6 pt-4 pb-5">
      <div className="flex min-w-0 flex-1 items-center gap-2">{start}</div>
      {children}
    </div>
  )
}

/** A field's label over it, in the 13 px medium role. */
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
    <div className="flex min-w-0 flex-col gap-1.75">
      <label htmlFor={htmlFor} className="text-control font-medium text-primary">
        {label}
      </label>
      {children}
      {hint && <span className="text-hint text-tertiary">{hint}</span>}
    </div>
  )
}

/** An option tile as Settings' dialogs draw it: a raised gray once chosen, not the fox tint. */
export const SETTINGS_TILE =
  'gap-2.5 rounded-2xl px-3 py-2.75 text-lede shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)] data-checked:bg-subtle data-checked:shadow-[inset_0_0_0_var(--hairline)_var(--border-default)] [&>[aria-hidden]]:mt-0.5'

/** The body's frame, for a dialog that lays its body out itself. */
export const DIALOG_BODY = 'flex flex-col gap-3.5 px-6 pt-3.5 pb-1'

/** The footer's frame on the foundation's `DialogFooter`, for a dialog that lays it out itself. */
export const DIALOG_FOOTER = 'flex-row items-center gap-2 px-6 pt-4 pb-5'

/** A 32 px field with the dialog's 12.5 px code face, as an address or a key takes it. */
export const DIALOG_MONO_FIELD = 'h-8 rounded-xl px-2.75 font-mono text-hint md:text-hint'

/** A 32 px field in the dialog's 13.5 px text. */
export const DIALOG_FIELD = 'h-8 rounded-xl px-2.75 text-lede md:text-lede'
