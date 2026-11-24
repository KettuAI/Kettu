// A Claude Code plugin as the current layout writes it, for the tests of converting and publishing.

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export function claudePluginFiles(): Record<string, string> {
  return {
    '.claude-plugin/plugin.json': JSON.stringify({
      name: 'Release Tools',
      version: '1.2.0',
      description: 'Helpers for cutting a release.',
      author: { name: 'Bea' },
      repository: 'https://github.com/bea/release-tools',
    }),
    'skills/changelog/SKILL.md':
      '---\nname: changelog\ndescription: Writes one line per change.\n---\n\nWrite the changelog.\n',
    'skills/changelog/examples/one.md': 'An example.\n',
    'commands/ship.md':
      '---\ndescription: Ship the release\nargument-hint: <version>\nallowed-tools: Bash(git:*)\n---\nShip version $ARGUMENTS.\n',
    'agents/reviewer.md':
      '---\nname: reviewer\ndescription: Reviews a release\nmodel: opus\ntools: Read, Grep\n---\nYou review releases. Be strict.\n',
    '.mcp.json': JSON.stringify({
      mcpServers: {
        tracker: {
          type: 'http',
          url: 'https://tracker.example.com/mcp',
          headers: { Authorization: 'Bearer ${TRACKER_TOKEN}' },
        },
        local: {
          command: '${CLAUDE_PLUGIN_ROOT}/bin/server',
          args: ['--data', '${CLAUDE_PLUGIN_ROOT}/data'],
        },
      },
    }),
    'bin/server': '#!/bin/sh\necho ok\n',
    'hooks/hooks.json': JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            matcher: 'Write|Edit',
            hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/format.sh' }],
          },
        ],
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo started' }] }],
      },
    }),
    'scripts/format.sh': '#!/bin/sh\necho format\n',
    'README.md': '# Release tools\n',
  }
}

export async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, text] of Object.entries(files)) {
    const target = path.join(dir, ...name.split('/'))
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, text, { mode: text.startsWith('#!') ? 0o755 : 0o644 })
  }
}
