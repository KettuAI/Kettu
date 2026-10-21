import type { ReactNode } from 'react'
import { SegmentedControl } from '@renderer/components/segmented-control'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { Switch } from '@renderer/components/ui/switch'

export function ControlError({ error }: { error: string | null }) {
  if (!error) return null
  return (
    <span className="max-w-48 truncate text-xs text-destructive" title={error}>
      {error}
    </span>
  )
}

export function SettingSwitch({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <Switch aria-label={label} checked={checked} onCheckedChange={(value) => onChange(value)} />
  )
}

export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  return (
    <SegmentedControl
      aria-label={label}
      value={String(value)}
      segments={options.map((o) => ({ value: String(o.value), label: o.label }))}
      onChange={(next) => {
        const picked = options.find((o) => String(o.value) === next)
        if (picked) onChange(picked.value)
      }}
    />
  )
}

export function SettingSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string; icon?: ReactNode }[]
  onChange: (value: T) => void
}) {
  return (
    <Select
      value={value}
      items={options}
      onValueChange={(next) => {
        if (next !== null && next !== value) onChange(next as T)
      }}
    >
      <SelectTrigger aria-label={label} className="min-w-40">
        <SelectValue>
          {(current: T) => {
            const chosen = options.find((o) => o.value === current)
            return (
              <>
                {chosen?.icon}
                {chosen?.label}
              </>
            )
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="end">
        <SelectGroup>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.icon}
              {o.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
