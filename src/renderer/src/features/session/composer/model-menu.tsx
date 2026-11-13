import { FlashIcon, Settings02Icon, WorkflowSquare01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { AgentAccount, PlanLimit } from '@shared/agent-host'
import type { AgentId, ConfigOption } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { GradientFloor } from '@renderer/components/affect/gradient-floor'
import {
  ModelPicker,
  type PickerAction,
  type PickerModel,
  type PickerToggle,
} from '@renderer/components/affect/model-picker'
import { ShimmerText } from '@renderer/components/affect/shimmer-loader'
import { joinPlanTier } from '@renderer/features/account/model'
import { tightestLimit } from '@renderer/features/sidebar/plan-usage'
import { limitPhrase } from '@renderer/lib/format'
import { formatShortcut } from '@renderer/lib/platform'
import { useNow } from '@renderer/lib/use-now'
import { Glyph } from '@renderer/features/shell/glyph'
import { levelsOf, splitName, type SelectOption } from './levels'
import { mainModels, shownValue, splitModels } from './model-list'
import { modelRating } from './model-ratings'
import { isSelect } from './options'
import { useSelectPick, useSwitchPicks, type Select } from './use-pick'

const isFast = (o: ConfigOption) => /fast/i.test(o.id)
const isUltracode = (o: ConfigOption) => /ultracode/i.test(o.id)

// The gradient's stops take their colors from the tokens (see .kettu-ultra-floor in affect.css).
const ULTRA_STOPS: [string, string, string] = ['currentColor', 'currentColor', 'currentColor']

/**
 * The model, its effort and the agent's switches on affectUI's Model Picker: the current models
 * with their bars and number keys, More models in a card beside it, effort as one track, and
 * the switches with Fast mode as a flag and Ultracode in its own colors.
 */
export function ModelMenu({
  agentId,
  hostId,
  agentName,
  config,
  running = false,
  onSelect,
  open,
  onOpenChange,
  outOfCredit = false,
  account,
  limits,
  source,
  actions,
}: {
  agentId: AgentId
  /** The host the agent is on, null for this computer. */
  hostId: string | null
  agentName: string
  config: readonly ConfigOption[]
  running?: boolean
  onSelect: Select
  open?: boolean
  onOpenChange?: (open: boolean) => void
  outOfCredit?: boolean
  account: AgentAccount | null
  limits: readonly PlanLimit[]
  /** The harness and version the models come from. */
  source: string | null
  /** Rows after the switches, such as Switch agent. */
  actions?: PickerAction[]
}) {
  const { t } = useTranslation('composer')
  const now = useNow()
  const model = config.find((o): o is SelectOption => o.category === 'model' && isSelect(o))
  const effort = config.find(
    (o): o is SelectOption => o.category === 'thought_level' && isSelect(o),
  )
  const switches = config.filter((o) => o.type === 'boolean')
  const [modelValue, pickModel] = useSelectPick(model, onSelect)
  const [effortValue, pickEffort] = useSelectPick(effort, onSelect)
  const flips = useSwitchPicks(onSelect)

  const choices = model?.choices ?? []
  const checked = shownValue(choices, modelValue)
  const mark = <AgentMark agent={agentId} hostId={hostId} size={16} />
  const row = (choice: SelectOption['choices'][number], older?: boolean): PickerModel => {
    const rating = modelRating(choice, older)
    return {
      id: choice.value,
      name: splitName(choice.name)[1],
      ...(choice.description ? { description: choice.description } : {}),
      icon: mark,
      ...(rating ?? {}),
    }
  }
  const models = mainModels(choices, modelValue).map((c) => row(c))
  const more = splitModels(choices).older.map((c) => row(c, true))

  const levels = effort ? levelsOf(effort, effortValue, modelValue) : null
  const efforts = levels?.levels.map((c) => ({ id: c.value, label: c.name })) ?? []

  const toggles: PickerToggle[] = switches.map((o) => {
    const disabled = !!o.idleOnly && running
    const ultra = isUltracode(o)
    const hint = disabled
      ? t('controls.changesBetweenTurns')
      : o.value === 'default'
        ? t(
            o.defaultValue === true
              ? 'controls.followsAgentOn'
              : o.defaultValue === false
                ? 'controls.followsAgentOff'
                : 'controls.followsAgent',
          )
        : (o.description ?? o.name)
    return {
      id: o.id,
      label: o.name,
      icon: <Glyph icon={isFast(o) ? FlashIcon : ultra ? WorkflowSquare01Icon : Settings02Icon} />,
      hint,
      on: flips.valueOf(o),
      disabled,
      flag: isFast(o),
      indicator: !isFast(o) && !!o.indicator,
      ...(ultra
        ? {
            onLabel: (
              <ShimmerText className="kettu-ultra-text" duration={2.4}>
                {o.name}
              </ShimmerText>
            ),
            effect: <GradientFloor className="kettu-ultra-floor" colors={ULTRA_STOPS} speed={4} />,
          }
        : {}),
    }
  })

  const limit = tightestLimit(limits, now)
  const plan = account?.label ? joinPlanTier(account.label, account.tier) : null
  const note = [
    account?.email,
    plan,
    limit?.usedPercent != null &&
      t('controls.limitUsed', {
        percent: Math.round(limit.usedPercent),
        limit: limitPhrase(limit),
      }),
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    // The composer focuses its field on a press anywhere else in it, which would close the menu
    // before a model row's click lands.
    <div data-composer-own className="contents">
      <ModelPicker
        className="kettu-model-picker"
        side="top"
        align="end"
        heading={agentName}
        models={models}
        more={more}
        keys
        value={checked}
        onChange={pickModel}
        efforts={efforts}
        effort={levels?.shown ?? effortValue ?? ''}
        onEffortChange={pickEffort}
        effortLabel={effort?.name ?? t('controls.effort')}
        effortHint={t('controls.effortHint', { shortcut: formatShortcut('Alt+E') })}
        toggles={toggles}
        {...(actions ? { actions } : {})}
        onToggle={(id, on) => {
          const option = switches.find((o) => o.id === id)
          if (option) flips.pick(option, on)
        }}
        note={note || undefined}
        moreNote={source ? t('controls.modelsFrom', { source }) : undefined}
        open={open}
        onOpenChange={onOpenChange}
        triggerLead={outOfCredit ? <span aria-hidden className="kettu-model-warn" /> : undefined}
        triggerLabel={outOfCredit ? t('controls.modelOutOfCredit') : undefined}
        labels={{
          model: t('controls.model'),
          settings: t('controls.modelSettings'),
          speed: t('controls.speed'),
          quality: t('controls.quality'),
          cost: t('controls.cost'),
          varies: t('controls.varies'),
          moreModels: t('controls.moreModels'),
          searchModels: t('controls.searchModels'),
          noModels: t('controls.noModels'),
          noMatch: t('controls.noModelMatch'),
          choose: model ? t('controls.chooseModel') : t('controls.options'),
        }}
      />
    </div>
  )
}
