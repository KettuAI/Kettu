// The onboarding's stage: a soft sky over a paper snow drift, with a picture of what each step
// means. Each picture is laid out on a 720 x 776 board, scaled to fit and resting on the stage's
// foot, so it keeps its proportions in any window.

import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AppleIcon,
  ArrowUp02Icon,
  BrowserIcon,
  Folder01Icon,
  GithubIcon,
  GoogleIcon,
  LaptopIcon,
  Link01Icon,
  SecurityCheckIcon,
  SmartPhone01Icon,
  SquareLock02Icon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import type { AgentStatus } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import driftDay from '@renderer/assets/onboarding/snow-drift-day.webp'
import driftNight from '@renderer/assets/onboarding/snow-drift-night.webp'
import foxLookingUp from '@renderer/assets/onboarding/fox-looking-up.webp'
import foxWaving from '@renderer/assets/onboarding/fox-waving.webp'
import siteFox from '@renderer/assets/onboarding/site-fox.webp'
import { Icon } from '@renderer/components/affect/app-shell'
import { AgentTile } from '@renderer/components/agents/agent-mark'
import { BrandFox, BrandIcon } from '@renderer/components/brand'
import { useThisComputerName } from '@renderer/features/account/use-account'

const BOARD = { width: 720, height: 776 }
// Where a fox picture's own contact shadow meets the drift's crest, on the board.
const FOOT = 702

/** Scales its board to fit the stage, resting on the stage's foot. */
function Board({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const board = ref.current
    const stage = board?.parentElement
    if (!board || !stage) return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      board.style.setProperty(
        '--board-scale',
        String(Math.min(width / BOARD.width, height / BOARD.height)),
      )
    })
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])
  return (
    <div ref={ref} className="kob-board">
      <img className="kob-drift dark:hidden" src={driftDay} alt="" draggable={false} />
      <img className="kob-drift hidden dark:block" src={driftNight} alt="" draggable={false} />
      {children}
    </div>
  )
}

const at = (left: number, top: number, extra?: CSSProperties): CSSProperties => ({
  left,
  top,
  ...extra,
})

function Fox({
  src,
  width,
  height,
  center = 360,
}: {
  src: string
  width: number
  height: number
  center?: number
}) {
  return (
    <>
      <span className="kob-glow" style={at(center - 280, FOOT - height / 2 - 280)} />
      <img
        className="kob-fox"
        src={src}
        alt=""
        draggable={false}
        style={at(center - width / 2, FOOT - height, { width })}
      />
    </>
  )
}

function Chip({
  agent,
  left,
  top,
  turn,
}: {
  agent: AgentId
  left: number
  top: number
  turn: number
}) {
  return (
    <span className="kob-chip" style={at(left, top, { rotate: `${turn}deg` })}>
      <AgentTile agent={agent} size={30} />
    </span>
  )
}

/** Welcome: the fox waves, among the marks of the agents Kettu works with. */
export function FoxStage() {
  const { t } = useTranslation('onboarding')
  return (
    <Board>
      <Fox src={foxWaving} width={430} height={460} />
      <span className="kob-bubble" style={at(424, 176)}>
        {t('welcome.hello')}
      </span>
      <Chip agent="claude-code" left={92} top={150} turn={-8} />
      <Chip agent="codex" left={584} top={268} turn={7} />
      <Chip agent="opencode" left={66} top={392} turn={5} />
      <Chip agent="pi" left={600} top={452} turn={-6} />
    </Board>
  )
}

/** No agent yet: the fox looks up at the agents it could drive. */
export function NoAgentsStage() {
  const { t } = useTranslation('onboarding')
  return (
    <Board>
      <div className="kob-stage-cap" style={at(0, 120)}>
        <b>{t('stage.noModels')}</b>
        <span>{t('stage.noModelsHint')}</span>
      </div>
      <Chip agent="claude-code" left={430} top={300} turn={-6} />
      <Chip agent="codex" left={540} top={250} turn={6} />
      <Chip agent="opencode" left={596} top={352} turn={-4} />
      <Chip agent="pi" left={486} top={398} turn={8} />
      <Fox src={foxLookingUp} width={330} height={330} center={300} />
    </Board>
  )
}

/** A line of words drawn as a bar: the pictures show a page's shape, never words to click. */
function Line({ width, strong }: { width: number; strong?: boolean }) {
  return <span className="kob-line" data-strong={strong ? '' : undefined} style={{ width }} />
}

const MENU_LINES = [96, 74, 86, 64]

/** New session with its agent menu open on the agents found, drawn as a picture. */
export function AgentsStage({ agents }: { agents: AgentStatus[] }) {
  const shown = agents.slice(0, MENU_LINES.length)
  return (
    <Board>
      <div
        className="kob-pic kob-pic--session"
        style={at(120, 262, { width: 480, rotate: '-2deg' })}
      >
        <div className="kob-pic__greet">
          <BrandFox className="size-7" />
          <Line width={180} strong />
        </div>
        <div className="kob-pic__box">
          <Line width={230} />
          <div className="kob-pic__tray">
            <span className="kob-pic__chip">
              <Icon icon={Folder01Icon} size={13} />
              <Line width={40} />
            </span>
            {shown[0] && (
              <span className="kob-pic__chip" data-on="">
                <AgentTile agent={shown[0].id} size={15} />
                <Line width={52} />
              </span>
            )}
            <span className="grow" />
            <span className="kob-pic__send">
              <Icon icon={ArrowUp02Icon} size={13} />
            </span>
          </div>
        </div>
      </div>
      {shown.length > 0 && (
        <div className="kob-pic kob-pic--menu" style={at(244, 440, { width: 250, rotate: '3deg' })}>
          {shown.map((agent, i) => (
            <div key={agent.id} className="kob-pic__row" data-on={i === 0 ? '' : undefined}>
              <AgentTile agent={agent.id} size={18} />
              <Line width={MENU_LINES[i]} strong={i === 0} />
              {i === 0 && (
                <span className="kob-pic__tick">
                  <Icon icon={Tick02Icon} size={14} />
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </Board>
  )
}

const WAYS = [GithubIcon, GoogleIcon, AppleIcon]
const DEVICES = [
  [LaptopIcon, 116],
  [SmartPhone01Icon, 92],
  [BrowserIcon, 104],
] as const

/** The website's page the browser shows while signing in, drawn as a picture. */
export function BrowserStage({ page }: { page: 'sign-in' | 'confirm' | 'devices' }) {
  return (
    <Board>
      <div
        className="kob-pic kob-pic--browser"
        style={{ left: 160, bottom: 118, width: 400, rotate: '-3deg' }}
      >
        <div className="kob-pic__bar">
          <i />
          <i />
          <i />
          <span className="kob-pic__url">
            <Icon icon={SquareLock02Icon} size={11} />
            kettu.sh
          </span>
        </div>
        <div className="kob-pic__page">
          <img className="kob-pic__logo" src={siteFox} alt="" draggable={false} />
          <Line width={164} strong />
          <Line width={214} />
          {page === 'sign-in' && (
            <>
              <span className="kob-pic__field">
                <Line width={110} />
              </span>
              <span className="kob-pic__primary" />
              <span className="kob-pic__ways">
                {WAYS.map((icon, i) => (
                  <span key={i} className="kob-pic__way">
                    <Icon icon={icon} size={16} />
                  </span>
                ))}
              </span>
            </>
          )}
          {page === 'confirm' && (
            <>
              <span className="kob-pic__device" data-alone="">
                <span className="kob-pic__tile">
                  <Icon icon={LaptopIcon} size={16} />
                </span>
                <Line width={120} strong />
              </span>
              <span className="kob-pic__primary">
                <Icon icon={Tick02Icon} size={16} />
              </span>
            </>
          )}
          {page === 'devices' && (
            <>
              <span className="kob-pic__list">
                {DEVICES.map(([icon, width], i) => (
                  <span key={i} className="kob-pic__device">
                    <span className="kob-pic__tile">
                      <Icon icon={icon} size={15} />
                    </span>
                    <Line width={width} />
                    <span className="kob-pic__pill" />
                  </span>
                ))}
              </span>
              <span className="kob-pic__primary" />
            </>
          )}
        </div>
      </div>
    </Board>
  )
}

function Node({
  left,
  top,
  width,
  icon,
  name,
  hint,
  big,
  trail,
}: {
  left: number
  top: number
  width: number
  icon: Parameters<typeof Icon>[0]['icon']
  name: string
  hint: string
  big?: boolean
  trail?: ReactNode
}) {
  return (
    <div className="kob-node" data-big={big ? '' : undefined} style={at(left, top, { width })}>
      <span className="kob-gt" data-tint="ink" data-size="lg">
        <Icon icon={icon} size={big ? 20 : 18} />
      </span>
      <span className="grow">
        <b>{name}</b>
        <small>{hint}</small>
      </span>
      {trail}
    </div>
  )
}

/** Signed in: the phone, the web app and shared pages reach this computer through Kettu cloud. */
export function CloudDiagram({ signedIn }: { signedIn: string }) {
  const { t } = useTranslation('onboarding')
  const computer = useThisComputerName()
  return (
    <Board>
      <svg className="kob-wires" viewBox={`0 0 ${BOARD.width} ${BOARD.height}`} aria-hidden>
        <path d="M128 222 C128 290 330 282 330 340" />
        <path d="M360 222 L360 340" />
        <path d="M592 222 C592 290 390 282 390 340" />
        <path d="M360 392 L360 502" />
      </svg>
      <Node
        left={30}
        top={162}
        width={196}
        icon={SmartPhone01Icon}
        name={t('stage.phone')}
        hint={t('stage.phoneHint')}
      />
      <Node
        left={262}
        top={162}
        width={196}
        icon={BrowserIcon}
        name={t('stage.browser')}
        hint="app.kettu.sh"
      />
      <Node
        left={494}
        top={162}
        width={196}
        icon={Link01Icon}
        name={t('stage.page')}
        hint={t('stage.pageHint')}
      />
      <div className="kob-relay" style={at(242, 340, { width: 236 })}>
        <BrandIcon size={30} />
        <span>
          <b>{t('stage.cloud')}</b>
          <small>
            <i className="kob-live" />
            {t('stage.connected')}
          </small>
        </span>
      </div>
      <span className="kob-tag" style={at(374, 434)}>
        <Icon icon={SquareLock02Icon} size={12} />
        {t('stage.encrypted')}
      </span>
      <Node
        left={200}
        top={502}
        width={320}
        big
        icon={LaptopIcon}
        name={computer}
        hint={t('stage.thisComputerHint')}
        trail={<span className="kob-who">{signedIn.slice(0, 1).toUpperCase()}</span>}
      />
      <div className="kob-cap" style={at(0, 712, { width: BOARD.width })}>
        <Icon icon={SecurityCheckIcon} size={13} />
        {t('stage.caption')}
      </div>
    </Board>
  )
}
