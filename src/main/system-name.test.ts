import { describe, expect, it } from 'vitest'
import { systemName, systemRelease } from './system-name'

describe('systemName', () => {
  it('names macOS and Windows with the versions they report', () => {
    expect(systemName('darwin', '26.0.1', 'arm64', null)).toBe('macOS 26.0.1 (arm64)')
    expect(systemName('win32', '10.0.26100', 'x64', null)).toBe('Windows 10.0.26100 (x64)')
  })

  it('takes a Linux distribution name, quoted or bare', () => {
    const ubuntu = 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\nID=ubuntu\n'
    expect(systemName('linux', '6.8.0-45-generic', 'x64', ubuntu)).toBe('Ubuntu 24.04.1 LTS (x64)')
    expect(systemName('linux', '6.8.0-45-generic', 'x64', "PRETTY_NAME='Fedora Linux 41'\n")).toBe(
      'Fedora Linux 41 (x64)',
    )
    expect(systemName('linux', '6.8.0', 'arm64', 'NAME=Gentoo\nPRETTY_NAME=Gentoo\n')).toBe(
      'Gentoo (arm64)',
    )
  })

  it('falls back to Linux and the kernel version without a distribution name', () => {
    expect(systemName('linux', '6.8.0-45-generic', 'x64', null)).toBe(
      'Linux 6.8.0-45-generic (x64)',
    )
    expect(systemName('linux', '6.8.0', 'arm64', 'ID=alpine\nNAME="Alpine Linux"\n')).toBe(
      'Linux 6.8.0 (arm64)',
    )
  })
})

describe('systemRelease', () => {
  it('leaves the architecture out', () => {
    expect(systemRelease('darwin', '26.0.1', null)).toBe('macOS 26.0.1')
    expect(systemRelease('linux', '6.8.0', 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\n')).toBe(
      'Ubuntu 24.04.1 LTS',
    )
  })
})
