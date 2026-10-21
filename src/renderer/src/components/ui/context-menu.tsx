import * as React from 'react'
import { ContextMenu as ContextMenuPrimitive } from '@base-ui/react/context-menu'
import { cn } from 'cn'
import { ChevronRightIcon, CheckIcon } from 'lucide-react'

function ContextMenu({ ...props }: ContextMenuPrimitive.Root.Props) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />
}

function ContextMenuPortal({ ...props }: ContextMenuPrimitive.Portal.Props) {
  return <ContextMenuPrimitive.Portal data-slot="context-menu-portal" {...props} />
}

function ContextMenuTrigger({ className, ...props }: ContextMenuPrimitive.Trigger.Props) {
  return (
    <ContextMenuPrimitive.Trigger
      data-slot="context-menu-trigger"
      className={cn('select-none', className)}
      {...props}
    />
  )
}

function ContextMenuContent({
  className,
  align = 'start',
  alignOffset = 4,
  side = 'right',
  sideOffset = 0,
  ...props
}: ContextMenuPrimitive.Popup.Props &
  Pick<ContextMenuPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner
        className="isolate z-50 outline-none"
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          className={cn(
            'z-50 max-h-(--available-height) min-w-40 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-2xl bg-popover p-1.5 text-popover-foreground shadow-menu duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
            className,
          )}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuGroup({ ...props }: ContextMenuPrimitive.Group.Props) {
  return <ContextMenuPrimitive.Group data-slot="context-menu-group" {...props} />
}

function ContextMenuLabel({
  className,
  inset,
  ...props
}: ContextMenuPrimitive.GroupLabel.Props & {
  inset?: boolean
}) {
  return (
    <ContextMenuPrimitive.GroupLabel
      data-slot="context-menu-label"
      data-inset={inset}
      className={cn(
        'px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground data-inset:pl-8',
        className,
      )}
      {...props}
    />
  )
}

function ContextMenuItem({
  className,
  inset,
  variant = 'default',
  ...props
}: ContextMenuPrimitive.Item.Props & {
  inset?: boolean
  variant?: 'default' | 'destructive'
}) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "group/context-menu-item relative flex min-h-row cursor-default items-center gap-2 rounded-lg px-2 py-1 text-[13px] outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-inset:pl-8 data-disabled:pointer-events-none data-disabled:opacity-50 [&>.lucide]:text-muted-foreground focus:[&>.lucide]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive-tint data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:[&>.lucide]:text-destructive",
        className,
      )}
      {...props}
    />
  )
}

function ContextMenuSub({ ...props }: ContextMenuPrimitive.SubmenuRoot.Props) {
  return <ContextMenuPrimitive.SubmenuRoot data-slot="context-menu-sub" {...props} />
}

function ContextMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: ContextMenuPrimitive.SubmenuTrigger.Props & {
  inset?: boolean
}) {
  return (
    <ContextMenuPrimitive.SubmenuTrigger
      data-slot="context-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "relative flex min-h-row cursor-default items-center gap-2 rounded-lg px-2 py-1 text-[13px] outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-inset:pl-8 data-disabled:pointer-events-none data-disabled:opacity-50 [&>.lucide]:text-muted-foreground focus:[&>.lucide]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-popup-open:bg-accent data-popup-open:text-accent-foreground data-open:bg-accent data-open:text-accent-foreground",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-3.5" />
    </ContextMenuPrimitive.SubmenuTrigger>
  )
}

// The first item lines up with the parent item, and the submenu clears the menu's edge by 2 px.
function ContextMenuSubContent({
  alignOffset = -6,
  sideOffset = 8,
  ...props
}: React.ComponentProps<typeof ContextMenuContent>) {
  return (
    <ContextMenuContent
      data-slot="context-menu-sub-content"
      side="right"
      alignOffset={alignOffset}
      sideOffset={sideOffset}
      {...props}
    />
  )
}

function ContextMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  ...props
}: ContextMenuPrimitive.CheckboxItem.Props & {
  inset?: boolean
}) {
  return (
    <ContextMenuPrimitive.CheckboxItem
      data-slot="context-menu-checkbox-item"
      data-inset={inset}
      className={cn(
        "relative flex min-h-row cursor-default items-center gap-2 rounded-lg px-2 py-1 text-[13px] outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-inset:pl-8 data-disabled:pointer-events-none data-disabled:opacity-50 [&>.lucide]:text-muted-foreground focus:[&>.lucide]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 pr-8",
        className,
      )}
      checked={checked}
      {...props}
    >
      <span className="pointer-events-none absolute top-0 right-2 flex h-row items-center justify-center [&_svg]:size-3.5">
        <ContextMenuPrimitive.CheckboxItemIndicator>
          <CheckIcon />
        </ContextMenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.CheckboxItem>
  )
}

function ContextMenuRadioGroup({ ...props }: ContextMenuPrimitive.RadioGroup.Props) {
  return <ContextMenuPrimitive.RadioGroup data-slot="context-menu-radio-group" {...props} />
}

function ContextMenuRadioItem({
  className,
  children,
  inset,
  ...props
}: ContextMenuPrimitive.RadioItem.Props & {
  inset?: boolean
}) {
  return (
    <ContextMenuPrimitive.RadioItem
      data-slot="context-menu-radio-item"
      data-inset={inset}
      className={cn(
        "relative flex min-h-row cursor-default items-center gap-2 rounded-lg px-2 py-1 text-[13px] outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-inset:pl-8 data-disabled:pointer-events-none data-disabled:opacity-50 [&>.lucide]:text-muted-foreground focus:[&>.lucide]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 pr-8",
        className,
      )}
      {...props}
    >
      <span className="pointer-events-none absolute top-0 right-2 flex h-row items-center justify-center [&_svg]:size-3.5">
        <ContextMenuPrimitive.RadioItemIndicator>
          <CheckIcon />
        </ContextMenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.RadioItem>
  )
}

function ContextMenuSeparator({ className, ...props }: ContextMenuPrimitive.Separator.Props) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn('mx-2 my-1 hairline-x bg-border-soft', className)}
      {...props}
    />
  )
}

function ContextMenuShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="context-menu-shortcut"
      className={cn('ml-auto pl-4 text-xs text-muted-foreground tabular', className)}
      {...props}
    />
  )
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuRadioItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuGroup,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuRadioGroup,
}
