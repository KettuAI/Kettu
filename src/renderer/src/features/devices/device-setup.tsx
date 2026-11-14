import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { DeviceEnvironment, DeviceInfo, DeviceProblem } from '@shared/device-host'
import {
  SetupGuide,
  type SetupGroup,
  type SetupTask,
} from '@renderer/components/affect/setup-guide'

/** The checks the host makes today, of the computer and of a device. */
type Check = Extract<
  DeviceProblem,
  | 'xcode-missing'
  | 'android-sdk-missing'
  | 'usb-required'
  | 'not-paired'
  | 'developer-mode-off'
  | 'ddi-not-mounted'
  | 'offline'
  | 'usb-debugging-unauthorized'
>

/** Where the vendor explains a step that is done outside Kettu. */
const LINKS = {
  'xcode-missing': 'https://apps.apple.com/app/xcode/id497799835',
  'android-sdk-missing': 'https://developer.android.com/studio',
  'developer-mode-off':
    'https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device',
  'usb-debugging-unauthorized': 'https://developer.android.com/studio/debug/dev-options',
} as const satisfies Partial<Record<Check, string>>

/** The checks the host makes of each kind of device, in the order they are done. */
const DEVICE_CHECKS: Record<DeviceInfo['platform'], Check[]> = {
  ios: ['usb-required', 'not-paired', 'developer-mode-off', 'ddi-not-mounted'],
  android: ['offline', 'usb-debugging-unauthorized'],
}

function task(t: TFunction<'devices'>, check: Check, open: DeviceProblem[]): SetupTask {
  const done = !open.includes(check)
  return {
    id: check,
    label: t(`setup.check.${check}.label`),
    detail: t(`setup.check.${check}.${done ? 'done' : 'todo'}`),
    done,
    ...(check in LINKS && !done
      ? {
          link: {
            label: t(`setup.check.${check as keyof typeof LINKS}.link`),
            href: LINKS[check as keyof typeof LINKS],
          },
        }
      : {}),
  }
}

/** The computer's own part: the tools each system's devices need. */
function hostGroup(t: TFunction<'devices'>, environment: DeviceEnvironment): SetupGroup {
  const checks: Check[] =
    environment.platform === 'darwin'
      ? ['xcode-missing', 'android-sdk-missing']
      : ['android-sdk-missing']
  return {
    id: 'host',
    title: t(environment.platform === 'darwin' ? 'setup.thisMac' : 'setup.thisComputer'),
    tasks: checks.map((check) => task(t, check, environment.problems)),
  }
}

function Guide({
  title,
  description,
  groups,
}: {
  title: string
  description: string
  groups: SetupGroup[]
}) {
  const { t } = useTranslation('devices')
  // A group that finishes folds and the next one opens, which the guide does as it mounts.
  const unfinished = groups
    .filter((group) => group.tasks.some((entry) => !entry.done))
    .map((group) => group.id)
    .join(' ')
  return (
    <SetupGuide
      key={unfinished}
      className="kp-device-setup"
      title={title}
      description={description}
      groups={groups}
      readOnly
      labels={{ minimize: t('setup.minimize'), expand: t('setup.expand') }}
    />
  )
}

/** What a device still needs before it can be shown, with what is done already checked off. */
export function DeviceSetup({
  device,
  environment,
}: {
  device: DeviceInfo
  environment: DeviceEnvironment | null
}) {
  const { t } = useTranslation('devices')
  const own: SetupGroup = {
    id: 'device',
    title: device.name,
    tasks: DEVICE_CHECKS[device.platform].map((check) => task(t, check, device.problems)),
  }
  const mine = environment ? hostGroup(t, environment) : null
  // Only the tool this device's system needs counts for it.
  const needed = device.platform === 'ios' ? 'xcode-missing' : 'android-sdk-missing'
  const hostTasks = mine?.tasks.filter((entry) => entry.id === needed) ?? []
  return (
    <Guide
      title={t('setup.deviceTitle', { name: device.name })}
      description={t('setup.deviceDescription')}
      groups={[...(mine && hostTasks.length > 0 ? [{ ...mine, tasks: hostTasks }] : []), own]}
    />
  )
}

/** What this computer needs before it can run any device. */
export function HostSetup({ environment }: { environment: DeviceEnvironment }) {
  const { t } = useTranslation('devices')
  return (
    <Guide
      title={t(
        environment.platform === 'darwin' ? 'setup.hostTitleMac' : 'setup.hostTitleComputer',
      )}
      description={t('setup.hostDescription')}
      groups={[hostGroup(t, environment)]}
    />
  )
}
