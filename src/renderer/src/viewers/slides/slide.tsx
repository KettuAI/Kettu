// One slide, laid out by its layout at the deck's size in CSS pixels, as the PowerPoint export
// places it; scaled to fit by whoever shows it.

import type { KeyboardEvent } from 'react'
import { bulletParts, type Bullet, type Column, type Slide } from '@shared/artifact-slides'
import type { TextPath } from './deck'

export interface SlideEditing {
  /** Tells whether a text is being changed in place, before it is taken on leaving it. */
  typing(now: boolean): void
  /** Takes a text the user changed. */
  change(path: TextPath, text: string): void
}

function commitOnEnter(event: KeyboardEvent<HTMLElement>): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
    event.preventDefault()
    event.currentTarget.blur()
  }
}

/** A text of the slide; while editing, one the user can change in place. */
function Text({
  value,
  path,
  editing,
  className,
  as: Tag = 'div',
}: {
  value: string | undefined
  path: TextPath
  editing: SlideEditing | null
  className: string
  as?: 'div' | 'span' | 'li' | 'p' | 'blockquote' | 'figcaption' | 'th' | 'td'
}) {
  if (value === undefined) return null
  if (!editing) return <Tag className={className}>{value}</Tag>
  return (
    <Tag
      key={value}
      className={`${className} slide-editable`}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck
      onKeyDown={commitOnEnter}
      onInput={() => editing.typing(true)}
      onBlur={(event) => {
        editing.typing(false)
        const text = event.currentTarget.innerText.replace(/\n$/, '')
        if (text !== value) editing.change(path, text)
      }}
    >
      {value}
    </Tag>
  )
}

function Bullets({
  bullets,
  path,
  editing,
}: {
  bullets: readonly Bullet[]
  path: TextPath
  editing: SlideEditing | null
}) {
  return (
    <ul className="slide-bullets">
      {bullets.map((bullet, i) => {
        const { text, bullets: under } = bulletParts(bullet)
        const at = typeof bullet === 'string' ? [...path, i] : [...path, i, 'text']
        return (
          <li key={i}>
            <Text value={text} path={at} editing={editing} className="slide-point" as="span" />
            {under.length > 0 && (
              <ul className="slide-bullets slide-sub">
                {under.map((point, j) => (
                  <Text
                    key={j}
                    value={point}
                    path={[...path, i, 'bullets', j]}
                    editing={editing}
                    className="slide-point"
                    as="li"
                  />
                ))}
              </ul>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function ColumnView({
  column,
  path,
  editing,
}: {
  column: Column
  path: TextPath
  editing: SlideEditing | null
}) {
  return (
    <div className="slide-column">
      <Text
        value={column.heading}
        path={[...path, 'heading']}
        editing={editing}
        className="slide-heading"
      />
      <Text value={column.text} path={[...path, 'text']} editing={editing} className="slide-text" />
      {column.bullets && (
        <Bullets bullets={column.bullets} path={[...path, 'bullets']} editing={editing} />
      )}
    </div>
  )
}

export function SlideView({
  slide,
  index,
  editing,
  label,
}: {
  slide: Slide
  index: number
  editing: SlideEditing | null
  label: string
}) {
  const at: TextPath = ['slides', index]
  const text = (key: string) => [...at, key]
  const title = 'title' in slide ? slide.title : undefined
  const heading = (
    <Text value={title} path={text('title')} editing={editing} className="slide-title" />
  )
  let body
  switch (slide.layout) {
    case 'title':
    case 'section':
      body = (
        <div className={slide.layout === 'title' ? 'slide-cover' : 'slide-cover slide-section'}>
          <span className="slide-accent" aria-hidden />
          <Text
            value={slide.title}
            path={text('title')}
            editing={editing}
            className="slide-display"
          />
          <Text
            value={slide.subtitle}
            path={text('subtitle')}
            editing={editing}
            className="slide-subtitle"
          />
        </div>
      )
      break
    case 'bullets':
      body = (
        <>
          {heading}
          <div className="slide-body">
            <Bullets bullets={slide.bullets} path={text('bullets')} editing={editing} />
            {slide.image && (
              <img className="slide-picture slide-half" src={slide.image} alt={slide.alt ?? ''} />
            )}
          </div>
        </>
      )
      break
    case 'two-column':
      body = (
        <>
          {heading}
          <div className="slide-body">
            <ColumnView column={slide.left} path={text('left')} editing={editing} />
            <ColumnView column={slide.right} path={text('right')} editing={editing} />
          </div>
        </>
      )
      break
    case 'image':
      body = (
        <>
          {heading}
          <figure className="slide-figure">
            <img className="slide-picture" src={slide.image} alt={slide.alt} />
            <Text
              value={slide.caption}
              path={text('caption')}
              editing={editing}
              className="slide-caption"
              as="figcaption"
            />
          </figure>
        </>
      )
      break
    case 'quote':
      body = (
        <figure className="slide-quote">
          <Text
            value={slide.quote}
            path={text('quote')}
            editing={editing}
            className="slide-said"
            as="blockquote"
          />
          {slide.attribution !== undefined && (
            <figcaption className="slide-by">
              <span aria-hidden>— </span>
              <Text
                value={slide.attribution}
                path={text('attribution')}
                editing={editing}
                className=""
                as="span"
              />
            </figcaption>
          )}
        </figure>
      )
      break
    case 'stats':
      body = (
        <>
          {heading}
          <div className="slide-stats">
            {slide.stats.map((stat, i) => (
              <div key={i} className="slide-stat">
                <Text
                  value={stat.value}
                  path={[...at, 'stats', i, 'value']}
                  editing={editing}
                  className="slide-figure-value"
                />
                <Text
                  value={stat.label}
                  path={[...at, 'stats', i, 'label']}
                  editing={editing}
                  className="slide-figure-label"
                />
              </div>
            ))}
          </div>
        </>
      )
      break
    case 'table':
      body = (
        <>
          {heading}
          <table className={slide.rows.length > 10 ? 'slide-table slide-dense' : 'slide-table'}>
            <thead>
              <tr>
                {slide.columns.map((column, c) => (
                  <Text
                    key={c}
                    value={column}
                    path={[...at, 'columns', c]}
                    editing={editing}
                    className=""
                    as="th"
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {slide.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <Text
                      key={c}
                      value={cell}
                      path={[...at, 'rows', r, c]}
                      editing={editing}
                      className=""
                      as="td"
                    />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )
      break
  }
  return (
    <section className="slide" aria-label={label} data-layout={slide.layout}>
      {body}
    </section>
  )
}
