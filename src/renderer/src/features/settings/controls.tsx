import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { Switch } from '@renderer/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@renderer/components/ui/toggle-group'

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
    <ToggleGroup
      aria-label={label}
      variant="segmented"
      size="compact"
      spacing={0.5}
      value={[String(value)]}
      onValueChange={(next) => {
        const picked = options.find((o) => String(o.value) === next[0])
        if (picked && picked.value !== value) onChange(picked.value)
      }}
    >
      {options.map((o) => (
        <ToggleGroupItem key={String(o.value)} value={String(o.value)}>
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
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
  options: { value: T; label: string }[]
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
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        <SelectGroup>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
