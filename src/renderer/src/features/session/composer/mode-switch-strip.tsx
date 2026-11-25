import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import type { PendingConfig } from '@shared/thread'
import { Button } from '@renderer/components/ui/button'
import { fadeExit } from '@renderer/lib/motion'
import { Glyph } from '@renderer/features/shell/glyph'
import { MODE_GLYPH, modeLook } from './modes'

/**
 * 输入框顶部的权限模式待切换提示条：说明需要等待当前回合或后台任务结束后才会切换，或正在重启切换中，并提供取消入口。
 */
export function ModeSwitchStrip({
  pending,
  modeName,
  onCancel,
}: {
  pending: PendingConfig
  /** 目标权限模式的展示名称。 */
  modeName: string
  /** 取消挂起切换的回调；正在重启切换时不展示按钮。 */
  onCancel?: () => void
}) {
  const { t } = useTranslation('composer')
  const look = modeLook(pending.value)
  const message =
    pending.wait === 'restarting'
      ? t('controls.modeSwitching', { mode: modeName })
      : pending.wait === 'background'
        ? t('controls.modePendingBackground', { mode: modeName })
        : t('controls.modePendingTurn', { mode: modeName })

  return (
    <motion.div
      exit={fadeExit}
      role="status"
      aria-live="polite"
      className="kettu-switch flex w-full animate-in flex-wrap items-center gap-x-2.5 gap-y-1.5 fade-in animation-duration-(--duration-fast)"
    >
      <Glyph
        icon={MODE_GLYPH[look]}
        className={
          look === 'full' ? 'size-4 shrink-0 text-danger' : 'size-4 shrink-0 text-tertiary'
        }
      />
      <p className="min-w-0 flex-[1_1_14rem] text-primary">{message}</p>
      {pending.wait !== 'restarting' && onCancel && (
        <div className="ml-auto flex shrink-0 items-center">
          <Button size="xs" variant="outline" onClick={onCancel}>
            {t('controls.cancelModeSwitch')}
          </Button>
        </div>
      )}
    </motion.div>
  )
}
