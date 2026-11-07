import { useEffect, useId, useSyncExternalStore } from 'react'
import { Alert02Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import {
  Toaster as AffectToaster,
  toast as affectToast,
  type ToastId,
  type ToastOptions as AffectToastOptions,
} from '@renderer/components/affect/toaster'
import { useOverlayStore } from '@renderer/stores/overlays'

/** What a toast reports, which picks its icon and its color. */
export type ToastTone = 'success' | 'warning' | 'info'

export interface ToastOptions {
  tone?: ToastTone
  /** The icon of a toast without a tone, such as an archive box for "Archived". */
  icon?: IconSvgElement
}

// The toasts on screen, so the layer can tell the browser pane it is covered.
const open = new Set<ToastId>()
const listeners = new Set<() => void>()
const changed = () => listeners.forEach((listener) => listener())
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const anyOpen = () => open.size > 0

const onDismiss = (closed: ToastId) => {
  open.delete(closed)
  changed()
}

function track(show: (options: AffectToastOptions) => ToastId, options: AffectToastOptions) {
  const id = show({ ...options, onDismiss })
  open.add(id)
  changed()
  return id
}

const actionOf = (action: { label: string; onClick: () => void }) => ({
  label: action.label,
  onClick: () => action.onClick(),
})

/**
 * Confirms a finished action at the foot of the window, such as a removal whose row is gone. An
 * action, such as Undo, keeps the toast up longer and closes it when chosen.
 */
export function toast(
  title: string,
  action?: { label: string; onClick: () => void },
  options: ToastOptions = {},
) {
  const { tone, icon } = options
  const show =
    tone === 'success' ? affectToast.success : tone === 'info' ? affectToast.info : affectToast
  const mark =
    tone === 'warning' ? (
      <HugeiconsIcon
        icon={Alert02Icon}
        strokeWidth={1.9}
        aria-hidden
        className="size-3.75 text-warning"
      />
    ) : icon ? (
      <HugeiconsIcon icon={icon} strokeWidth={1.9} aria-hidden className="size-3.75 text-icon" />
    ) : undefined
  track((settings) => show(title, settings), {
    icon: mark,
    ...(action && { action: actionOf(action), duration: 6000 }),
  })
}

/**
 * A toast that stays while work goes on, with an action such as Cancel, which closes it; the
 * caller updates its title and closes it once the work is done.
 */
export function lastingToast(title: string, action: { label: string; onClick: () => void }) {
  const settings = { duration: Infinity, action: actionOf(action), onDismiss }
  const id = track((options) => affectToast.loading(title, options), settings)
  return {
    update: (next: string) => affectToast.loading(next, { ...settings, id }),
    close: () => affectToast.dismiss(id),
  }
}

/** The toasts' layer, mounted once at the app's root. */
export function Toaster() {
  const { t } = useTranslation('common')
  const id = useId()
  const shown = useSyncExternalStore(subscribe, anyOpen)
  // A toast can cover the browser pane's native view, as a menu can.
  useEffect(() => {
    useOverlayStore.getState().set(id, shown)
    return () => useOverlayStore.getState().set(id, false)
  }, [id, shown])
  return (
    <AffectToaster
      position="bottom-center"
      label={t('toasts.region')}
      closeLabel={t('actions.dismiss')}
    />
  )
}
