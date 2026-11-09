import { describe, expect, it } from 'vitest'
import { catalogServer } from './registry'

const active = {
  'io.modelcontextprotocol.registry/official': {
    status: 'active',
    updatedAt: '2026-11-03T11:06:05.48244Z',
    isLatest: true,
  },
}

// GitHub's entry as the registry served it on 2026-11-09.
const github = {
  server: {
    $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    name: 'io.github.github/github-mcp-server',
    description:
      'Connect AI assistants to GitHub - manage repos, issues, PRs, and workflows through natural language.',
    title: 'GitHub',
    repository: { url: 'https://github.com/github/github-mcp-server', source: 'github' },
    version: '2.1.0',
    packages: [
      {
        registryType: 'oci',
        identifier: 'ghcr.io/github/github-mcp-server:2.1.0',
        transport: { type: 'stdio' },
        runtimeArguments: [
          {
            description:
              'Publish the OAuth callback port to loopback so the in-container login callback is reachable',
            type: 'named',
            name: '-p',
            value: '127.0.0.1:8085:8085',
          },
          {
            description: 'Fixed OAuth callback port, matching the published port above',
            type: 'named',
            name: '-e',
            value: 'GITHUB_OAUTH_CALLBACK_PORT=8085',
          },
          {
            description:
              'Optional GitHub Personal Access Token. Omit to log in with OAuth on first use.',
            variables: { token: { format: 'string', isSecret: true } },
            type: 'named',
            name: '-e',
            value: 'GITHUB_PERSONAL_ACCESS_TOKEN={token}',
          },
        ],
      },
    ],
    remotes: [
      {
        type: 'streamable-http',
        url: 'https://api.githubcopilot.com/mcp/',
        headers: [
          {
            description: 'Authorization header with authentication token (PAT or App token)',
            isSecret: true,
            name: 'Authorization',
          },
        ],
      },
    ],
  },
  _meta: active,
}

describe('catalogServer', () => {
  it("runs GitHub's image with its token passed by name, never on the command line", () => {
    const server = catalogServer({ ...github, server: { ...github.server, remotes: [] } })
    expect(server?.official).toBe(false)
    expect(server?.brand).toBeNull()
    expect(server?.spec).toEqual({
      type: 'stdio',
      command: 'docker',
      args: [
        'run',
        '-i',
        '--rm',
        '-p',
        '127.0.0.1:8085:8085',
        '-e',
        'GITHUB_OAUTH_CALLBACK_PORT=8085',
        '-e',
        'GITHUB_PERSONAL_ACCESS_TOKEN',
        'ghcr.io/github/github-mcp-server:2.1.0',
      ],
      env: [
        {
          name: 'GITHUB_PERSONAL_ACCESS_TOKEN',
          input: true,
          secret: true,
          required: false,
          description:
            'Optional GitHub Personal Access Token. Omit to log in with OAuth on first use.',
        },
      ],
    })
  })
})
