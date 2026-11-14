import { describe, expect, it } from 'vitest'
import { secretKind } from './secrets'

describe('secretKind', () => {
  it.each([
    ['-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn==', 'a private key'],
    ['-----BEGIN RSA PRIVATE KEY-----', 'a private key'],
    ['key sk-proj-Ab12Cd34Ef56Gh78Ij90Kl12', 'an API key'],
    ['sk-ant-api03-Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2', 'an API key'],
    [`ghp_${'A1b2'.repeat(9)}`, 'a GitHub token'],
    [`github_pat_11ABCDEFG0${'x1'.repeat(20)}`, 'a GitHub token'],
    ['xoxb-1234567890-abcdefghij', 'a Slack token'],
    ['AKIAIOSFODNN7EXAMPLE', 'an AWS access key'],
    [`AIza${'Sy0'.repeat(11)}ab`, 'a Google API key'],
    ['glpat-Ab12Cd34Ef56Gh78Ij90', 'a GitLab token'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc', 'a JSON Web Token'],
    ['Authorization: Bearer 9f8e7d6c5b4a39281706abcdef', 'a bearer token'],
    ['DB_PASSWORD=hunter2hunter2', 'a password or token'],
    ['api_key: "a1b2c3d4e5f6g7h8"', 'a password or token'],
    ['client_secret = Zm9vYmFyMTIzNDU2', 'a password or token'],
  ])('finds %s', (text, kind) => {
    expect(secretKind(text)).toBe(kind)
  })

  it.each([
    'Run the tests with pnpm test before pushing.',
    'The session token comes from the host; never log it.',
    'Use sk-learn-and-pytorch-together-in-notebooks for the demo.',
    'Bearer tokens expire after an hour, so refresh them.',
    'token=process.env.GITHUB_TOKEN in the workflow file',
    'Set password: in the form to a value the user picks.',
    'The password reset flow lives in apps/account.',
    'AKIA is the prefix of AWS access keys.',
  ])('passes ordinary text: %s', (text) => {
    expect(secretKind(text)).toBeNull()
  })
})
