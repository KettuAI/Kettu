import { Switch as SwitchPrimitive } from '@base-ui/react/switch'
import { cn } from 'cn'

/**
 * App Shell's soft square switch, blue when on: `default` and `md` are 32 x 20 for settings and
 * list rows, `sm` 26 x 16 inside menus; each keeps its thumb 2 px inside the track.
 */
function Switch({
  className,
  size = 'default',
  ...props
}: SwitchPrimitive.Root.Props & {
  size?: 'sm' | 'md' | 'default'
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        'peer group/switch relative inline-flex h-5 w-8 shrink-0 items-center rounded-[6px] px-0.5 transition-colors duration-(--duration-base) outline-none focus-ring after:absolute after:-inset-x-3 after:-inset-y-2 aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[size=sm]:h-4 data-[size=sm]:w-6.5 data-[size=sm]:rounded-[5px] data-checked:bg-(--shell-switch-on) data-unchecked:bg-(--shell-toggle-off) data-disabled:cursor-not-allowed data-disabled:opacity-45',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-4 rounded-[4.5px] bg-switch-thumb shadow-thumb transition-[translate] duration-(--duration-slow) ease-standard group-data-[size=sm]/switch:size-3 group-data-[size=sm]/switch:rounded-[3.5px] data-checked:translate-x-3 data-unchecked:translate-x-0 group-data-[size=sm]/switch:data-checked:translate-x-2.5 motion-reduce:transition-none"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
