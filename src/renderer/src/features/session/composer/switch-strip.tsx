import { ArrowDataTransferHorizontalIcon } from '@hugeicons/core-free-icons'
import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import type { ConfigOption } from '@shared/thread'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { fadeExit } from '@renderer/lib/motion'
import { Glyph } from '@renderer/features/shell/glyph'
import { splitName, type SelectOption } from './levels'
import { shownChoice } from './model-list'
import { isSelect } from './options'

function shown(config: readonly ConfigOption[], category: ConfigOption['category']): string | null {
  const option = config.find((o): o is SelectOption => o.category === category && isSelect(o))
  if (!option) return null
  const choice = shownChoice(option.choices, String(option.value))
  return choice ? splitName(choice.name)[1] : String(option.value)
}

/**
 * The note at the top of the composer's box while another agent is picked to take the session
 * over: it does so with the next message, which carries the earlier conversation to it.
 */
export function SwitchStrip({
  agentName,
  config,
  summarize,
  onSummarize,
  onUndo,
}: {
  agentName: string
  /** The options it will start with, as the menu shows them. */
  config: readonly ConfigOption[]
  summarize: boolean
  onSummarize: (on: boolean) => void
  /** Absent where the session cannot go on with its own agent. */
  onUndo?: () => void
}) {
  const { t } = useTranslation('composer')
  const model = shown(config, 'model')
  const mode = shown(config, 'mode')
  const settings = [model, mode].filter(Boolean).join(' · ')
  return (
    <motion.div
      exit={fadeExit}
      className="kettu-switch flex w-full animate-in flex-wrap items-center gap-x-2.5 gap-y-1.5 fade-in animation-duration-(--duration-fast)"
    >
      <Glyph icon={ArrowDataTransferHorizontalIcon} className="size-4 shrink-0 text-tertiary" />
      <div className="min-w-0 flex-[1_1_14rem] text-primary">
        <p>{t('switchAgent.strip', { agent: agentName })}</p>
        {settings && <p className="text-xs text-tertiary">{settings}</p>}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2.5">
        <Tooltip>
          <TooltipTrigger
            render={<label className="flex items-center gap-1.5 text-xs text-secondary" />}
          >
            <Switch size="sm" checked={summarize} onCheckedChange={onSummarize} />
            {t('switchAgent.summarize')}
          </TooltipTrigger>
          <TooltipContent>{t('switchAgent.summarizeHint', { agent: agentName })}</TooltipContent>
        </Tooltip>
        {onUndo && (
          <Button size="xs" variant="outline" onClick={onUndo}>
            {t('switchAgent.undo')}
          </Button>
        )}
      </div>
    </motion.div>
  )
}
