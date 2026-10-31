import js from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier/flat'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import kettu from './tools/lint/eslint-plugin.mjs'

const SDK_MESSAGE = 'Load the SDK with loadClaudeSdk from src/agent-host/claude/sdk.ts.'
const SDK_PATHS = [{ name: '@anthropic-ai/claude-agent-sdk', message: SDK_MESSAGE }]
const SDK_PATTERNS = [{ group: ['@anthropic-ai/claude-agent-sdk/*'], message: SDK_MESSAGE }]
const HOST_MESSAGE =
  'The hosts also run under Node.js; only their entries, index.ts, adapt Electron to them.'

export default defineConfig([
  globalIgnores(['out', 'dist', '.worktrees', 'src/renderer/src/lib/cn-tables.ts']),
  {
    files: ['**/*.{ts,tsx,mjs}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
  },
  {
    files: [
      'electron.vite.config.ts',
      'vitest.config.mts',
      'src/main/**/*.ts',
      'src/preload/**/*.ts',
      'src/agent-host/**/*.ts',
      'src/terminal-host/**/*.ts',
      'src/remote-host/**/*.ts',
      'tools/**/*.{ts,mjs}',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    // The Claude Agent SDK's license grants no right to ship it, so Kettu installs it on first use
    // and loads it from there with its own types; an import would bundle it or need it installed.
    files: ['**/*.{ts,tsx,mjs}'],
    rules: {
      'no-restricted-imports': ['error', { paths: SDK_PATHS, patterns: SDK_PATTERNS }],
    },
  },
  {
    // The hosts run under Node.js too, so only their utility-process entries may use Electron.
    // A later config replaces the rule's options, so this one repeats the SDK's.
    files: ['src/agent-host/**/*.ts', 'src/terminal-host/**/*.ts', 'src/remote-host/**/*.ts'],
    ignores: ['src/agent-host/index.ts', 'src/terminal-host/index.ts', 'src/remote-host/index.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...SDK_PATHS, { name: 'electron', message: HOST_MESSAGE }],
          patterns: [...SDK_PATTERNS, { group: ['electron/*'], message: HOST_MESSAGE }],
        },
      ],
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: { globals: globals.browser },
  },
  {
    // Colors live in src/renderer/src/styles/tokens.css; tools/lint/css-colors.mjs covers the CSS.
    files: ['src/renderer/**/*.{ts,tsx}'],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    plugins: { kettu },
    rules: { 'kettu/no-color-literals': 'error' },
  },
  {
    // shadcn/ui components export their variant helpers next to the component.
    files: ['src/renderer/src/components/ui/**/*.tsx'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
  eslintConfigPrettier,
])
