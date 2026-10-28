import type { AgentDefinition } from '../catalog'

// The registry's archive, 3.0.1, checked on 2026-10-28, with a sha256 for every platform.
const BASE = 'https://github.com/mistralai/mistral-vibe/releases/download/v3.0.1'

export const MISTRAL_VIBE: AgentDefinition = {
  id: 'mistral-vibe',
  name: 'Mistral Vibe',
  registryId: 'mistral-vibe',
  launch: { kind: 'binary', command: 'vibe-acp', args: [] },
  install: {
    hint: 'detect.hint.archive',
    url: 'https://github.com/mistralai/mistral-vibe',
  },
  installs: {
    archive: {
      version: '3.0.1',
      entries: {
        'darwin-aarch64': {
          url: `${BASE}/vibe-acp-darwin-aarch64-3.0.1.tar.gz`,
          sha256: '9da1f65d5d233ad0f79efd8abf1f5c1b258059c2cf58af8c1c3be3d7831d0e89',
          cmd: './vibe-acp',
        },
        'darwin-x86_64': {
          url: `${BASE}/vibe-acp-darwin-x86_64-3.0.1.tar.gz`,
          sha256: '94cba80888c24e509aa96182c6d8d38656d3da8ff72eae64a1ee396c5586d4b6',
          cmd: './vibe-acp',
        },
        'linux-aarch64': {
          url: `${BASE}/vibe-acp-linux-aarch64-3.0.1.tar.gz`,
          sha256: '7ef82101b23d286fb43eb911a6f2d75cf67cbb0ca3d026e7ff1db9d8ccaf32e0',
          cmd: './vibe-acp',
        },
        'linux-x86_64': {
          url: `${BASE}/vibe-acp-linux-x86_64-3.0.1.tar.gz`,
          sha256: '0771544f32f64132731e3d40ca1fdfa628c6076dae1ad4d273fdc31562a13062',
          cmd: './vibe-acp',
        },
        'windows-x86_64': {
          url: `${BASE}/vibe-acp-windows-x86_64-3.0.1.zip`,
          sha256: '63398f233948da074a3e0c00aa78c3709aed11847b8d4b403cdbdc325883bc52',
          cmd: './vibe-acp.exe',
        },
      },
    },
  },
}
