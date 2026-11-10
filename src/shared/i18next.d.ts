// Types every `t()` call against the English catalog. Add a namespace here when you add its files.

import 'i18next'
import type agents from './locales/en/agents.json'
import type app from './locales/en/app.json'
import type artifacts from './locales/en/artifacts.json'
import type browser from './locales/en/browser.json'
import type common from './locales/en/common.json'
import type composer from './locales/en/composer.json'
import type devices from './locales/en/devices.json'
import type files from './locales/en/files.json'
import type git from './locales/en/git.json'
import type host from './locales/en/host.json'
import type main from './locales/en/main.json'
import type marketplace from './locales/en/marketplace.json'
import type onboarding from './locales/en/onboarding.json'
import type report from './locales/en/report.json'
import type routines from './locales/en/routines.json'
import type session from './locales/en/session.json'
import type settings from './locales/en/settings.json'
import type shell from './locales/en/shell.json'
import type sidebar from './locales/en/sidebar.json'
import type terminal from './locales/en/terminal.json'
import type tray from './locales/en/tray.json'
import type updates from './locales/en/updates.json'
import type usage from './locales/en/usage.json'
import type viewers from './locales/en/viewers.json'
import type web from './locales/en/web.json'

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common'
    returnNull: false
    resources: {
      agents: typeof agents
      app: typeof app
      artifacts: typeof artifacts
      browser: typeof browser
      common: typeof common
      composer: typeof composer
      devices: typeof devices
      files: typeof files
      git: typeof git
      host: typeof host
      main: typeof main
      marketplace: typeof marketplace
      onboarding: typeof onboarding
      report: typeof report
      routines: typeof routines
      session: typeof session
      settings: typeof settings
      shell: typeof shell
      sidebar: typeof sidebar
      terminal: typeof terminal
      tray: typeof tray
      updates: typeof updates
      usage: typeof usage
      viewers: typeof viewers
      web: typeof web
    }
  }
}
