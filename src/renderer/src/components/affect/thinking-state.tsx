// affectUI Pro - licensed under https://www.affectui.com/license, not under this project's open-source license. Don't copy it out of this project.
"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/*
 * Thinking State (Clean) – the "working…" panel of an AI chat, in a single self-contained file.
 * Clean style: no card, straight on the page. The header row holds a pixel mark, the live timer and
 * the chevron; below it the searches with their sources and the thinking steps appear one after
 * another; at the end a check, and the header turns into "Worked for …".
 * The styles are injected below, so no extra files are needed.
 */

export type ThinkingSource = {
  label: string;
  icon?: ReactNode;
  /** Opens in a new tab */
  href?: string;
  /** Tooltip on hover – defaults to the link */
  tooltip?: string;
};

export type ThinkingStep =
  | {
      kind: "search";
      label: string;
      activeLabel?: string;
      sources: ThinkingSource[];
      /** Hidden behind a "+N more" chip until it is clicked */
      moreSources?: ThinkingSource[];
    }
  | { kind: "step"; label: string };

export type ThinkingStateProps = {
  steps: ThinkingStep[];
  /** Label of the final row */
  doneLabel?: string;
  /** Pause between two steps, in ms */
  stepMs?: number;
  /** Start over after a pause once finished – nice for previews */
  loop?: boolean;
  /** Fold the steps away by themselves once it's finished – the header stays */
  collapseOnDone?: boolean;
  onDone?: (seconds: number) => void;
  className?: string;
};

const CHIP_MS = 160;

export function ThinkingState({
  steps,
  doneLabel = "Finished thinking",
  stepMs = 1300,
  loop = false,
  collapseOnDone = false,
  onDone,
  className,
}: ThinkingStateProps) {
  // Gaps, steps without a list of sources and labels that aren't text are tidied once, so nothing crashes
  const list = useMemo(() => tidy(steps), [steps]);
  const pace = Number.isFinite(stepMs) && stepMs >= 0 ? stepMs : 1300;
  const [run, setRun] = useState(0);
  // How many steps are visible – the first one is there from the start, so the panel never opens empty
  const [shown, setShown] = useState(Math.min(1, list.length));
  const [done, setDone] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [startAt, setStartAt] = useState(() => Date.now());
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const started = useRef(0);
  // Once someone clicks inside, a looping preview stays put instead of starting over
  const touched = useRef(false);

  // Reveal the steps one by one; a search waits until all of its sources have popped in
  useEffect(() => {
    started.current = Date.now();
    setStartAt(started.current);
    setShown(Math.min(1, list.length));
    setDone(false);
    setSeconds(0);
    setOpen(true);
    setExpanded(new Set());
    const timers: number[] = [];
    // The first step shows right away; the next ones follow
    let at = 0;
    list.forEach((step, i) => {
      if (i > 0) timers.push(window.setTimeout(() => setShown(i + 1), at));
      at += pace + (step.kind === "search" ? (Math.min(step.sources.length, MAX_STAGGER) + 1) * CHIP_MS : 0);
    });
    timers.push(
      window.setTimeout(() => {
        const s = Math.max(1, Math.round((Date.now() - started.current) / 1000));
        setSeconds(s);
        setDone(true);
        if (collapseOnDone) setOpen(false);
        onDone?.(s);
      }, at),
    );
    if (loop) timers.push(window.setTimeout(() => !touched.current && setRun((r) => r + 1), at + 4000));
    return () => timers.forEach(clearTimeout);
  }, [run, list, pace, loop]); // eslint-disable-line react-hooks/exhaustive-deps

  const active = done ? -1 : shown - 1;

  return (
    <div className={["ui-thinkc", className].filter(Boolean).join(" ")} data-done={done || undefined} key={run}>
      {/* React 19 hoists this into <head> once, no matter how many panels render */}
      <style href="ui-thinking-state-clean" precedence="default">
        {css}
      </style>

      <button type="button" className="ui-thinkc__head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {/* A 3×3 pixel mark: the squares twinkle while it thinks and settle once it's done */}
        <span className="ui-thinkc__mark" aria-hidden="true">
          {Array.from({ length: 9 }, (_, i) => (
            <i key={i} style={{ animationDelay: `${PIXEL_DELAYS[i]}ms` }} />
          ))}
        </span>
        <span className="ui-thinkc__title" key={done ? "done" : "busy"}>
          {done ? (
            `Worked for ${format(seconds)}`
          ) : (
            <>
              <span className="ui-thinkc__shimmer" data-text="Thinking">
                Thinking
              </span>
              <span className="ui-thinkc__time">
                {/* Only the clock ticks – the steps below don't render again every quarter second */}
                <Elapsed since={startAt} />
              </span>
            </>
          )}
        </span>
        <span className="ui-thinkc__chevron" aria-hidden="true">
          <svg viewBox="0 0 16 16">
            <path d="M4.5 6.25 8 9.75l3.5-3.5" />
          </svg>
        </span>
      </button>

      {/* Only the steps fold away – the header row always stays in view */}
      <div className="ui-thinkc__body" data-open={open}>
        <div className="ui-thinkc__clip">
          <ol className="ui-thinkc__list" aria-live="polite">
            {list.slice(0, shown).map((step, i) => {
              const isActive = i === active;
              const label = step.kind === "search" && isActive ? (step.activeLabel ?? "Searching") : step.label;
              return (
                <li key={i} className="ui-thinkc__item" data-kind={step.kind} data-active={isActive || undefined}>
                  <span className="ui-thinkc__node" aria-hidden="true">
                    {step.kind === "search" ? (
                      <svg viewBox="0 0 24 24" className="ui-thinkc__globe">
                        <path d="M22 12A10 10 0 1 0 12 22" />
                        <path d="M20 5.7c-.93.07-2.13.43-2.96 1.5-1.5 1.94-3 2.1-4 1.46-1.5-.97-.24-2.54-2-3.4-1.15-.56-1.31-2.07-.67-3.26" />
                        <path d="M2 11c.76.66 1.83 1.27 3.09 1.27 2.6 0 3.12.5 3.12 2.48s0 1.99.52 3.48c.34.97.46 1.94-.22 2.77" />
                        <path d="m19.9 19.93 2.1 2.07m-.89-4.95a4.05 4.05 0 1 1-8.11 0 4.05 4.05 0 0 1 8.11 0Z" />
                      </svg>
                    ) : (
                      <span className="ui-thinkc__dot" />
                    )}
                  </span>
                  <div className="ui-thinkc__content">
                    <span
                      className={isActive ? "ui-thinkc__label ui-thinkc__shimmer" : "ui-thinkc__label"}
                      data-text={label}
                      dir="auto"
                    >
                      {label}
                    </span>
                    {step.kind === "search" && (
                      <div className="ui-thinkc__sources">
                        {[...step.sources, ...(expanded.has(i) ? (step.moreSources ?? []) : [])].map((source, j) => (
                          <Source
                            key={source.label + j}
                            source={source}
                            // Extra sources pop in quickly after a click, the first ones follow the search
                            delay={j < step.sources.length ? 120 + Math.min(j, MAX_STAGGER) * CHIP_MS : Math.min(j - step.sources.length, MAX_STAGGER) * 70}
                          />
                        ))}
                        {step.moreSources?.length ? (
                          <button
                            type="button"
                            className="ui-thinkc__source ui-thinkc__more"
                            aria-expanded={expanded.has(i)}
                            style={{ animationDelay: `${120 + Math.min(step.sources.length, MAX_STAGGER) * CHIP_MS}ms` }}
                            onClick={() => {
                              touched.current = true;
                              setExpanded((prev) => {
                                const next = new Set(prev);
                                if (next.has(i)) next.delete(i);
                                else next.add(i);
                                return next;
                              });
                            }}
                          >
                            {expanded.has(i) ? "Show less" : `+${step.moreSources.length.toLocaleString("en-US")} more`}
                          </button>
                        ) : null}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
            {done && (
              <li className="ui-thinkc__item" data-kind="done">
                <span className="ui-thinkc__node" aria-hidden="true">
                  <svg viewBox="0 0 16 16" className="ui-thinkc__check">
                    <circle cx="8" cy="8" r="6.5" />
                    <path d="M5.4 8.3l1.75 1.75L10.7 6.4" />
                  </svg>
                </span>
                <div className="ui-thinkc__content">
                  <span className="ui-thinkc__label" dir="auto">
                  {doneLabel}
                </span>
                </div>
              </li>
            )}
          </ol>
        </div>
      </div>
    </div>
  );
}

/** A source chip: a link when it has one, with a tooltip on hover and focus */
function Source({ source, delay }: { source: ThinkingSource; delay: number }) {
  const tip = source.tooltip ?? source.href?.replace(/^https?:\/\//, "");
  const inner = (
    <>
      {source.icon && (
        // A logo that fails to load hides its tile instead of showing a broken image
        <span className="ui-thinkc__favicon" onErrorCapture={(e) => (e.currentTarget.style.display = "none")}>
          {source.icon}
        </span>
      )}
      <span className="ui-thinkc__source-label" dir="auto" title={tip ? undefined : source.label}>
        {source.label}
      </span>
      {tip && (
        <span className="ui-thinkc__tip" aria-hidden="true">
          {tip}
        </span>
      )}
    </>
  );
  const props = {
    className: "ui-thinkc__source",
    "data-count": !source.icon || undefined,
    style: { animationDelay: `${delay}ms` },
  };
  return source.href ? (
    <a {...props} href={source.href} target="_blank" rel="noreferrer">
      {inner}
    </a>
  ) : (
    <span {...props}>{inner}</span>
  );
}

/** Twinkle order of the 3×3 pixel mark – a diagonal wave */
const PIXEL_DELAYS = [0, 120, 240, 120, 240, 360, 240, 360, 480];

/** 9s, 1m 05s, 1h 04m, 3d 4h */
const format = (secs: number) => {
  const s = Number.isFinite(secs) ? Math.max(0, Math.floor(secs)) : 0;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
};

/** The live clock in the header – ticks on its own */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  return <>{format((now - since) / 1000)}</>;
}

/** Long source lists stop staggering after this many chips, so the last one doesn't wait for ages */
const MAX_STAGGER = 12;

const sourcesOf = (value: unknown): ThinkingSource[] =>
  Array.isArray(value)
    ? value.filter((s) => s && typeof s === "object").map((s) => ({ ...s, label: String(s.label ?? "") }))
    : [];

const tidy = (steps: unknown): ThinkingStep[] =>
  Array.isArray(steps)
    ? steps
        .filter((s) => s && typeof s === "object")
        .map((s) =>
          s.kind === "search"
            ? { ...s, label: String(s.label ?? ""), sources: sourcesOf(s.sources), moreSources: sourcesOf(s.moreSources) }
            : { kind: "step" as const, label: String(s.label ?? "") },
        )
    : [];

/* ---------- Styles ---------- */

const css = /* css */ `
/* Colors and motion as variables – override them on .ui-thinkc (see Theming in the docs) */
.ui-thinkc {
  --ui-tkc-card: #ffffff;
  --ui-tkc-ink: rgba(0, 0, 0, 0.88);
  --ui-tkc-strong: #000000;
  --ui-tkc-text: rgba(0, 0, 0, 0.61);
  --ui-tkc-muted: rgba(0, 0, 0, 0.45);
  --ui-tkc-faint: rgba(0, 0, 0, 0.27);
  --ui-tkc-icon: rgba(0, 0, 0, 0.447);
  --ui-tkc-line: rgba(0, 0, 0, 0.06);
  --ui-tkc-rail: rgba(0, 0, 0, 0.08);
  --ui-tkc-fill: rgba(0, 0, 0, 0.06);
  --ui-tkc-wash: rgba(0, 0, 0, 0.03);
  --ui-tkc-accent: rgba(0, 96, 226, 0.765);
  --ui-tkc-shine: rgba(255, 255, 255, 0.82);
  /* Strokes are shadows: a 0.5px hairline plus a soft lift */
  --ui-tkc-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.06), 0 1px 1px -1px rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --ui-tkc-shadow-pop: 0 0 0 0.5px rgba(0, 0, 0, 0.08), 0 12px 28px -10px rgba(0, 0, 0, 0.16), 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --ui-tkc-ring: 0 0 0 0.5px rgba(0, 0, 0, 0.1);
  --ui-tkc-focus: rgba(0, 96, 226, 0.35);
  --ui-tkc-ease: cubic-bezier(0.22, 1, 0.36, 1);

  position: relative;
  box-sizing: border-box;
  container-type: inline-size;
  width: 100%;
  max-width: 440px;
  /* No card: it sits straight on the page */
  font-family: "Inter", "InterVariable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  line-height: 20px;
  font-weight: 400;
  color: var(--ui-tkc-ink);
  -webkit-font-smoothing: antialiased;
}
.ui-thinkc *,
.ui-thinkc *::before,
.ui-thinkc *::after {
  box-sizing: border-box;
}
:where(.ui-thinkc) button { margin: 0; padding: 0; border: 0; background: none; font: inherit; color: inherit; cursor: pointer; }
:where(.ui-thinkc) svg { display: block; flex: none; }
.ui-thinkc button:focus-visible,
.ui-thinkc a:focus-visible {
  outline: 2px solid var(--ui-tkc-focus);
  outline-offset: 1px;
}

/* Header row: pixel mark + "Thinking 4s" / "Worked for 18s" + chevron – only as wide as its words, so only they take the hover */
.ui-thinkc__head {
  display: flex;
  width: fit-content;
  align-items: center;
  gap: 10px;
  max-width: 100%;
  height: 36px;
  padding: 0 8px;
  border-radius: 8px;
  text-align: left;
}
.ui-thinkc__mark {
  display: grid;
  grid-template-columns: repeat(3, 3px);
  grid-auto-rows: 3px;
  gap: 1.5px;
  place-content: center;
  width: 16px;
  height: 16px;
}
.ui-thinkc__mark i {
  border-radius: 0.75px;
  background: var(--ui-tkc-accent);
  animation: ui-thinkc-pixel 1.2s ease-in-out infinite both;
}
.ui-thinkc[data-done] .ui-thinkc__mark i {
  animation: ui-thinkc-settle 420ms var(--ui-tkc-ease) both;
}
.ui-thinkc__title {
  display: inline-flex;
  min-width: 0;
  gap: 8px;
  font-weight: 500;
  white-space: nowrap;
  color: var(--ui-tkc-ink);
  transition: color 160ms ease;
  animation: ui-thinkc-in 420ms var(--ui-tkc-ease) both;
}
/* Hover: no fill – the words just lighten */
.ui-thinkc__head:hover .ui-thinkc__title { color: var(--ui-tkc-muted); }
.ui-thinkc__title .ui-thinkc__shimmer {
  color: var(--ui-tkc-muted);
}
.ui-thinkc__time {
  font-weight: 400;
  font-variant-numeric: tabular-nums;
  color: var(--ui-tkc-faint);
}
/* The chevron sits right after the words and shows on hover (or keyboard focus) */
.ui-thinkc__chevron {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  margin-left: -4px;
  color: var(--ui-tkc-icon);
  opacity: 0;
  transition: opacity 160ms ease;
}
.ui-thinkc__head:is(:hover, :focus-visible) .ui-thinkc__chevron { opacity: 0.6; }
.ui-thinkc__chevron svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.1;
  stroke-linecap: round;
  stroke-linejoin: round;
  transform: rotate(-90deg);
  transition: transform 260ms var(--ui-tkc-ease);
}
.ui-thinkc__head[aria-expanded="true"] .ui-thinkc__chevron svg {
  transform: none;
}


/* Body: folds away under a hairline – only this part animates and clips */
.ui-thinkc__body {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 360ms var(--ui-tkc-ease), opacity 260ms ease;
}
.ui-thinkc__body[data-open="false"] {
  grid-template-rows: 0fr;
  opacity: 0;
}
.ui-thinkc__clip {
  min-height: 0;
  /* clips only while folded, so tooltips can reach out when open */
  overflow: visible;
}
.ui-thinkc__body[data-open="false"] .ui-thinkc__clip {
  overflow: hidden;
}
.ui-thinkc__list {
  margin: 0;
  padding: 8px 8px 0;
  list-style: none;
}

/* Timeline: icon column with a thin rail growing down to the next node */
.ui-thinkc__item {
  position: relative;
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  gap: 10px;
  padding-bottom: 12px;
  animation: ui-thinkc-in 520ms var(--ui-tkc-ease) both;
}
.ui-thinkc__item:not(:last-child)::before {
  content: "";
  position: absolute;
  left: 7.5px;
  top: 22px;
  bottom: 2px;
  width: 1px;
  background: var(--ui-tkc-rail);
  transform-origin: top;
  animation: ui-thinkc-line 520ms var(--ui-tkc-ease) both;
}
.ui-thinkc__node {
  display: grid;
  place-items: center;
  width: 16px;
  height: 20px;
}
.ui-thinkc__globe {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: var(--ui-tkc-icon);
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
/* A finished step is a small gray dot, the running one a blue pixel that pulses */
.ui-thinkc__dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--ui-tkc-faint);
  transition: background-color 300ms ease, border-radius 300ms ease;
}
.ui-thinkc__item[data-active] .ui-thinkc__dot {
  width: 6px;
  height: 6px;
  border-radius: 1.5px;
  background: var(--ui-tkc-accent);
  animation: ui-thinkc-pulse 1s ease-in-out infinite;
}
.ui-thinkc__check {
  width: 16px;
  height: 16px;
  animation: ui-thinkc-pop 460ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
.ui-thinkc__check circle {
  fill: var(--ui-tkc-accent);
}
.ui-thinkc__check path {
  fill: none;
  stroke: #fff;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-dasharray: 9;
  stroke-dashoffset: 9;
  animation: ui-thinkc-draw 360ms var(--ui-tkc-ease) 180ms forwards;
}

.ui-thinkc__content {
  min-width: 0;
}
.ui-thinkc__label {
  position: relative;
  display: inline-block;
  max-width: 100%;
  overflow-wrap: anywhere;
  white-space: pre-line;
  text-align: start;
  color: var(--ui-tkc-text);
  transition: color 300ms ease;
}
/* The running step: gray with a darker band sweeping through */
.ui-thinkc__item[data-active] .ui-thinkc__label {
  color: var(--ui-tkc-muted);
}
.ui-thinkc__item[data-kind="done"] .ui-thinkc__label {
  font-weight: 500;
  color: var(--ui-tkc-ink);
}

/* Sources: small white chips that pop in one after another */
.ui-thinkc__sources {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
  padding: 1px 0 2px;
}
.ui-thinkc__source {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  height: 26px;
  padding: 0 8px 0 6px;
  border-radius: 6px;
  background: var(--ui-tkc-card);
  box-shadow: var(--ui-tkc-shadow);
  font-size: 12px;
  line-height: 16px;
  color: var(--ui-tkc-ink);
  text-decoration: none;
  animation: ui-thinkc-chip 420ms var(--ui-tkc-ease) both;
}
a.ui-thinkc__source,
.ui-thinkc__more {
  position: relative;
  cursor: pointer;
  transition: background-color 160ms ease, color 160ms ease;
}
a.ui-thinkc__source:hover {
  background: var(--ui-tkc-wash);
}
/* "+3 more" – the quiet chip with an inner hairline */
.ui-thinkc .ui-thinkc__more {
  padding: 0 8px;
  background: none;
  box-shadow: inset 0 0 0 0.5px var(--ui-tkc-line);
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-tkc-text);
}
.ui-thinkc .ui-thinkc__more:hover {
  background: var(--ui-tkc-wash);
  color: var(--ui-tkc-ink);
}
.ui-thinkc .ui-thinkc__more[aria-expanded="true"] {
  background: var(--ui-tkc-fill);
  color: var(--ui-tkc-ink);
}

/* Tooltip above the chip – a small white popover */
.ui-thinkc__tip {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 6px);
  z-index: 2;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--ui-tkc-card);
  box-shadow: var(--ui-tkc-shadow-pop);
  color: var(--ui-tkc-text);
  font-size: 12px;
  line-height: 16px;
  width: max-content;
  max-width: min(320px, 80vw);
  overflow-wrap: anywhere;
  pointer-events: none;
  opacity: 0;
  transform: translate(-50%, 4px);
  transition: opacity 140ms ease, transform 200ms var(--ui-tkc-ease);
}
.ui-thinkc__source:hover .ui-thinkc__tip,
.ui-thinkc__source:focus-visible .ui-thinkc__tip {
  opacity: 1;
  transform: translate(-50%, 0);
  transition-delay: 250ms;
}

.ui-thinkc__source[data-count] {
  padding: 0 8px;
  background: none;
  box-shadow: inset 0 0 0 0.5px var(--ui-tkc-line);
  color: var(--ui-tkc-text);
}
.ui-thinkc__source-label {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ui-thinkc__favicon img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.ui-thinkc__favicon {
  display: grid;
  place-items: center;
  flex: none;
  width: 14px;
  height: 14px;
  border-radius: 4px;
  overflow: hidden;
  box-shadow: var(--ui-tkc-ring);
}
.ui-thinkc__favicon svg {
  width: 100%;
  height: 100%;
}

/* Shimmer over the working label – a darker band runs through the gray text */
.ui-thinkc__shimmer {
  position: relative;
}
.ui-thinkc__shimmer::after {
  content: attr(data-text);
  content: attr(data-text) / "";
  position: absolute;
  inset: 0;
  /* wraps exactly like the text below it, so a long label keeps its sweep inside the card */
  white-space: inherit;
  overflow-wrap: inherit;
  color: transparent;
  background: linear-gradient(90deg, transparent 38%, var(--ui-tkc-shine) 50%, transparent 62%) 100% 0 / 300% 100%
    no-repeat;
  -webkit-background-clip: text;
  background-clip: text;
  animation: ui-thinkc-sweep 1.6s linear infinite;
  pointer-events: none;
}

@keyframes ui-thinkc-in {
  from { opacity: 0; transform: translateY(6px); filter: blur(3px); }
  to { opacity: 1; transform: none; filter: none; }
}
@keyframes ui-thinkc-line {
  from { transform: scaleY(0); }
  to { transform: scaleY(1); }
}
@keyframes ui-thinkc-chip {
  from { opacity: 0; transform: translateY(4px) scale(0.92); }
  to { opacity: 1; transform: none; }
}
@keyframes ui-thinkc-pulse {
  50% { transform: scale(0.7); opacity: 0.45; }
}
@keyframes ui-thinkc-pixel {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.2; }
}
@keyframes ui-thinkc-settle {
  from { opacity: 0.2; transform: scale(0.6); }
  to { opacity: 1; transform: none; }
}
@keyframes ui-thinkc-pop {
  0% { transform: scale(0.5); }
  60% { transform: scale(1.12); }
  100% { transform: scale(1); }
}
@keyframes ui-thinkc-draw {
  to { stroke-dashoffset: 0; }
}
@keyframes ui-thinkc-sweep {
  from { background-position: 100% 0; }
  to { background-position: 0% 0; }
}

/* Narrow (phones) */
@container (max-width: 360px) {
  .ui-thinkc__head { padding: 0 8px; }
  .ui-thinkc__list { padding: 8px 8px 0; }
}
/* Touch screens: bigger tap targets */
@media (pointer: coarse) {
  .ui-thinkc__head { height: 52px; }
  .ui-thinkc__source { height: 32px; }
}
@media (prefers-reduced-motion: reduce) {
  .ui-thinkc *,
  .ui-thinkc *::before,
  .ui-thinkc *::after {
    animation-duration: 1ms !important;
    animation-delay: 0ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 1ms !important;
  }
  .ui-thinkc__shimmer::after {
    display: none;
  }
  .ui-thinkc__check path {
    stroke-dashoffset: 0;
  }
}

/* Dark mode: follows a .dark class or data-theme="dark" on any ancestor, e.g. <html> */
:where(.dark, [data-theme="dark"]) .ui-thinkc {
  --ui-tkc-card: #1c1c1e;
  --ui-tkc-ink: rgba(255, 255, 255, 0.9);
  --ui-tkc-strong: #ffffff;
  --ui-tkc-text: rgba(255, 255, 255, 0.62);
  --ui-tkc-muted: rgba(255, 255, 255, 0.46);
  --ui-tkc-faint: rgba(255, 255, 255, 0.3);
  --ui-tkc-icon: rgba(255, 255, 255, 0.5);
  --ui-tkc-line: rgba(255, 255, 255, 0.08);
  --ui-tkc-rail: rgba(255, 255, 255, 0.1);
  --ui-tkc-fill: rgba(255, 255, 255, 0.08);
  --ui-tkc-wash: rgba(255, 255, 255, 0.04);
  --ui-tkc-accent: #4d8dff;
  --ui-tkc-shine: #ffffff;
  --ui-tkc-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.4);
  --ui-tkc-shadow-pop: 0 0 0 0.5px rgba(255, 255, 255, 0.12), 0 12px 28px -10px rgba(0, 0, 0, 0.6);
  --ui-tkc-ring: 0 0 0 0.5px rgba(255, 255, 255, 0.14);
  --ui-tkc-focus: rgba(77, 141, 255, 0.5);
}
:where(.dark, [data-theme="dark"]) .ui-thinkc__tip {
  background: #232326;
}
`;
