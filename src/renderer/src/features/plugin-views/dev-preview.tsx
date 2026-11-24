// Development only: opens a plugin's view in a sheet over the window from the address' hash, as
// `#plugin-view=<plugin id>/<view id>?width=360&param.id=3`, so a view can be looked at in the
// desktop app and in the web client at any width without a surface of its own. It is not in a
// build that ships.

import { useEffect, useState } from 'react'
import { Cancel01Icon } from '@hugeicons/core-free-icons'
import { Button } from '@renderer/components/ui/button'
import { Glyph } from '@renderer/features/shell/glyph'
import { host } from '@renderer/lib/host'
import { PluginView } from './plugin-view'

const HASH = '#plugin-view='

interface Preview {
  pluginId: string
  viewId: string
  width: number
  params: Record<string, string>
}

function read(hash: string): Preview | null {
  if (!hash.startsWith(HASH)) return null
  const [path = '', query = ''] = hash.slice(HASH.length).split('?')
  const [pluginId, viewId] = path.split('/')
  if (!pluginId || !viewId) return null
  const given = new URLSearchParams(query)
  const params: Record<string, string> = {}
  for (const [key, value] of given) if (key.startsWith('param.')) params[key.slice(6)] = value
  return { pluginId, viewId, width: Number(given.get('width')) || 420, params }
}

export default function PluginViewPreview() {
  const [preview, setPreview] = useState(() => read(window.location.hash))
  useEffect(() => {
    const change = () => setPreview(read(window.location.hash))
    window.addEventListener('hashchange', change)
    return () => window.removeEventListener('hashchange', change)
  }, [])
  if (!preview) return null
  return (
    <div
      className="fixed top-12 right-6 bottom-6 isolate z-50 overflow-hidden rounded-xl bg-card shadow-card"
      style={{ width: preview.width, maxWidth: 'calc(100vw - 48px)' }}
    >
      <Button
        variant="quiet"
        size="icon-sm"
        className="absolute top-0.5 right-10 z-10"
        aria-label="Close"
        onClick={() => {
          window.location.hash = ''
        }}
      >
        <Glyph icon={Cancel01Icon} size={14} />
      </Button>
      <PluginView
        request={host}
        pluginId={preview.pluginId}
        viewId={preview.viewId}
        params={preview.params}
      />
    </div>
  )
}
