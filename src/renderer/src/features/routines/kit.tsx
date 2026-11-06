// The parts the routines pages build from: Settings' cards of rows, the square switch, selects
// on the shell's menu, and the pages' notices.

import type { ReactNode } from 'react'
import { ArrowDown01Icon } from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'
import { Dropdown, Icon } from '@renderer/components/affect/app-shell'
import { css as generalCss } from '@renderer/components/affect/settings-general'
import { css as preferencesCss } from '@renderer/components/affect/settings-preferences'
import { css as securityCss } from '@renderer/components/affect/settings-security'
import './routines.css'

/** The Settings stylesheets the cards, rows, selects and switches come from. */
export function SettingsStyles() {
  return (
    <>
      <style href="ui-settings-general" precedence="default">
        {generalCss}
      </style>
      <style href="ui-settings-security" precedence="default">
        {securityCss}
      </style>
      <style href="ui-settings-preferences" precedence="default">
        {preferencesCss}
      </style>
    </>
  )
}

/** A group's title and what it is for, over its card. */
export function Head({ title, note }: { title: string; note?: string }) {
  return (
    <header className="ui-sg-head">
      <h2>{title}</h2>
      {note && <p>{note}</p>}
    </header>
  )
}

/** One row of a card: its name and what it does, its control at the end. */
export function Row({
  title,
  note,
  className,
  children,
}: {
  title: ReactNode
  note?: ReactNode
  className?: string
  children?: ReactNode
}) {
  return (
    <div className={className ? `ui-sg-row ${className}` : 'ui-sg-row'}>
      <span className="ui-sg-label">
        <b>{title}</b>
        {note && <small>{note}</small>}
      </span>
      {children}
    </div>
  )
}

/** The square switch Settings draws, blue when on. */
export function Toggle({
  on,
  label,
  disabled,
  tabIndex,
  onChange,
}: {
  on: boolean
  label: string
  disabled?: boolean
  tabIndex?: number
  onChange: (on: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      tabIndex={tabIndex}
      className="ui-ss-switch"
      onClick={(event) => {
        event.stopPropagation()
        onChange(!on)
      }}
    />
  )
}

/** A choice from a short list: Settings' select button over the shell's menu. */
export function Select<T extends string>({
  label,
  value,
  options,
  icon,
  width,
  onChange,
}: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  icon?: IconSvgElement
  width?: number
  onChange: (value: T) => void
}) {
  const picked = options.find((option) => option.value === value)
  return (
    <Dropdown
      align="end"
      items={options.map((option) => ({
        label: option.label,
        checked: option.value === value,
        onSelect: () => {
          if (option.value !== value) onChange(option.value)
        },
      }))}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          className="ui-ss-select ui-spf-lang k-select"
          style={width ? { width } : undefined}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={toggle}
        >
          {icon && <Icon icon={icon} size={14} />}
          <span>{picked?.label ?? value}</span>
          <Icon icon={ArrowDown01Icon} size={14} />
        </button>
      )}
    />
  )
}

/** A notice on a page: its mark, a title over a line, and an action at the end. */
export function Notice({
  tone,
  mark,
  title,
  children,
  action,
}: {
  tone: 'amber' | 'red'
  mark: ReactNode
  title?: string
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="k-alert" data-tone={tone} role={tone === 'red' ? 'alert' : 'status'}>
      {mark}
      <span className="k-alert__body">
        {title && <b>{title}</b>}
        {children && <small>{children}</small>}
      </span>
      {action}
    </div>
  )
}
