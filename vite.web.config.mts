// The web client's build: the renderer for a browser, with its own entry that reaches the host over
// the encrypted channel, into out/web/. The remote host serves it on its direct port. With
// `--mode hosted` it is the hosted build instead, into out/web-hosted/: signed in to a Kettu
// account, it reaches the hosts through the relay. `KETTU_ACCOUNT_URL` and `KETTU_RELAY_URL` point
// a development build of it at other copies of the services. With `--mode relay` it is the build a
// relay the owner runs serves, into out/web-relay/: no account, the relay is the page's own origin.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, normalizePath, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cn } from 'cn/vite'
import { pageRuntime } from './tools/build/page-runtime'
import { integrity } from './tools/build/integrity'
import { pdfjsData } from './tools/build/pdfjs-data'
import { agentMarkNotice, standaloneThirdPartyNotices } from './tools/build/third-party-notices'

const source = (file: string): string => fileURLToPath(new URL(file, import.meta.url))

// The page says hello with the version of Kettu it ships with, as the desktop app does.
const { version } = JSON.parse(readFileSync(source('package.json'), 'utf8')) as { version: string }

// The page links the renderer's sources above the root as `../src/`. A build resolves them as files,
// but in the dev server the browser resolves them against the root first, so they go through
// Vite's /@fs/ prefix there instead.
const devSourceLinks = (): Plugin => ({
  name: 'kettu-web-dev-source-links',
  apply: 'serve',
  transformIndexHtml: {
    order: 'pre',
    handler: (html) =>
      html.replaceAll(
        '"../src/',
        `"/@fs/${normalizePath(source('src/renderer/src/')).replace(/^\//, '')}`,
      ),
  },
})

// The relay's build reaches nothing but its own origin, which the page says itself too.
const relayPagePolicy = (): Plugin => ({
  name: 'kettu-web-relay-csp',
  transformIndexHtml: () => [
    {
      tag: 'meta',
      attrs: {
        'http-equiv': 'Content-Security-Policy',
        content: [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "media-src 'self' data: blob:",
          "font-src 'self' data:",
          "connect-src 'self'",
          "frame-src 'self'",
          "worker-src 'self' blob:",
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
        ].join('; '),
      },
      injectTo: 'head-prepend',
    },
  ],
})

export default defineConfig(({ mode }) => {
  const hosted = mode === 'hosted'
  const relay = mode === 'relay'
  return {
    root: source('src/renderer/web'),
    define: {
      __KETTU_VERSION__: JSON.stringify(version),
      __KETTU_HOSTED__: JSON.stringify(hosted),
      __KETTU_RELAY_BUILD__: JSON.stringify(relay),
      __KETTU_ACCOUNT_URL__: JSON.stringify(hosted ? (process.env.KETTU_ACCOUNT_URL ?? '') : ''),
      __KETTU_RELAY_URL__: JSON.stringify(hosted ? (process.env.KETTU_RELAY_URL ?? '') : ''),
      __KETTU_REGION_KEYS__: JSON.stringify(hosted ? (process.env.KETTU_REGION_KEYS ?? '') : ''),
    },
    resolve: {
      alias: [
        { find: '@shared', replacement: source('src/shared') },
        { find: '@renderer', replacement: source('src/renderer/src') },
        // The shadcn CLI imports cn from the package; give it the theme-aware instance.
        { find: /^cn$/, replacement: source('src/renderer/src/lib/utils.ts') },
      ],
    },
    // The renderer's build writes the same tables; both read the renderer's sources.
    plugins: [
      devSourceLinks(),
      react(),
      tailwindcss(),
      cn({ full: true, out: 'src/lib/cn-tables.ts', cwd: source('src/renderer') }),
      // The daemon's package ships the web client too.
      standaloneThirdPartyNotices(source('.'), [], [agentMarkNotice(source('.'))]),
      pageRuntime(source('src/shared/artifact-runtime/runtime.ts')),
      pdfjsData(),
      ...(hosted || relay ? [integrity()] : []),
      ...(relay ? [relayPagePolicy()] : []),
    ],
    server: {
      // A dev server beside the app: the channel and the artifact frames go on to the host's direct
      // port. The page's Origin and Host stay this server's, so the host's Origin check holds.
      proxy:
        !hosted && process.env.KETTU_WEB_HOST
          ? {
              '/channel': { target: process.env.KETTU_WEB_HOST, ws: true },
              '/frame/': { target: process.env.KETTU_WEB_HOST },
            }
          : undefined,
    },
    build: {
      outDir: source(hosted ? 'out/web-hosted' : relay ? 'out/web-relay' : 'out/web'),
      emptyOutDir: true,
      minify: true,
    },
  }
})
