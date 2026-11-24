import { useId, useState, type FormEvent } from 'react'
import type { PluginFormContent, PluginFormField, PluginFormValues } from '@shared/plugin-views'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { Spinner } from '@renderer/components/ui/spinner'
import { Switch } from '@renderer/components/ui/switch'
import { Glyph } from '@renderer/features/shell/glyph'
import { VIEW_ICONS } from './icons'
import { ActionButtons } from './parts'
import { busyKey, type ActionHandle } from './use-plugin-view'

function FieldRow({
  field,
  value,
  onChange,
}: {
  field: PluginFormField
  value: string | boolean | undefined
  onChange: (value: string | boolean) => void
}) {
  const id = useId()
  const label = (
    <span className="kpv-field__label">
      <b id={`${id}-label`}>{field.label}</b>
      {field.description && <small>{field.description}</small>}
    </span>
  )
  if (field.type === 'switch') {
    return (
      <div className="kpv-field" data-switch="">
        {label}
        <span className="kpv-field__control">
          <Switch
            checked={value === true}
            onCheckedChange={onChange}
            aria-labelledby={`${id}-label`}
          />
        </span>
      </div>
    )
  }
  if (field.type === 'choice') {
    return (
      <div className="kpv-field">
        {label}
        <span className="kpv-field__control" data-choice="">
          <Select
            value={String(value ?? '')}
            items={field.options}
            onValueChange={(next) => {
              if (next !== null) onChange(next)
            }}
          >
            <SelectTrigger className="w-full" aria-labelledby={`${id}-label`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectGroup>
                {field.options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </span>
      </div>
    )
  }
  return (
    <div className="kpv-field" data-block="">
      {label}
      <Input
        value={String(value ?? '')}
        maxLength={field.maxLength}
        placeholder={field.placeholder}
        aria-required={field.required || undefined}
        aria-labelledby={`${id}-label`}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}

/** Fields on a card as the settings draw them, sent by the submit button or Enter. */
export function FormBody({ view, handle }: { view: PluginFormContent; handle: ActionHandle }) {
  const [values, setValues] = useState<PluginFormValues>(() =>
    Object.fromEntries(view.fields.map((field) => [field.key, field.value])),
  )
  const incomplete = view.fields.some(
    (field) =>
      field.type === 'text' && field.required === true && String(values[field.key]).trim() === '',
  )
  const { submit } = view
  const extra = { values }
  const send = (event: FormEvent) => {
    event.preventDefault()
    if (!incomplete && !submit.disabled && handle.busy === null) handle.run(submit, extra)
  }
  return (
    <form className="kpv-form" onSubmit={send}>
      <div className="kpv-card">
        {view.fields.map((field) => (
          <FieldRow
            key={field.key}
            field={field}
            value={values[field.key]}
            onChange={(next) => setValues((current) => ({ ...current, [field.key]: next }))}
          />
        ))}
      </div>
      <div className="kpv-foot">
        <Button
          type="submit"
          size="sm"
          variant={submit.destructive ? 'destructive-outline' : 'default'}
          title={submit.description}
          disabled={incomplete || submit.disabled || handle.busy !== null}
        >
          {handle.busy === busyKey(submit, extra) ? (
            <Spinner className="size-3.5" />
          ) : (
            submit.icon && (
              <Glyph icon={VIEW_ICONS[submit.icon]} size={14} data-icon="inline-start" />
            )
          )}
          {submit.label}
        </Button>
        <ActionButtons actions={view.actions} handle={handle} extra={extra} />
      </div>
    </form>
  )
}
