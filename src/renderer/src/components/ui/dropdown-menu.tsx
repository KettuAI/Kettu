'use client'

import * as React from 'react'
import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import { cn } from 'cn'
import { ChevronRightIcon, CheckIcon } from 'lucide-react'
import { useOverlayRoot } from '@renderer/stores/overlays'

function DropdownMenu({ open, defaultOpen, onOpenChange, ...props }: MenuPrimitive.Root.Props) {
  const change = useOverlayRoot(open, defaultOpen, onOpenChange)
  return (
    <MenuPrimitive.Root
      data-slot="dropdown-menu"
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={change}
      {...props}
    />
  )
}

function DropdownMenuPortal({ ...props }: MenuPrimitive.Portal.Props) {
  return <MenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />
}

function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
}

function DropdownMenuContent({
  align = 'start',
  alignOffset = 0,
  side = 'bottom',
  sideOffset = 4,
  className,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<MenuPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        className="isolate z-50 outline-none"
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          data-overlay-layer=""
          className={cn(
            'z-50 max-h-(--available-height) min-w-40 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-xl bg-popover p-1 text-popover-foreground shadow-menu duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:overflow-hidden data-closed:fade-out-0 data-closed:zoom-out-95',
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

// Holds the items when other content shares the popup, so a pointer open focuses the list.
function DropdownMenuList({ ...props }: MenuPrimitive.List.Props) {
  return <MenuPrimitive.List data-slot="dropdown-menu-list" {...props} />
}

function DropdownMenuGroup({ ...props }: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: MenuPrimitive.GroupLabel.Props & {
  inset?: boolean
}) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        'flex h-7 items-center px-2 text-xs font-medium text-muted-foreground data-inset:pl-8',
        className,
      )}
      {...props}
    />
  )
}

function DropdownMenuItem({
  className,
  inset,
  variant = 'default',
  ...props
}: MenuPrimitive.Item.Props & {
  inset?: boolean
  variant?: 'default' | 'destructive'
}) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "group/dropdown-menu-item relative flex min-h-control cursor-default items-center gap-2 rounded-md px-2 py-1 text-ui outline-hidden select-none focus:bg-selected focus:text-accent-foreground data-inset:pl-8 data-disabled:pointer-events-none data-disabled:opacity-40 [&>.lucide]:text-icon focus:[&>.lucide]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.75 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive-tint data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:[&>.lucide]:text-destructive",
        className,
      )}
      {...props}
    />
  )
}

function DropdownMenuSub({ ...props }: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props & {
  inset?: boolean
}) {
  return (
    <MenuPrimitive.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "relative flex min-h-control cursor-default items-center gap-2 rounded-md px-2 py-1 text-ui outline-hidden select-none focus:bg-selected focus:text-accent-foreground data-inset:pl-8 data-disabled:pointer-events-none data-disabled:opacity-40 [&>.lucide]:text-icon focus:[&>.lucide]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.75 data-popup-open:bg-selected data-popup-open:text-accent-foreground data-open:bg-selected data-open:text-accent-foreground",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon strokeWidth={1.6} className="ml-auto size-3" />
    </MenuPrimitive.SubmenuTrigger>
  )
}

// The first item lines up with the parent item, and the submenu clears the menu's edge by 2 px.
function DropdownMenuSubContent({
  align = 'start',
  alignOffset = -6,
  side = 'right',
  sideOffset = 8,
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuContent>) {
  return (
    <DropdownMenuContent
      data-slot="dropdown-menu-sub-content"
      className={cn(
        'w-auto min-w-36 rounded-xl bg-popover p-1 text-popover-foreground shadow-menu duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
        className,
      )}
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      {...props}
    />
  )
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  ...props
}: MenuPrimitive.CheckboxItem.Props & {
  inset?: boolean
}) {
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      data-inset={inset}
      className={cn(
        "relative flex min-h-control cursor-default items-center gap-2 rounded-md px-2 py-1 text-ui outline-hidden select-none focus:bg-selected focus:text-accent-foreground data-inset:pl-8 data-disabled:pointer-events-none data-disabled:opacity-40 [&>.lucide]:text-icon focus:[&>.lucide]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.75 pr-8",
        className,
      )}
      checked={checked}
      {...props}
    >
      <span
        className="pointer-events-none absolute top-0 right-2 flex h-control items-center justify-center [&_svg]:size-3"
        data-slot="dropdown-menu-checkbox-item-indicator"
      >
        <MenuPrimitive.CheckboxItemIndicator>
          <CheckIcon strokeWidth={1.6} />
        </MenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </MenuPrimitive.CheckboxItem>
  )
}

function DropdownMenuRadioGroup({ ...props }: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />
}

function DropdownMenuRadioItem({
  className,
  children,
  inset,
  ...props
}: MenuPrimitive.RadioItem.Props & {
  inset?: boolean
}) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      data-inset={inset}
      className={cn(
        "relative flex min-h-control cursor-default items-center gap-2 rounded-md px-2 py-1 text-ui outline-hidden select-none focus:bg-selected focus:text-accent-foreground data-inset:pl-8 data-disabled:pointer-events-none data-disabled:opacity-40 [&>.lucide]:text-icon focus:[&>.lucide]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.75 pr-8",
        className,
      )}
      {...props}
    >
      <span
        className="pointer-events-none absolute top-0 right-2 flex h-control items-center justify-center [&_svg]:size-3"
        data-slot="dropdown-menu-radio-item-indicator"
      >
        <MenuPrimitive.RadioItemIndicator>
          <CheckIcon strokeWidth={1.6} />
        </MenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  )
}

function DropdownMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn('mx-0.5 my-1 hairline-x bg-border-soft', className)}
      {...props}
    />
  )
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn('ml-auto pl-4 text-caption text-tertiary tabular', className)}
      {...props}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuList,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
}
