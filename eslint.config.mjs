import js from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier/flat'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig([
  globalIgnores(['out', 'dist', '.worktrees']),
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
      'tools/**/*.{ts,mjs}',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: { globals: globals.browser },
  },
  {
    // shadcn/ui components export their variant helpers next to the component.
    files: ['src/renderer/src/components/ui/**/*.tsx'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
  eslintConfigPrettier,
])
