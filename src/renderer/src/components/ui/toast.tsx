import { useEffect, useId } from 'react'
import { Toast } from '@base-ui/react/toast'
import { CheckIcon, InfoIcon, TriangleAlertIcon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'
import { useOverlayStore } from '@renderer/stores/overlays'

const manager = Toast.createToastManager()

/** What a toast reports, which picks its icon. */
export type ToastTone = 'success' | 'warning' | 'info'

export interface ToastOptions {
  tone?: ToastTone
  /** Shows a close button, for a result the user may want gone before it times out. */
  dismissible?: boolean
}

/**
 * Confirms a finished action at the foot of the window, such as a removal whose row is gone. An
 * action, such as Undo, keeps the toast up longer and closes it when chosen.
 */
export function toast(
  title: string,
  action?: { label: string; onClick: () => void },
  options: ToastOptions = {},
) {
  const { tone, dismissible = false } = options
  if (!action) {
    manager.add({ title, type: tone, data: { dismissible } })
    return
  }
  const id: string = manager.add({
    title,
    type: tone,
    data: { dismissible },
    timeout: 6000,
    actionProps: {
      children: action.label,
      onClick: () => {
        manager.close(id)
        action.onClick()
      },
    },
  })
}

/**
 * A toast that stays while work goes on, with an action such as Cancel, which closes it; the
 * caller updates its title and closes it once the work is done.
 */
export function lastingToast(title: string, action: { label: string; onClick: () => void }) {
  const id: string = manager.add({
    title,
    timeout: 0,
    actionProps: {
      children: action.label,
      onClick: () => {
        manager.close(id)
        action.onClick()
      },
    },
  })
  return {
    update: (next: string) => manager.update(id, { title: next }),
    close: () => manager.close(id),
  }
}

/** The toasts' layer, mounted once at the app's root. */
export function Toaster() {
  return (
    <Toast.Provider toastManager={manager} timeout={4000} limit={1}>
      <Toast.Portal>
        <Toast.Viewport className="fixed bottom-5.5 left-1/2 z-50 grid w-max max-w-105 -translate-x-1/2 outline-none">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  )
}

const TONE = {
  success: { Icon: CheckIcon, color: 'text-toast-success' },
  warning: { Icon: TriangleAlertIcon, color: 'text-toast-warning' },
  info: { Icon: InfoIcon, color: 'text-toast-info' },
} as const

function ToastList() {
  const { t } = useTranslation('common')
  const { toasts } = Toast.useToastManager()
  const id = useId()
  const shown = toasts.length > 0
  // A toast can cover the browser pane's native view, as a menu can.
  useEffect(() => {
    useOverlayStore.getState().set(id, shown)
    return () => useOverlayStore.getState().set(id, false)
  }, [id, shown])
  return toasts.map((item) => {
    const tone = item.type && item.type in TONE ? TONE[item.type as ToastTone] : null
    const dismissible = (item.data as { dismissible?: boolean } | undefined)?.dismissible === true
    return (
      <Toast.Root
        key={item.id}
        toast={item}
        swipeDirection={[]}
        data-overlay-layer=""
        className="col-start-1 row-start-1 flex min-h-10 min-w-0 items-center gap-2.5 justify-self-center rounded-2xl bg-toast px-3 py-1.5 text-control text-toast-foreground shadow-toast has-[button]:pr-1.5 transition-[opacity,translate] duration-(--duration-base) ease-standard data-ending-style:opacity-0 data-limited:hidden data-starting-style:opacity-0 motion-safe:data-starting-style:translate-y-1"
      >
        {tone && (
          <span className={cn('flex shrink-0', tone.color)}>
            <tone.Icon aria-hidden className="size-3.5" />
          </span>
        )}
        <Toast.Title className="min-w-0 flex-1 truncate" />
        <Toast.Action className="h-6.5 shrink-0 rounded-tile bg-toast-foreground/12 px-2.25 text-hint font-semibold text-toast-foreground outline-none hover:bg-toast-foreground/20 focus-ring" />
        {dismissible && (
          <Toast.Close
            aria-label={t('actions.dismiss')}
            className="-ml-1 flex size-6 shrink-0 items-center justify-center rounded-tile text-toast-muted outline-none hover:bg-toast-foreground/12 hover:text-toast-foreground focus-ring"
          >
            <XIcon aria-hidden className="size-3.5" />
          </Toast.Close>
        )}
      </Toast.Root>
    )
  })
}
