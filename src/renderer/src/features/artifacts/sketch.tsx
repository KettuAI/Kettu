// Each kind's small picture, for a card whose preview cannot be drawn and for the kinds an agent
// is asked for; and the folder a project shows with.

import type { ArtifactKind } from './model'

/** A white sheet on the card's gray stage, drawn with the kind's own shapes. */
export function KindSketch({ kind, title }: { kind: ArtifactKind; title: string }) {
  if (kind === 'slides') {
    return (
      <span className="k-th k-th--slide">
        <span className="k-th__slide">
          <i className="k-th__kicker" />
          <b>{title}</b>
          <span className="k-th__bars">
            <i style={{ height: '40%' }} />
            <i style={{ height: '65%' }} />
            <i style={{ height: '52%' }} />
            <i style={{ height: '88%' }} />
          </span>
        </span>
      </span>
    )
  }
  if (kind === 'web') {
    return (
      <span className="k-th k-th--page">
        <span className="k-th__nav">
          <i />
          <i />
          <i />
        </span>
        <span className="k-th__hero">
          <b>{title}</b>
          <i className="k-th__line" style={{ width: '70%' }} />
          <i className="k-th__btn" />
        </span>
        <span className="k-th__cards">
          <i />
          <i />
          <i />
        </span>
      </span>
    )
  }
  if (kind === 'canvas') {
    return (
      <span className="k-th k-th--canvas">
        <i className="k-th__frame" style={{ left: '8%', top: '18%' }} />
        <i className="k-th__frame" style={{ left: '38%', top: '30%' }} />
        <i className="k-th__frame" style={{ left: '68%', top: '14%' }} />
        <svg
          className="k-th__wire"
          viewBox="0 0 100 60"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path d="M26 34 C 32 34, 34 46, 40 46 M56 46 C 62 46, 64 30, 70 30" />
        </svg>
      </span>
    )
  }
  return (
    <span className="k-th k-th--doc">
      <span className="k-th__page">
        <b>{title}</b>
        {[92, 100, 84, 0, 96, 70].map((width, i) =>
          width ? (
            <i key={i} className="k-th__line" style={{ width: `${width}%` }} />
          ) : (
            <i key={i} className="k-th__gap" />
          ),
        )}
      </span>
    </span>
  )
}
