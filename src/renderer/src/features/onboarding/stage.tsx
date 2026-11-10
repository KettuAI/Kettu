// The onboarding's stage: a soft sky over a paper snow drift, with a picture of what each step
// means. Each picture is laid out on a 720 x 776 board, scaled to fit and resting on the stage's
// foot, so it keeps its proportions in any window.

import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AppleIcon,
  ArrowDown01Icon,
  ArrowUp02Icon,
  BrowserIcon,
  Folder01Icon,
  GithubIcon,
  GoogleIcon,
  LaptopIcon,
  Link01Icon,
  SecurityCheckIcon,
  Settings02Icon,
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
import { agentLine } from '@renderer/features/session/new-session/picker'

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

/** New session as it will open, with the agent menu showing the agents found. */
export function AgentsStage({ agents }: { agents: AgentStatus[] }) {
  const { t } = useTranslation('onboarding')
  const first = agents[0]
  return (
    <Board>
      <div className="kob-mock" style={at(70, 150, { width: 580 })}>
        <div className="kob-mock__greet">
          <BrandFox className="size-[1.15em]" />
          <span>{t('stage.greeting')}</span>
        </div>
        <div className="kob-mock__composer">
          <div className="kob-mock__input">{t('stage.placeholder')}</div>
          <div className="kob-mock__tray">
            <span className="kob-mock__chip">
              <Icon icon={Folder01Icon} size={14} />
              {t('stage.noProject')}
            </span>
            {first && (
              <span className="kob-mock__chip" data-on="">
                <AgentTile agent={first.id} size={16} />
                {first.name}
                <Icon icon={ArrowDown01Icon} size={12} />
              </span>
            )}
            <span className="grow" />
            <span className="kob-mock__send">
              <Icon icon={ArrowUp02Icon} size={14} />
            </span>
          </div>
        </div>
      </div>
      {agents.length > 0 && (
        <div className="kob-menu" style={at(165, 336, { width: 330 })}>
          {agents.slice(0, 4).map((agent, i) => (
            <div key={agent.id} className="kob-menu__row" data-on={i === 0 ? '' : undefined}>
              <AgentTile agent={agent.id} size={18} />
              <span className="grow">
                <span>{agent.name}</span>
                <small>{agentLine(agent)?.text}</small>
              </span>
              {i === 0 && <Icon icon={Tick02Icon} size={14} />}
            </div>
          ))}
          <div className="kob-menu__sep" />
          <div className="kob-menu__row">
            <Icon icon={Settings02Icon} size={15} />
            <span className="grow">{t('stage.manageAgents')}</span>
          </div>
        </div>
      )}
    </Board>
  )
}

/** The website's page the browser shows while signing in. */
export function BrowserStage({ page }: { page: 'sign-in' | 'confirm' | 'devices' }) {
  const { t } = useTranslation('onboarding')
  const computer = useThisComputerName()
  const url = {
    'sign-in': 'www.kettu.sh/signin',
    confirm: 'www.kettu.sh/signin/confirm',
    devices: 'www.kettu.sh/signin/devices',
  }[page]
  return (
    <Board>
      <div className="kob-browser" style={at(100, 104, { width: 520 })}>
        <div className="kob-browser__bar">
          <span className="kob-browser__dots">
            <i />
            <i />
            <i />
          </span>
          <span className="kob-browser__url">
            <Icon icon={SquareLock02Icon} size={11} />
            {url}
          </span>
        </div>
        <div className="kob-site">
          <img className="kob-site__logo" src={siteFox} alt="" draggable={false} />
          {page === 'sign-in' && (
            <>
              <h3>{t('stage.site.signIn')}</h3>
              <p>{t('stage.site.signInHint', { computer })}</p>
              <div className="kob-site__form">
                <span className="kob-site__field">{t('stage.site.email')}</span>
                <span className="kob-site__btn" data-primary="">
                  {t('stage.site.withEmail')}
                </span>
                <span className="kob-site__or">{t('stage.site.or')}</span>
                <span className="kob-site__btn">
                  <Icon icon={GithubIcon} size={14} />
                  {t('stage.site.github')}
                </span>
                <span className="kob-site__btn">
                  <Icon icon={GoogleIcon} size={14} />
                  {t('stage.site.google')}
                </span>
                <span className="kob-site__btn">
                  <Icon icon={AppleIcon} size={14} />
                  {t('stage.site.apple')}
                </span>
              </div>
              <small>{t('stage.site.noPassword')}</small>
            </>
          )}
          {page === 'confirm' && (
            <>
              <h3>{t('stage.site.confirm', { computer })}</h3>
              <p>{t('stage.site.confirmHint')}</p>
              <div className="kob-site__form">
                <div className="kob-site__card">
                  <div className="kob-site__dev">
                    <span className="kob-site__tile">
                      <Icon icon={LaptopIcon} size={16} />
                    </span>
                    <span>
                      <b>{computer}</b>
                    </span>
                  </div>
                </div>
                <span className="kob-site__btn" data-primary="">
                  {t('stage.site.confirmButton')}
                </span>
                <span className="kob-site__btn" data-quiet="">
                  {t('stage.site.notMe')}
                </span>
              </div>
              <small>{t('stage.site.never')}</small>
            </>
          )}
          {page === 'devices' && (
            <>
              <h3>{t('stage.site.full')}</h3>
              <p>{t('stage.site.fullHint', { computer })}</p>
              <div className="kob-site__form" data-wide="">
                <div className="kob-site__card">
                  {[LaptopIcon, SmartPhone01Icon, BrowserIcon].map((icon, i) => (
                    <div key={i} className="kob-site__dev">
                      <span className="kob-site__tile">
                        <Icon icon={icon} size={16} />
                      </span>
                      <span className="kob-site__skel" />
                      <span className="kob-site__btn" data-small="">
                        {t('stage.site.signOut')}
                      </span>
                    </div>
                  ))}
                </div>
                <span className="kob-site__btn" data-primary="">
                  {t('stage.site.seePro')}
                </span>
              </div>
              <small>{t('stage.site.plans')}</small>
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
