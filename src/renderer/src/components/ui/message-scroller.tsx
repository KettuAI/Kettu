import * as React from 'react'
import {
  MessageScroller as MessageScrollerPrimitive,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
} from '@shadcn/react/message-scroller'
import { cn } from 'cn'

import { Button } from '@renderer/components/ui/button'
import { ArrowDown02Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'

function MessageScrollerProvider(
  props: React.ComponentProps<typeof MessageScrollerPrimitive.Provider>,
) {
  return <MessageScrollerPrimitive.Provider {...props} />
}

function MessageScroller({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Root>) {
  return (
    <MessageScrollerPrimitive.Root
      data-slot="message-scroller"
      className={cn(
        'group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden',
        className,
      )}
      {...props}
    />
  )
}

/**
 * MessageScroller takes only a wheel, a touch or a scroll key as the reader taking over, so while
 * it follows streaming output it pulls a dragged scrollbar back to the end, and moves the text from
 * under a selection being made. A press on the viewport itself, its scrollbar included, takes over
 * too, and so does a press in it that selects text. The scroller has no call for this, so it is
 * told with the wheel event it reads as the reader taking over.
 */
function takeOver(viewport: HTMLElement): void {
  viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
}

function takeOverOnSelection(viewport: HTMLElement): void {
  const selected = (): void => {
    const selection = document.getSelection()
    if (!selection || selection.isCollapsed || !viewport.contains(selection.anchorNode)) return
    stop()
    takeOver(viewport)
  }
  const stop = (): void => {
    document.removeEventListener('selectionchange', selected)
    window.removeEventListener('pointerup', stop, true)
    window.removeEventListener('pointercancel', stop, true)
  }
  document.addEventListener('selectionchange', selected)
  window.addEventListener('pointerup', stop, true)
  window.addEventListener('pointercancel', stop, true)
}

function MessageScrollerViewport({
  className,
  onPointerDown,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Viewport>) {
  return (
    <MessageScrollerPrimitive.Viewport
      data-slot="message-scroller-viewport"
      className={cn(
        'size-full min-h-0 min-w-0 scroll-fade-b scrollbar-thin scrollbar-gutter-stable overflow-y-auto overscroll-contain contain-content data-pending-scroll:invisible',
        className,
      )}
      onPointerDown={(event) => {
        if (event.button === 0) {
          const viewport = event.currentTarget
          if (event.target === viewport) takeOver(viewport)
          else takeOverOnSelection(viewport)
        }
        onPointerDown?.(event)
      }}
      {...props}
    />
  )
}

function MessageScrollerContent({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Content>) {
  return (
    <MessageScrollerPrimitive.Content
      data-slot="message-scroller-content"
      // scrollbar-color is inherited, so without its own value here a change of the viewport's
      // would recalculate the style of the whole thread.
      className={cn(
        'flex h-max min-h-full flex-col gap-6 [scrollbar-color:var(--border-strong)_transparent]',
        className,
      )}
      {...props}
    />
  )
}

function MessageScrollerItem({
  className,
  scrollAnchor = false,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Item>) {
  return (
    <MessageScrollerPrimitive.Item
      data-slot="message-scroller-item"
      scrollAnchor={scrollAnchor}
      className={cn(
        'min-w-0 shrink-0 [contain-intrinsic-size:auto_10rem] [content-visibility:auto]',
        className,
      )}
      {...props}
    />
  )
}

function MessageScrollerButton({
  direction = 'end',
  className,
  children,
  render,
  variant = 'secondary',
  size = 'icon-sm',
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Button> &
  Pick<React.ComponentProps<typeof Button>, 'variant' | 'size'>) {
  const { t } = useTranslation('app')
  return (
    <MessageScrollerPrimitive.Button
      data-slot="message-scroller-button"
      data-direction={direction}
      data-variant={variant}
      data-size={size}
      direction={direction}
      className={cn(
        'absolute inset-s-1/2 -translate-x-1/2 border-border bg-background text-foreground transition-[translate,scale,opacity] duration-200 hover:bg-muted hover:text-foreground data-[active=false]:pointer-events-none data-[active=false]:scale-95 data-[active=false]:opacity-0 data-[active=false]:duration-400 data-[active=false]:ease-[cubic-bezier(0.7,0,0.84,0)] data-[active=true]:translate-y-0 data-[active=true]:scale-100 data-[active=true]:opacity-100 data-[active=true]:ease-[cubic-bezier(0.23,1,0.32,1)] data-[direction=end]:bottom-4 data-[direction=end]:data-[active=false]:translate-y-full data-[direction=start]:top-4 data-[direction=start]:data-[active=false]:-translate-y-full rtl:translate-x-1/2 data-[direction=start]:[&_svg]:rotate-180',
        className,
      )}
      render={render ?? <Button variant={variant} size={size} />}
      {...props}
    >
      {children ?? (
        <>
          <HugeiconsIcon icon={ArrowDown02Icon} strokeWidth={1.9} aria-hidden />
          <span className="sr-only">
            {direction === 'end' ? t('messageScroller.toEnd') : t('messageScroller.toStart')}
          </span>
        </>
      )}
    </MessageScrollerPrimitive.Button>
  )
}

export {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
}
