import { describe, expect, it } from 'vitest'
import { limitsForModel } from '@shared/plan-limits'
import type { ConfigOption } from '@shared/thread'
import {
  antigravitySignInMethod,
  antigravityTier,
  namesProxy,
  parseAntigravityUsage,
  systemProxyEnv,
} from './antigravity'

const NOW = Date.UTC(2026, 10, 16, 18, 0)

// agy_acp_server 1.5.0's answer to `/usage`, signed in with Google AI Pro.
const USAGE = `### Session Usage
- **Session total:** data not available yet

### Quota Limits
- **Gemini Models**
  *(Models within this group: Gemini 3.8 Flash)*
  - **Weekly Limit Remaining:** 99% remaining (resets Nov 23, 2026, 17:37 UTC)
  - **Five Hour Limit Remaining:** 99% remaining (resets Nov 16, 2026, 22:37 UTC)
- **Claude and GPT models**
  *(Models within this group: Claude Sonnet 4.6, Claude Opus 4.6, GPT-OSS 120B)*
  - **Weekly Limit Remaining:** 100% remaining (resets Nov 23, 2026, 17:41 UTC)
  - **Five Hour Limit Remaining:** 0% remaining (resets Nov 16, 2026, 22:41 UTC)
`

describe('Google Antigravity plan', () => {
  it('reads the plan named in an answer', () => {
    expect(
      antigravityTier({
        antigravity: {
          tier: { name: 'Google AI Pro', id: 'g1-pro-tier', upgradeUri: '' },
        },
      }),
    ).toBe('Google AI Pro')
  })

  it('gives null when the answer names no plan', () => {
    expect(antigravityTier(undefined)).toBeNull()
    expect(antigravityTier({ antigravity: { tier: { name: '', id: '' } } })).toBeNull()
    expect(antigravityTier({ antigravity: { enabledTools: ['run_command'] } })).toBeNull()
  })

  it('reads only the sign-in method from agy’s auth state', () => {
    expect(antigravitySignInMethod('{"methodId":"oauth-personal"}')).toBe('oauth-personal')
    expect(antigravitySignInMethod('{"methodId":"gemini-api-key","token":"x"}')).toBe(
      'gemini-api-key',
    )
    expect(antigravitySignInMethod('{"methodId":"Not a method"}')).toBeNull()
    expect(antigravitySignInMethod('not json')).toBeNull()
    expect(antigravitySignInMethod('')).toBeNull()
  })
})

describe('Google Antigravity plan limits', () => {
  it('reads both windows of each model group', () => {
    const usage = parseAntigravityUsage(USAGE, NOW)
    expect(usage?.limits).toEqual([
      {
        window: 'seven_day_gemini_models',
        label: 'Weekly · Gemini Models',
        usedPercent: 1,
        resetsAt: Date.UTC(2026, 10, 23, 17, 37),
        state: 'ok',
        observedAt: NOW,
        models: ['Gemini 3.8 Flash'],
      },
      {
        window: 'five_hour_gemini_models',
        label: '5-hour · Gemini Models',
        usedPercent: 1,
        resetsAt: Date.UTC(2026, 10, 16, 22, 37),
        state: 'ok',
        observedAt: NOW,
        models: ['Gemini 3.8 Flash'],
      },
      {
        window: 'seven_day_claude_and_gpt_models',
        label: 'Weekly · Claude and GPT models',
        usedPercent: 0,
        resetsAt: Date.UTC(2026, 10, 23, 17, 41),
        state: 'ok',
        observedAt: NOW,
        models: ['Claude Sonnet 4.6', 'Claude Opus 4.6', 'GPT-OSS 120B'],
      },
      {
        window: 'five_hour_claude_and_gpt_models',
        label: '5-hour · Claude and GPT models',
        usedPercent: 100,
        resetsAt: Date.UTC(2026, 10, 16, 22, 41),
        state: 'reached',
        observedAt: NOW,
        models: ['Claude Sonnet 4.6', 'Claude Opus 4.6', 'GPT-OSS 120B'],
      },
    ])
  })

  it('reads no limits as none, and a failed or other reply as nothing', () => {
    expect(parseAntigravityUsage('### Quota Limits\n- No quota limits reported.\n', NOW)).toEqual({
      limits: [],
      balances: [],
    })
    expect(
      parseAntigravityUsage('### Quota Limits\n- Unable to retrieve quota status (timeout)\n', NOW),
    ).toBeNull()
    expect(
      parseAntigravityUsage(
        '### Quota Limits\n- Not applicable for current authentication method.\n',
        NOW,
      ),
    ).toBeNull()
    expect(parseAntigravityUsage('Here is a summary of your usage.', NOW)).toBeNull()
  })

  it('counts a session only against its own model’s group', () => {
    const limits = parseAntigravityUsage(USAGE, NOW)!.limits
    const model = (value: string): ConfigOption => ({
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      value,
      choices: [
        { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
        { value: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
        { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
        { value: 'gemini-4-preview', name: 'Gemini 4 Preview' },
      ],
    })
    const windows = (value: string) => limitsForModel(limits, model(value)).map((l) => l.window)
    expect(windows('gemini-3.8-flash')).toEqual([
      'seven_day_gemini_models',
      'five_hour_gemini_models',
    ])
    expect(windows('claude-sonnet-4-6')).toEqual([
      'seven_day_claude_and_gpt_models',
      'five_hour_claude_and_gpt_models',
    ])
    expect(windows('gpt-oss-120b-medium')).toHaveLength(2)
    // A model no group lists is held back by every window.
    expect(windows('gemini-4-preview')).toHaveLength(4)
  })
})

describe('the usage server’s proxy', () => {
  const SCUTIL = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
  }
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 7897
  SOCKSProxy : 127.0.0.1
}`

  it('passes the system HTTP(S) proxy, never the SOCKS one', () => {
    expect(systemProxyEnv(SCUTIL)).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:7897',
      http_proxy: 'http://127.0.0.1:7897',
      HTTPS_PROXY: 'http://127.0.0.1:7897',
      https_proxy: 'http://127.0.0.1:7897',
    })
    const socksOnly = SCUTIL.replace(/HTTPS?Enable : 1/g, (line) => line.replace('1', '0'))
    expect(systemProxyEnv(socksOnly)).toEqual({})
  })

  it('uses the one that is on for both, and refuses what is not a host and port', () => {
    const httpsOnly = SCUTIL.replace('HTTPEnable : 1', 'HTTPEnable : 0')
    expect(systemProxyEnv(httpsOnly).HTTP_PROXY).toBe('http://127.0.0.1:7897')
    expect(systemProxyEnv(SCUTIL.replace(/HTTPS?Proxy : 127.0.0.1/g, 'x;rm -rf'))).toEqual({})
    expect(systemProxyEnv(SCUTIL.replace(/HTTPS?Port : 7897/g, 'HTTPPort : 99999'))).toEqual({})
  })

  it('leaves an environment that names a proxy as it is', () => {
    expect(namesProxy({ https_proxy: 'http://proxy:8080' })).toBe(true)
    expect(namesProxy({ ALL_PROXY: 'socks5://127.0.0.1:1080' })).toBe(true)
    expect(namesProxy({ HTTP_PROXY: ' ', PATH: '/usr/bin' })).toBe(false)
  })
})
