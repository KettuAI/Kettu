import { cn } from 'cn'
import * as ResizablePrimitive from 'react-resizable-panels'

function ResizablePanelGroup({ className, ...props }: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn('flex h-full w-full aria-[orientation=vertical]:flex-col', className)}
      {...props}
    />
  )
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean
}) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        'group relative flex w-(--hairline) items-center justify-center bg-transparent transition-colors duration-(--duration-fast)',
        // With a grip, the grip shows the state and the line keeps its color.
        !withHandle &&
          'data-[separator=active]:bg-border-strong data-[separator=hover]:bg-border-strong',
        'after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-ring aria-[orientation=horizontal]:h-(--hairline) aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 [&[aria-orientation=horizontal]>div]:rotate-90',
        className,
      )}
      {...props}
    >
      {/* A click leaves the handle focused, and the library then reports focus instead of
          hover, so hover is also read from :hover. */}
      {withHandle && (
        <div className="z-10 flex h-12 w-1 shrink-0 rounded-full bg-muted-foreground opacity-0 transition-[opacity,background-color] duration-(--duration-fast) group-data-[separator=active]:bg-foreground group-data-[separator=active]:opacity-100 group-data-[separator=hover]:opacity-100 group-data-[separator=focus]:group-hover:opacity-100" />
      )}
    </ResizablePrimitive.Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
