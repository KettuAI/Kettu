import { PreviewCard as PreviewCardPrimitive } from '@base-ui/react/preview-card'
import { cn } from 'cn'
import { useOverlayRoot } from '@renderer/stores/overlays'

function HoverCard({ open, defaultOpen, onOpenChange, ...props }: PreviewCardPrimitive.Root.Props) {
  const change = useOverlayRoot(open, defaultOpen, onOpenChange)
  return (
    <PreviewCardPrimitive.Root
      data-slot="hover-card"
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={change}
      {...props}
    />
  )
}

function HoverCardTrigger({ ...props }: PreviewCardPrimitive.Trigger.Props) {
  return <PreviewCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />
}

function HoverCardContent({
  className,
  side = 'bottom',
  sideOffset = 4,
  align = 'center',
  alignOffset = 4,
  anchor,
  ...props
}: PreviewCardPrimitive.Popup.Props &
  Pick<
    PreviewCardPrimitive.Positioner.Props,
    'align' | 'alignOffset' | 'side' | 'sideOffset' | 'anchor'
  >) {
  return (
    <PreviewCardPrimitive.Portal data-slot="hover-card-portal">
      <PreviewCardPrimitive.Positioner
        anchor={anchor}
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-(--layer-menu)"
      >
        <PreviewCardPrimitive.Popup
          data-slot="hover-card-content"
          data-overlay-layer=""
          className={cn(
            'z-50 w-64 origin-(--transform-origin) rounded-xl bg-popover p-2.5 text-sm text-popover-foreground shadow-menu outline-hidden transition-[opacity,transform] duration-200 ease-out-quint data-[ending-style]:duration-(--duration-fast) data-[ending-style]:ease-standard data-[side=bottom]:[--hover-y:-4px] data-[side=inline-end]:[--hover-x:-4px] data-[side=inline-start]:[--hover-x:4px] data-[side=left]:[--hover-x:4px] data-[side=right]:[--hover-x:-4px] data-[side=top]:[--hover-y:4px] data-[starting-style]:opacity-0 data-[starting-style]:[transform:translate3d(var(--hover-x,0px),var(--hover-y,0px),0)_scale(0.985)] data-[ending-style]:opacity-0 data-[ending-style]:[transform:translate3d(var(--hover-x,0px),var(--hover-y,0px),0)_scale(0.985)] motion-reduce:transition-none motion-reduce:data-[starting-style]:[transform:none] motion-reduce:data-[ending-style]:[transform:none]',
            className,
          )}
          {...props}
        />
      </PreviewCardPrimitive.Positioner>
    </PreviewCardPrimitive.Portal>
  )
}

export { HoverCard, HoverCardTrigger, HoverCardContent }
