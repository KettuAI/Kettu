import { Radio as RadioPrimitive } from '@base-ui/react/radio'
import { RadioGroup as RadioGroupPrimitive } from '@base-ui/react/radio-group'
import { cn } from 'cn'

function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={cn('grid w-full gap-2', className)}
      {...props}
    />
  )
}

// Off, a ring of the strong line; on, a 5 px fox border around the surface.
function RadioGroupItem({ className, ...props }: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
      className={cn(
        'group/radio-group-item peer relative flex aspect-square size-4 shrink-0 rounded-full border-0 border-control-on bg-card shadow-[inset_0_0_0_1.5px_var(--border-strong)] transition-[border-width,box-shadow] duration-(--duration-fast) outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-ring disabled:cursor-not-allowed disabled:opacity-40 aria-invalid:shadow-[inset_0_0_0_1.5px_var(--danger)] data-checked:border-[5px] data-checked:shadow-none',
        className,
      )}
      {...props}
    />
  )
}

export { RadioGroup, RadioGroupItem }
