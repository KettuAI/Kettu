import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox'
import { cn } from 'cn'
import { Tick02Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'peer group/checkbox relative flex size-4 shrink-0 items-center justify-center rounded-sm bg-card text-switch-thumb shadow-[inset_0_0_0_1.5px_var(--border-strong)] transition-colors outline-none group-has-disabled/field:opacity-40 after:absolute after:-inset-x-3 after:-inset-y-2 focus-ring disabled:cursor-not-allowed disabled:opacity-40 aria-invalid:shadow-[inset_0_0_0_1.5px_var(--danger)] data-checked:bg-control-on data-checked:shadow-none data-indeterminate:bg-control-on data-indeterminate:shadow-none',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none [&>svg]:size-2.75"
      >
        {/* Mixed shows a bar instead of the check. */}
        <HugeiconsIcon
          icon={Tick02Icon}
          strokeWidth={1.9}
          aria-hidden
          className="group-data-indeterminate/checkbox:hidden"
        />
        <span className="hidden h-0.5 w-2 rounded-full bg-current group-data-indeterminate/checkbox:block" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
