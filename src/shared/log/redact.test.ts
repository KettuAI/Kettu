import { describe, expect, it } from 'vitest'
import { createRedactor, REDACTED } from './redact'

describe('createRedactor', () => {
  const redact = createRedactor({ home: '/Users/ann', platform: 'darwin' })

  it('masks API keys, GitHub tokens, AWS keys and JWTs', () => {
    const text = [
      'key sk-ant-api03-abcdefghijklmnopqrstuv',
      'gh ghp_abcdefghijklmnopqrstuvwxyz0123',
      'pat github_pat_11ABCDEFG0123456789_abcdefghij',
      'aws AKIAABCDEFGHIJKLMNOP',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijklmnop',
    ].join('\n')
    const out = redact(text)
    expect(out).not.toMatch(/sk-ant|ghp_|github_pat_|AKIA|eyJ/)
    expect(out.split(REDACTED)).toHaveLength(6)
  })

  it('masks authorization headers and bearer tokens', () => {
    expect(redact('Authorization: Bearer abc.def.ghi123')).toBe(`Authorization: Bearer ${REDACTED}`)
    expect(redact('authorization=token-value-123')).toBe(`authorization=${REDACTED}`)
    expect(redact('{"Authorization":"Basic dXNlcjpwYXNz"}')).toBe(
      `{"Authorization":"Basic ${REDACTED}"}`,
    )
  })

  it('masks values of secret-like names but keeps counts', () => {
    expect(redact('OPENAI_API_KEY=abc123xyz')).toBe(`OPENAI_API_KEY=${REDACTED}`)
    expect(redact('{"password":"hunter22"}')).toBe(`{"password":"${REDACTED}"}`)
    expect(redact('client_secret: s3cr3t')).toBe(`client_secret: ${REDACTED}`)
    expect(redact('{"inputTokens":1234,"maxTokens":null}')).toBe(
      '{"inputTokens":1234,"maxTokens":null}',
    )
  })

  it('masks the password in a URL', () => {
    expect(redact('git clone https://ann:pa55word@example.com/repo.git')).toBe(
      `git clone https://ann:${REDACTED}@example.com/repo.git`,
    )
  })

  it('masks a private key block, even cut off', () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n'
    expect(redact(`before ${key}`)).toBe(`before ${REDACTED}`)
  })

  it('masks known secrets by value', () => {
    const own = createRedactor({ secrets: () => ['pairing-code-42', 'short'] })
    expect(own('code pairing-code-42 and short')).toBe(`code ${REDACTED} and short`)
  })

  it('writes the home folder as ~ only as a whole segment', () => {
    expect(redact('/Users/ann/project and /Users/anna/x')).toBe('~/project and /Users/anna/x')
    expect(redact('"/Users/ann"')).toBe('"~"')
  })

  it('handles Windows homes in plain and JSON-escaped text', () => {
    const win = createRedactor({ home: 'C:\\Users\\Ann', platform: 'win32' })
    expect(win('c:\\users\\ann\\code')).toBe('~\\code')
    expect(win('{"cwd":"C:\\\\Users\\\\Ann\\\\code"}')).toBe('{"cwd":"~\\\\code"}')
  })
})
