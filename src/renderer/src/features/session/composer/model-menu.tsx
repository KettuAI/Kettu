import { useMemo, useState } from 'react'
import {
  ArrowDataTransferHorizontalIcon,
  FlashIcon,
  PinIcon,
  Settings02Icon,
  WorkflowSquare01Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { MAX_PINNED_MODELS } from '@shared/agent-host'
import type { AgentId, ConfigOption } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { GradientFloor } from '@renderer/components/affect/gradient-floor'
import {
  ModelPicker,
  type PickerModel,
  type PickerToggle,
} from '@renderer/components/affect/model-picker'
import { ShimmerText } from '@renderer/components/affect/shimmer-loader'
import { toast } from '@renderer/components/ui/toast'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { Glyph } from '@renderer/features/shell/glyph'
import { usePhoneWindow } from '@renderer/features/shell/narrow'
import { errorMessage, hostAt } from '@renderer/lib/host'
import { formatShortcut } from '@renderer/lib/platform'
import { optionsOn, useAgentOptionsStore } from '@renderer/stores/agent-options'
import { useSettingsStore } from '@renderer/stores/settings'
import { EffortDial } from './effort-dial'
import { dialStops, type SelectOption } from './levels'
import { defaultUses, matchesModel, modelLists, moreInOrder, type ModelRead } from './model-list'
import { ModelMark } from './model-mark'
import { isSelect } from './options'
import { SwitchRows } from './switch-rows'
import { isFast, isUltracode, lockedNow } from './switch-options'
import { useSelectPick, useSwitchPicks, type Select } from './use-pick'

// The gradient's stops take their colors from the tokens (see .kettu-ultra-floor in affect.css).
const ULTRA_STOPS: [string, string, string] = ['currentColor', 'currentColor', 'currentColor']

/**
 * The model, its effort and the agent's switches on affectUI's Model Picker: the main models with
 * number keys and a pin on each row, More models in a card beside it by provider and family, effort
 * on a dial or as segments, as Appearance sets, and the switches as rows, with Fast mode as a flag
 * and Ultracode in its own colors.
 */
export function ModelMenu({
  agentId,
  hostId,
  agentName,
  harness,
  config,
  running = false,
  onSelect,
  open,
  onOpenChange,
  outOfCredit = false,
  source,
  onSwitchAgent,
  canSwitchAgent = true,
}: {
  agentId: AgentId
  /** The host the agent is on, null for this computer. */
  hostId: string | null
  agentName: string
  /** The harness a switch that follows the agent's setting follows, such as Claude Code. */
  harness: string
  config: readonly ConfigOption[]
  running?: boolean
  onSelect: Select
  open?: boolean
  onOpenChange?: (open: boolean) => void
  outOfCredit?: boolean
  /** The harness and version the models come from. */
  source: string | null
  /** Opens the agent menu in this one's place; without it the head has no Switch agent. */
  onSwitchAgent?: () => void
  /** Whether the agent can be switched now, which is only between turns. */
  canSwitchAgent?: boolean
}) {
  // A phone has no number keys to pick a model with.
  const phone = usePhoneWindow()
  const { t } = useTranslation('composer')
  const kept = useAgentOptionsStore((s) => optionsOn(s, hostId)[agentId])
  const pinned = kept?.pinned
  const recent = kept?.recent
  const model = config.find((o): o is SelectOption => o.category === 'model' && isSelect(o))
  const effort = config.find(
    (o): o is SelectOption => o.category === 'thought_level' && isSelect(o),
  )
  const switches = config.filter((o) => o.type === 'boolean')
  const [modelValue, pickModel] = useSelectPick(model, onSelect)
  const [effortValue, pickEffort] = useSelectPick(effort, onSelect)
  const flips = useSwitchPicks(onSelect)
  const effortControl = useSettingsStore((s) => s.settings.appearance.effortControl)
  const choices = model?.choices
  const lists = useMemo(
    () => modelLists(choices ?? [], modelValue, { pinned, recent }),
    [choices, modelValue, pinned, recent],
  )

  const [innerOpen, setInnerOpen] = useState(false)
  const isOpen = open ?? innerOpen
  // While the dial turns, the trigger follows the level at its mark.
  const [preview, setPreview] = useState<string | null>(null)
  const changeOpen = (next: boolean) => {
    setInnerOpen(next)
    onOpenChange?.(next)
  }

  const pinnedNow = new Set(pinned ?? [])
  const pinsFull = pinnedNow.size >= MAX_PINNED_MODELS
  const pin = (read: ModelRead) => {
    const next = !pinnedNow.has(read.value)
    if (next && pinsFull) {
      toast(t('controls.pinsFull', { count: MAX_PINNED_MODELS }), undefined, { tone: 'warning' })
      return
    }
    hostAt(hostId, 'agents.pinModel', { agentId, model: read.value, pinned: next }).catch(
      (error: unknown) => toast(errorMessage(error), undefined, { tone: 'warning' }),
    )
  }
  const pinButton = (read: ModelRead) => {
    const on = pinnedNow.has(read.value)
    return (
      <button
        type="button"
        className="kettu-model-pin"
        // The list moves with the arrow keys and picks with Enter; the pin is the pointer's.
        tabIndex={-1}
        aria-pressed={on}
        aria-label={t(on ? 'controls.unpin' : 'controls.pin', { model: read.name })}
        data-on={on ? '' : undefined}
        onClick={(event) => {
          event.stopPropagation()
          pin(read)
        }}
      >
        <Glyph icon={PinIcon} size={13} />
      </button>
    )
  }
  const tag = (read: ModelRead) =>
    read.value === lists.defaultValue ? (
      <span className="kettu-model-tag">{t('controls.defaultTag')}</span>
    ) : undefined
  const row = (read: ModelRead): PickerModel => {
    const uses = read.isDefault ? defaultUses(read, lists.all) : null
    const description = uses
      ? t('controls.defaultUses', { model: uses })
      : [lists.several && read.provider, read.choice.description].filter(Boolean).join(' · ')
    return {
      id: read.value,
      name: read.name,
      ...(description ? { description } : {}),
      icon: <ModelMark read={read} agentId={agentId} />,
      badge: tag(read),
      end: pinButton(read),
    }
  }
  const models = (lists.extra ? [...lists.main, lists.extra] : lists.main).map(row)
  const more = moreInOrder(lists.more).map((read): PickerModel => ({
    id: read.value,
    name: read.name,
    icon: <ModelMark read={read} agentId={agentId} />,
    badge: tag(read),
    end: pinButton(read),
    ...(lists.several && read.provider ? { group: read.provider } : {}),
  }))
  const byValue = new Map(lists.all.map((read) => [read.value, read]))

  const dial = effort ? dialStops(effort, effortValue) : null
  // The trigger shows the level, and none for the agent's Default.
  const efforts =
    dial?.stops.map((s) => ({
      id: s.value,
      label: s.name,
      ...(s.isDefault ? { trigger: false as const } : {}),
    })) ?? []

  const toggles: PickerToggle[] = switches.map((o) => {
    const ultra = isUltracode(o)
    return {
      id: o.id,
      label: o.name,
      icon: <Glyph icon={isFast(o) ? FlashIcon : ultra ? WorkflowSquare01Icon : Settings02Icon} />,
      on: flips.valueOf(o),
      disabled: lockedNow(o, running),
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

  const switchButton = onSwitchAgent && (
    <button
      type="button"
      className="kettu-model-switch"
      aria-disabled={!canSwitchAgent || undefined}
      onClick={() => {
        if (!canSwitchAgent) return
        changeOpen(false)
        onSwitchAgent()
      }}
    >
      <Glyph icon={ArrowDataTransferHorizontalIcon} size={13} />
      {t('switchAgent.menu')}
    </button>
  )
  const switchAgent =
    switchButton && !canSwitchAgent ? (
      <Tooltip>
        <TooltipTrigger render={switchButton} />
        <TooltipContent>{t('switchAgent.betweenTurns')}</TooltipContent>
      </Tooltip>
    ) : (
      switchButton
    )

  return (
    // The composer focuses its field on a press anywhere else in it, which would close the menu
    // before a model row's click lands.
    <div data-composer-own className="contents">
      <ModelPicker
        className="kettu-model-picker"
        side="top"
        align="end"
        heading={agentName}
        headingEnd={switchAgent}
        models={models}
        more={more}
        moreFilter={(m, query) => {
          const read = byValue.get(m.id)
          return read ? matchesModel(read, query) : m.name.toLowerCase().includes(query)
        }}
        keys={!phone}
        value={lists.chosen?.value}
        onChange={pickModel}
        efforts={efforts}
        effort={preview ?? dial?.shown ?? ''}
        onEffortChange={pickEffort}
        effortLabel={effort?.name || t('controls.effort')}
        effortHint={t('controls.effortHint', { shortcut: formatShortcut('Alt+E') })}
        effortSlot={
          // On segments, the picker draws the levels as a track of its own.
          effort && dial && effortControl === 'dial' ? (
            <EffortDial
              className="kettu-model-picker__dial"
              label={effort.name || t('controls.effort')}
              stops={dial.stops}
              value={dial.shown}
              onChange={pickEffort}
              onPreview={setPreview}
            />
          ) : undefined
        }
        toggles={toggles}
        toggleSlot={
          <SwitchRows
            className="kettu-model-picker__switches"
            options={switches}
            agent={harness}
            running={running}
            valueOf={flips.valueOf}
            onFlip={flips.pick}
          />
        }
        foot={false}
        moreNote={source ? t('controls.modelsFrom', { source }) : undefined}
        open={isOpen}
        onOpenChange={changeOpen}
        triggerIcon={<AgentMark agent={agentId} hostId={hostId} size={16} />}
        triggerLead={outOfCredit ? <span aria-hidden className="kettu-model-warn" /> : undefined}
        triggerLabel={outOfCredit ? t('controls.modelOutOfCredit') : undefined}
        labels={{
          model: t('controls.model'),
          settings: t('controls.modelSettings'),
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
