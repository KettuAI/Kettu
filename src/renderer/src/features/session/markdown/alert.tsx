import type { ComponentProps } from 'react'
import {
  AlertDiamondIcon,
  AlertSquareIcon,
  Alert02Icon,
  Idea01Icon,
  InformationCircleIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { defaultComponents, type ExtraProps } from 'streamdown'
import { alertKind, type AlertKind } from './github-alerts'

const DefaultBlockquote = defaultComponents.blockquote

const ICONS = {
  note: InformationCircleIcon,
  tip: Idea01Icon,
  important: AlertSquareIcon,
  warning: Alert02Icon,
  caution: AlertDiamondIcon,
} satisfies Record<AlertKind, unknown>

/** A quote, or a GitHub alert (github-alerts.ts) drawn with its icon and title. */
export function Blockquote(props: ComponentProps<'blockquote'> & ExtraProps) {
  const { t } = useTranslation('session')
  const kind = alertKind((props as Record<string, unknown>)['data-alert'])
  if (!kind) return <DefaultBlockquote {...props} />
  return (
    <div data-alert={kind} role="note">
      <div data-alert-title="">
        <HugeiconsIcon icon={ICONS[kind]} strokeWidth={1.9} aria-hidden />
        {t(`alert.${kind}`)}
      </div>
      {props.children}
    </div>
  )
}
