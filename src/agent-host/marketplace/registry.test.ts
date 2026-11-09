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

function entry(server: Record<string, unknown>, meta: unknown = active): unknown {
  return { server: { name: 'io.github.acme/tool', version: '1.2.3', ...server }, _meta: meta }
}

describe('catalogServer', () => {
  it("reads GitHub's entry as its remote, with the token header as a secret input", () => {
    expect(
      catalogServer(github, {
        official: true,
        brand: 'github',
        prefixes: { Authorization: 'Bearer ' },
      }),
    ).toEqual({
      id: 'io.github.github/github-mcp-server',
      title: 'GitHub',
      publisher: 'github',
      official: true,
      description:
        'Connect AI assistants to GitHub - manage repos, issues, PRs, and workflows through natural language.',
      version: '2.1.0',
      updated: '2026-11-03T11:06:05.48244Z',
      repository: 'https://github.com/github/github-mcp-server',
      website: null,
      brand: 'github',
      spec: {
        type: 'http',
        transport: 'streamable-http',
        url: 'https://api.githubcopilot.com/mcp/',
        headers: [
          {
            name: 'Authorization',
            input: true,
            secret: true,
            required: false,
            description: 'Authorization header with authentication token (PAT or App token)',
            prefix: 'Bearer ',
          },
        ],
      },
    })
  })

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

  it('runs an npm package with npx, its secret variable an input and a default a fixed value', () => {
    const server = catalogServer(
      entry({
        packages: [
          {
            registryType: 'npm',
            registryBaseUrl: 'https://registry.npmjs.org',
            identifier: '@acme/tool-mcp',
            version: '4.6.0',
            transport: { type: 'stdio' },
            packageArguments: [
              { type: 'named', name: '--mode', value: 'read' },
              { type: 'positional', value: 'serve' },
              { type: 'named', name: '--optional', description: 'Left out when empty' },
            ],
            environmentVariables: [
              { name: 'ACME_API_KEY', isSecret: true, isRequired: true, description: 'API key' },
              { name: 'ACME_REGION', default: 'eu' },
              { name: 'ACME_HOST', description: 'Self-hosted address' },
            ],
          },
        ],
      }),
    )
    expect(server?.publisher).toBe('acme')
    expect(server?.title).toBe('tool')
    expect(server?.spec).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@acme/tool-mcp@4.6.0', '--mode', 'read', 'serve'],
      env: [
        { name: 'ACME_API_KEY', input: true, secret: true, required: true, description: 'API key' },
        { name: 'ACME_REGION', value: 'eu' },
        {
          name: 'ACME_HOST',
          input: true,
          secret: false,
          required: false,
          description: 'Self-hosted address',
        },
      ],
    })
  })

  it('runs a PyPI package with uvx at its version', () => {
    const server = catalogServer(
      entry({
        packages: [
          {
            registryType: 'pypi',
            identifier: 'acme-mcp',
            version: '0.7.0',
            transport: { type: 'stdio' },
          },
        ],
      }),
    )
    expect(server?.spec).toEqual({
      type: 'stdio',
      command: 'uvx',
      args: ['acme-mcp==0.7.0'],
      env: [],
    })
  })

  it("takes a header's bearer template as an input with its prefix", () => {
    const server = catalogServer(
      entry({
        remotes: [
          {
            type: 'streamable-http',
            url: 'https://mcp.acme.dev/mcp',
            headers: [
              {
                name: 'Authorization',
                value: 'Bearer {api_key}',
                variables: { api_key: { isRequired: true, isSecret: true } },
              },
              { name: 'X-Read-Only', default: 'false', description: 'Read-only mode' },
            ],
          },
        ],
      }),
    )
    expect(server?.spec).toEqual({
      type: 'http',
      transport: 'streamable-http',
      url: 'https://mcp.acme.dev/mcp',
      headers: [
        { name: 'Authorization', input: true, secret: true, required: true, prefix: 'Bearer ' },
        { name: 'X-Read-Only', value: 'false' },
      ],
    })
  })

  it('prefers streamable HTTP to SSE, and takes SSE when it is the only remote', () => {
    const both = catalogServer(
      entry({
        remotes: [
          { type: 'sse', url: 'https://mcp.acme.dev/sse' },
          { type: 'streamable-http', url: 'https://mcp.acme.dev/mcp' },
        ],
      }),
    )
    expect(both?.spec).toMatchObject({
      transport: 'streamable-http',
      url: 'https://mcp.acme.dev/mcp',
    })
    const sse = catalogServer(
      entry({ remotes: [{ type: 'sse', url: 'https://mcp.acme.dev/sse' }] }),
    )
    expect(sse?.spec).toMatchObject({ type: 'http', transport: 'sse', headers: [] })
  })

  it('passes over a remote whose address needs filling in, for the package beside it', () => {
    const server = catalogServer(
      entry({
        remotes: [{ type: 'streamable-http', url: 'https://{region}.acme.dev/mcp' }],
        packages: [
          {
            registryType: 'npm',
            identifier: 'acme',
            version: '1.0.0',
            transport: { type: 'stdio' },
          },
        ],
      }),
    )
    expect(server?.spec).toMatchObject({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'acme@1.0.0'],
    })
  })

  it('leaves out what Kettu cannot run', () => {
    const only = (pkg: Record<string, unknown>) => catalogServer(entry({ packages: [pkg] }))
    // Package kinds without a runner.
    expect(
      only({ registryType: 'mcpb', identifier: 'https://x/y.mcpb', transport: { type: 'stdio' } }),
    ).toBeNull()
    expect(
      only({
        registryType: 'nuget',
        identifier: 'Acme.Mcp',
        version: '1.0.0',
        transport: { type: 'stdio' },
      }),
    ).toBeNull()
    // A package that serves HTTP on a port of its own.
    expect(
      only({
        registryType: 'npm',
        identifier: 'acme',
        version: '1.0.0',
        transport: { type: 'streamable-http' },
      }),
    ).toBeNull()
    // A secret that would sit on the command line, where other users can read it.
    expect(
      only({
        registryType: 'npm',
        identifier: 'acme',
        version: '1.0.0',
        transport: { type: 'stdio' },
        packageArguments: [
          {
            type: 'named',
            name: '--token',
            value: '{token}',
            variables: { token: { isSecret: true } },
          },
        ],
      }),
    ).toBeNull()
    // A required argument the user would have to type.
    expect(
      only({
        registryType: 'npm',
        identifier: 'acme',
        version: '1.0.0',
        transport: { type: 'stdio' },
        packageArguments: [{ type: 'positional', valueHint: 'path', isRequired: true }],
      }),
    ).toBeNull()
    // An npm package from another registry.
    expect(
      only({
        registryType: 'npm',
        registryBaseUrl: 'https://npm.example.com',
        identifier: 'acme',
        version: '1.0.0',
        transport: { type: 'stdio' },
      }),
    ).toBeNull()
    // Neither a remote nor a package.
    expect(catalogServer(entry({}))).toBeNull()
  })

  it('leaves out a withdrawn entry and one that is not an entry', () => {
    const remote = { remotes: [{ type: 'streamable-http', url: 'https://mcp.acme.dev/mcp' }] }
    const deleted = { 'io.modelcontextprotocol.registry/official': { status: 'deleted' } }
    expect(catalogServer(entry(remote, deleted))).toBeNull()
    expect(catalogServer(entry({ ...remote, name: 'no slash' }))).toBeNull()
    expect(
      catalogServer(
        entry({ ...remote, remotes: [{ type: 'streamable-http', url: 'http://plain' }] }),
      ),
    ).toBeNull()
    expect(catalogServer(null)).toBeNull()
    expect(catalogServer({ server: 'x' })).toBeNull()
  })

  it('names the publisher from the domain its name reverses when it has no repository', () => {
    const server = catalogServer({
      server: {
        name: 'com.canva.mcp/mcp',
        version: '1.0.0',
        remotes: [{ type: 'streamable-http', url: 'https://mcp.canva.com/mcp' }],
      },
    })
    expect(server?.publisher).toBe('canva.com')
  })
})
