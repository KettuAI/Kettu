// affectUI Pro - licensed under https://www.affectui.com/license, not under this project's open-source license. Don't copy it out of this project.
"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

/*
 * Experiment Card (Clean) – an A/B test in two lines that quietly unfolds into the full comparison, in one self-contained file.
 * Clean style: no tray – one white card with hairline shadows, quiet gray type, tinted chips and a last row for the action.
 * Closed, it shows the test, its status and who is ahead, next to a tiny column chart with one column per variant.
 * Hovering (or tapping) unfolds the variants below – the head stays where it is. Inside the open card:
 *   · hover a variant and its column lights up in the head (and the other way round)
 *   · switch the metric and every number rolls, the bars and columns glide, the leader chip follows
 *   · click a variant to pick it as the winner – the action in the last row appears with its name
 *   · the last row of the card always says what you are pointing at: visitors and confidence
 * With kind="choice" it asks a question instead: the rows are answers with a second line and no numbers, one or
 * several can be picked, a last row takes an answer of your own, digits pick and ⌘↵ runs the action.
 * The styles are injected below, so no extra files are needed.
 */

export type ExperimentTone = "red" | "amber" | "green" | "blue" | "violet" | "gray";

export type ExperimentMetric = {
  id: string;
  label: string;
  /** Formats a value of this metric, e.g. (n) => `${n.toFixed(1)}%` */
  format?: (value: number) => string;
  /** Set when a smaller number wins, e.g. bounce rate or cost */
  lowerIsBetter?: boolean;
};

export type ExperimentVariant = {
  id: string;
  /** Short key shown in the badge and the chart, e.g. "A" */
  key: string;
  name: string;
  /** The baseline every lift is measured against – defaults to the first variant */
  control?: boolean;
  visitors?: number;
  /** One number per metric id – an answer of a question has none */
  values?: Record<string, number>;
  /** A second line under the name – for the answers of a question */
  description?: string;
  /** Confidence against the control in percent, per metric id */
  confidence?: Record<string, number>;
  /** Any CSS color – defaults to gray for the control, then blue, violet, amber */
  color?: string;
};

export type ExperimentCardProps = {
  title: string;
  variants: ExperimentVariant[];
  metrics: ExperimentMetric[];
  /** Controlled metric id */
  metric?: string;
  defaultMetric?: string;
  onMetricChange?: (id: string) => void;
  /** Controlled id of the variant picked as the winner */
  winner?: string | null;
  defaultWinner?: string | null;
  onWinnerChange?: (id: string | null) => void;
  /** The tag under the title, e.g. { label: "Running", tone: "green" } */
  status?: { label: string; tone?: ExperimentTone };
  /** Short text next to the status, e.g. "Day 9 of 14" */
  note?: string;
  /** The button that appears in the last row once a winner is picked. `label` gets the picked variant */
  action?: { label: string | ((variant: ExperimentVariant) => string); onClick: (variant: ExperimentVariant) => void };
  /** Replaces the line in the last row while nothing is hovered or picked */
  hint?: ReactNode;
  /** "hover" opens under the pointer (taps and the keyboard still toggle), "click" only on click */
  trigger?: "hover" | "click";
  /** Controlled open state */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** "choice" asks a question: the rows are answers with a second line, no numbers, bars or chart */
  kind?: "experiment" | "choice";
  /** Pick several – the rows become checkboxes and the picks an array */
  multiple?: boolean;
  /** Controlled picks when `multiple` */
  picks?: string[];
  defaultPicks?: string[];
  onPicksChange?: (ids: string[]) => void;
  /** A last row to type an answer of your own into: picked like an answer (its `id`, default "other") once the
   * field is clicked, and let go again when it is left empty */
  other?: { id?: string; placeholder: string; value?: string; onChange?: (text: string) => void };
  /** Your own mark in the head, in place of the chart */
  mark?: ReactNode;
  /** Your own chip at the end of the head, in place of who is ahead – null leaves it out */
  lead?: ReactNode | null;
  /** A quiet button before the action, e.g. Skip */
  secondary?: { label: string; onClick: () => void };
  /** Show the action before anything is picked – e.g. for a step that only reviews */
  actionReady?: boolean;
  /** Close on a press outside the card – defaults to true */
  closeOnOutside?: boolean;
  /** Name of the switch above the rows, for screen readers – defaults to "Metric" */
  switchLabel?: string;
  className?: string;
};

/* ---------- Helpers ---------- */

const PALETTE = ["var(--ui-xcc-c1)", "var(--ui-xcc-c2)", "var(--ui-xcc-c3)", "var(--ui-xcc-c4)"];
const defaultFormat = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(n);
const whole = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
const tenth = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
/** NaN and Infinity count as "no value" */
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const ease = (t: number) => 1 - Math.pow(1 - t, 4);
const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Rolls a set of named numbers from where they are to their targets, in one animation frame loop */
function useRolling(target: Record<string, number>, duration: number) {
  const [shown, setShown] = useState(target);
  const current = useRef(target);
  const signature = JSON.stringify(target);
  useEffect(() => {
    const to = JSON.parse(signature) as Record<string, number>;
    const from = { ...current.current };
    if (reduced() || Object.keys(to).every((k) => from[k] === to[k])) {
      current.current = to;
      setShown(to);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const e = ease(t);
      const next: Record<string, number> = {};
      for (const k in to) next[k] = (from[k] ?? to[k]) + (to[k] - (from[k] ?? to[k])) * e;
      current.current = next;
      setShown(next);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [signature, duration]);
  return shown;
}

/* ---------- Icons ---------- */

const line = { stroke: "currentColor", strokeWidth: 1.1, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const CheckIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="m3 6.2 2 2 4-4.4" {...line} strokeWidth={1.5} />
  </svg>
);
/** A picked single answer: the dot of a radio button */
const DotIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <circle cx="6" cy="6" r="2.5" fill="currentColor" />
  </svg>
);
const ArrowIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M3.5 8h9M9 4.5 12.5 8 9 11.5" {...line} strokeWidth={1.2} />
  </svg>
);
const TrendIcon = ({ down }: { down?: boolean }) => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" style={down ? { transform: "scaleY(-1)" } : undefined}>
    <path d="M1.5 8.5 4.5 5.5l2 2 4-4M8 3.5h2.5V6" {...line} strokeWidth={1.2} />
  </svg>
);
/** Status: a solid dot in a soft ring */
const PulseIcon = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
    <circle cx="5" cy="5" r="4.5" fill="currentColor" opacity="0.22" />
    <circle cx="5" cy="5" r="2.25" fill="currentColor" />
  </svg>
);

export function ExperimentCard({
  title,
  variants,
  metrics,
  metric,
  defaultMetric,
  onMetricChange,
  winner,
  defaultWinner = null,
  onWinnerChange,
  status,
  note,
  action,
  hint,
  trigger = "hover",
  open,
  defaultOpen = false,
  onOpenChange,
  kind = "experiment",
  multiple = false,
  picks,
  defaultPicks,
  onPicksChange,
  other,
  mark,
  lead,
  secondary,
  actionReady = false,
  closeOnOutside = true,
  switchLabel = "Metric",
  className,
}: ExperimentCardProps) {
  const choice = kind === "choice";
  const [innerPicks, setInnerPicks] = useState<string[]>(defaultPicks ?? []);
  const pickIds = picks ?? innerPicks;
  const [innerOther, setInnerOther] = useState("");
  const otherText = other?.value ?? innerOther;
  const otherKey = String(variants.length + 1);
  const otherId = other?.id ?? "other";
  const uid = useId();
  const [innerOpen, setInnerOpen] = useState(defaultOpen);
  const isOpen = open ?? innerOpen;
  const [innerMetric, setInnerMetric] = useState(defaultMetric ?? metrics[0]?.id);
  const metricNow = metrics.find((m) => m.id === (metric ?? innerMetric)) ?? metrics[0];
  const [innerWinner, setInnerWinner] = useState<string | null>(defaultWinner);
  const winnerId = winner !== undefined ? winner : innerWinner;
  /** The variant under the pointer (row or column) */
  const [hot, setHot] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const format = metricNow?.format ?? defaultFormat;
  const lower = Boolean(metricNow?.lowerIsBetter);
  const has = (v: ExperimentVariant) => finite(v.values?.[metricNow?.id ?? ""]);
  const valueOf = (v: ExperimentVariant) => (has(v) ? (v.values?.[metricNow?.id ?? ""] ?? 0) : 0);
  const control = variants.find((v) => v.control) ?? variants[0];
  const base = control && has(control) ? valueOf(control) : 0;
  /** Change against the control in percent, as measured – null without a value or a baseline to compare with */
  const changeOf = (v: ExperimentVariant) => (has(v) && base ? ((valueOf(v) - base) / Math.abs(base)) * 100 : null);
  /** The same change counted as "how much better": flipped for metrics where less is better */
  const liftOf = (v: ExperimentVariant) => {
    const change = changeOf(v);
    return change === null ? null : change * (lower ? -1 : 1);
  };
  const signed = (n: number) => {
    const r = Math.round(n * 10) / 10;
    return `${r >= 0 ? "+" : "−"}${tenth.format(Math.abs(r))}%`;
  };
  const leader = variants.reduce<ExperimentVariant | undefined>((best, v) => (!best || (liftOf(v) ?? -Infinity) > (liftOf(best) ?? -Infinity) ? v : best), undefined);
  const known = variants.filter(has).map(valueOf);
  const max = Math.max(...known, 0.0001);
  const min = known.length ? Math.min(...known) : 0;
  /** Column height in the head chart: stretched between the smallest and the largest value, so small gaps stay visible */
  const columnOf = (v: ExperimentVariant) => (!has(v) ? 0.1 : max > min ? 0.38 + 0.62 * ((valueOf(v) - min) / (max - min)) : 0.7);
  // The answers of a question share one color; a test's variants each get their own
  const colorOf = (v: ExperimentVariant) =>
    v.color ?? (choice ? "var(--ui-xcc-c1)" : v === control ? "var(--ui-xcc-c0)" : PALETTE[variants.filter((x) => x !== control).indexOf(v) % PALETTE.length]);

  // Numbers roll when the metric changes
  const shown = useRolling(Object.fromEntries(variants.map((v) => [v.id, valueOf(v)])), 620);

  /* ---------- Opening and closing ---------- */

  const timer = useRef(0);
  const change = (next: boolean) => {
    window.clearTimeout(timer.current);
    if (next === isOpen) return;
    if (!next) setHot(null);
    setInnerOpen(next);
    onOpenChange?.(next);
  };
  const later = (next: boolean, ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => change(next), ms);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const hover = trigger === "hover";
  const onEnter = (e: PointerEvent) => {
    if (hover && e.pointerType === "mouse") later(true, 90);
  };
  const onLeave = (e: PointerEvent) => {
    if (hover && e.pointerType === "mouse") later(false, 220);
  };

  // While open, a press outside closes it
  useEffect(() => {
    if (!isOpen || !closeOnOutside) return;
    const down = (e: globalThis.PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) change(false);
    };
    document.addEventListener("pointerdown", down);
    return () => document.removeEventListener("pointerdown", down);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const onKeyDown = (e: KeyboardEvent) => {
    if (choice && isOpen) {
      const typing = (e.target as HTMLElement).tagName === "INPUT";
      // ⌘↵ runs the action, a digit picks its answer, the next digit goes to the row of your own
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && action && ready) {
        e.preventDefault();
        action.onClick(picked ?? variants[0]);
        return;
      }
      if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const hit = variants.find((v) => v.key === e.key);
        if (hit) {
          e.preventDefault();
          pick(hit.id);
          return;
        }
        if (other && e.key === otherKey) {
          e.preventDefault();
          rootRef.current?.querySelector<HTMLInputElement>(".ui-xcc__input")?.focus();
          return;
        }
      }
    }
    if (e.key !== "Escape" || !isOpen) return;
    e.stopPropagation();
    change(false);
    rootRef.current?.querySelector<HTMLElement>(".ui-xcc__toggle")?.focus({ preventScroll: true });
  };

  /* ---------- Metric switch ---------- */

  const switchRef = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const el = switchRef.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    if (!el) return;
    setPill({ left: el.offsetLeft, width: el.offsetWidth });
    // Many or long metrics scroll sideways – keep the chosen one in view
    const sw = switchRef.current!;
    if (el.offsetLeft < sw.scrollLeft) sw.scrollLeft = el.offsetLeft;
    else if (el.offsetLeft + el.offsetWidth > sw.scrollLeft + sw.clientWidth) sw.scrollLeft = el.offsetLeft + el.offsetWidth - sw.clientWidth;
  }, [metricNow?.id, metrics.length, isOpen]);

  const setMetric = (id: string) => {
    setInnerMetric(id);
    onMetricChange?.(id);
  };
  const onSwitchKey = (e: KeyboardEvent) => {
    const i = metrics.findIndex((m) => m.id === metricNow?.id);
    const to = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? metrics.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    const next = metrics[(to + metrics.length) % metrics.length];
    setMetric(next.id);
    requestAnimationFrame(() => switchRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
  };

  const pick = (id: string) => {
    if (multiple) {
      const next = pickIds.includes(id) ? pickIds.filter((x) => x !== id) : [...pickIds, id];
      setInnerPicks(next);
      onPicksChange?.(next);
      return;
    }
    const next = winnerId === id ? null : id;
    setInnerWinner(next);
    onWinnerChange?.(next);
  };
  const isPicked = (v: ExperimentVariant) => (multiple ? pickIds.includes(v.id) : winnerId === v.id);
  const otherOn = Boolean(other) && (multiple ? pickIds.includes(otherId) : winnerId === otherId);
  const setOther = (text: string) => {
    setInnerOther(text);
    other?.onChange?.(text);
  };

  /* ---------- What the head and the last row say ---------- */

  const ahead = leader && leader !== control && (liftOf(leader) ?? 0) > 0 ? leader : null;
  const aheadChange = ahead ? (changeOf(ahead) ?? 0) : 0;
  const picked = (multiple ? variants.find((v) => pickIds.includes(v.id)) : variants.find((v) => v.id === winnerId)) ?? null;
  const hotVariant = variants.find((v) => v.id === hot) ?? null;
  const about = choice ? null : hotVariant;
  const chosen = multiple ? variants.filter((v) => pickIds.includes(v.id)).length : picked ? 1 : 0;
  // Your own answer counts once it has words
  const own = otherOn && otherText.trim() !== "";
  const ready = choice ? chosen > 0 || own || actionReady : Boolean(picked);
  let caption: ReactNode = hint ?? (picked ? null : choice ? (multiple ? "Pick any that apply" : "Pick one") : "Pick a winner");
  let captionKey = "rest";
  if (choice) {
    // A step that only reviews keeps its hint; elsewhere the last row counts the picks
    if (actionReady) {
      // keep the hint
    } else if (multiple && chosen + (own ? 1 : 0) > 0) {
      caption = `${chosen + (own ? 1 : 0)} picked`;
      captionKey = `picks-${chosen}-${own}`;
    } else if (!multiple && picked) {
      caption = <b>{picked.name}</b>;
      captionKey = `picked-${picked.id}`;
    } else if (own) {
      caption = "Your own answer";
      captionKey = "own";
    } else if (otherOn) {
      caption = "Type your answer";
      captionKey = "typing";
    }
  } else if (about) {
    const conf = about.confidence?.[metricNow?.id ?? ""];
    caption = (
      <>
        <b>{about.key}</b>
        {finite(about.visitors) && (
          <>
            {" "}· {whole(about.visitors)} {about.visitors === 1 ? "visitor" : "visitors"}
          </>
        )}
        {about === control ? <> · baseline</> : finite(conf) && <> · {whole(conf)}% confidence</>}
      </>
    );
    captionKey = `hot-${about.id}-${metricNow?.id}`;
  } else if (picked) {
    caption = (
      <>
        <b>{picked.name}</b> picked
      </>
    );
    captionKey = `picked-${picked.id}`;
  }
  const actionFor = picked ?? variants[0];
  const actionLabel = ready && action && actionFor ? (typeof action.label === "function" ? action.label(actionFor) : action.label) : null;

  return (
    <div
      ref={rootRef}
      className={["ui-xcc", className].filter(Boolean).join(" ")}
      data-open={isOpen ? "" : undefined}
      data-kind={kind}
      data-multiple={multiple ? "" : undefined}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onKeyDown={onKeyDown}
    >
      <style href="ui-experiment-card-clean" precedence="default">
        {css}
      </style>

      <div className="ui-xcc__card">
        <div className="ui-xcc__head">
          {/* The whole head toggles; the chart on top of it only reacts once the card is open */}
          <button
            type="button"
            className="ui-xcc__toggle"
            aria-expanded={isOpen}
            aria-controls={`${uid}-body`}
            aria-label={`${title}${status ? `, ${status.label}` : ""}${ahead ? `, ${ahead.name} is ahead by ${tenth.format(Math.abs(aheadChange))} percent` : ""}`}
            onClick={() => change(!isOpen)}
          />

          {mark ? (
            <span className="ui-xcc__mark" aria-hidden="true">
              {mark}
            </span>
          ) : (
          /* One column per variant – the same numbers as the rows below, small */
          <span className="ui-xcc__chart" aria-hidden="true" data-many={variants.length > 5 ? "" : undefined} onPointerLeave={() => setHot(null)}>
            {variants.map((v) => (
              <span
                key={v.id}
                className="ui-xcc__col"
                data-hot={hot === v.id ? "" : undefined}
                data-dim={hot && hot !== v.id ? "" : undefined}
                data-picked={winnerId === v.id ? "" : undefined}
                data-passed={winnerId && winnerId !== v.id ? "" : undefined}
                style={{ ["--ui-xcc-color" as string]: colorOf(v), ["--ui-xcc-size" as string]: columnOf(v) }}
                onPointerEnter={(e) => e.pointerType === "mouse" && setHot(v.id)}
                onClick={() => pick(v.id)}
              />
            ))}
          </span>
          )}

          <span className="ui-xcc__titles">
            <span className="ui-xcc__name" dir="auto" title={title}>
              {title}
            </span>
            <span className="ui-xcc__sub">
              {status && (
                <span className="ui-xcc__tag" data-tone={status.tone ?? "gray"} title={status.label}>
                  <PulseIcon />
                  <span className="ui-xcc__tag-text">{status.label}</span>
                </span>
              )}
              {note && (
                <span className="ui-xcc__note" dir="auto" title={note}>
                  {note}
                </span>
              )}
            </span>
          </span>

          {lead !== undefined ? (
            lead
          ) : ahead ? (
            <span className="ui-xcc__lead" data-tone="green" key={`${ahead.id}-${metricNow?.id}`}>
              <b>{ahead.key}</b>
              <TrendIcon down={aheadChange < 0} />
              {signed(aheadChange)}
            </span>
          ) : (
            <span className="ui-xcc__lead" data-tone="gray" key={`none-${metricNow?.id}`}>
              No lift yet
            </span>
          )}
        </div>

        <div id={`${uid}-body`} className="ui-xcc__fold" inert={!isOpen}>
          <div className="ui-xcc__clip">
            <div className="ui-xcc__body">
              {metrics.length > 1 && (
                <div ref={switchRef} className="ui-xcc__switch" role="radiogroup" aria-label={switchLabel} onKeyDown={onSwitchKey}>
                  {pill && <span className="ui-xcc__thumb" style={{ transform: `translateX(${pill.left}px)`, width: pill.width }} />}
                  {metrics.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      role="radio"
                      aria-checked={m.id === metricNow?.id}
                      tabIndex={m.id === metricNow?.id ? 0 : -1}
                      className="ui-xcc__metric"
                      onClick={() => setMetric(m.id)}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              )}

              <div className="ui-xcc__rows" role={multiple ? "group" : "radiogroup"} aria-label={choice ? title : "Winner"} onPointerLeave={() => setHot(null)}>
                {variants.map((v) => {
                  const lift = liftOf(v);
                  const change = changeOf(v);
                  const isControl = v === control;
                  return (
                    <button
                      key={v.id}
                      type="button"
                      role={multiple ? "checkbox" : "radio"}
                      aria-checked={isPicked(v)}
                      aria-label={
                        choice
                          ? `${v.name}${v.description ? `, ${v.description}` : ""}`
                          : `${v.name}: ${has(v) ? format(valueOf(v)) : "no value"}${isControl ? ", baseline" : change === null ? "" : `, ${change >= 0 ? "up" : "down"} ${tenth.format(Math.abs(change))} percent`}`
                      }
                      className="ui-xcc__row"
                      data-hot={hot === v.id ? "" : undefined}
                      data-dim={hot && hot !== v.id ? "" : undefined}
                      style={{ ["--ui-xcc-color" as string]: colorOf(v) }}
                      onPointerEnter={(e) => e.pointerType === "mouse" && setHot(v.id)}
                      onFocus={() => setHot(v.id)}
                      onBlur={() => setHot(null)}
                      onClick={() => pick(v.id)}
                    >
                      <span className="ui-xcc__badge">
                        <span title={v.key}>{v.key}</span>
                        {choice && !multiple ? <DotIcon /> : <CheckIcon />}
                      </span>
                      <span className="ui-xcc__label" dir="auto" title={v.name}>
                        {v.name}
                      </span>
                      {choice ? (
                        v.description && (
                          <span className="ui-xcc__desc" dir="auto">
                            {v.description}
                          </span>
                        )
                      ) : (
                        <>
                      <span className="ui-xcc__value">{has(v) ? format(shown[v.id] ?? valueOf(v)) : "—"}</span>
                      {isControl ? (
                        <span className="ui-xcc__lift" data-tone="gray">
                          Base
                        </span>
                      ) : (
                        <span className="ui-xcc__lift" data-tone={lift === null ? "gray" : lift > 0.05 ? "green" : lift < -0.05 ? "red" : "gray"}>
                          {change === null ? "—" : signed(change)}
                        </span>
                      )}
                      <span className="ui-xcc__track">
                        <span className="ui-xcc__bar" style={{ transform: `scaleX(${has(v) ? Math.max(0.02, valueOf(v) / max) : 0.02})` }} />
                      </span>
                        </>
                      )}
                    </button>
                  );
                })}
                {other && (
                  // The answer of your own: picked once it has text
                  <label className="ui-xcc__row ui-xcc__other" data-picked={otherOn ? "" : undefined} style={{ ["--ui-xcc-color" as string]: "var(--ui-xcc-c1)" }}>
                    <span className="ui-xcc__badge">
                      <span>{otherKey}</span>
                      {multiple ? <CheckIcon /> : <DotIcon />}
                    </span>
                    <input
                      className="ui-xcc__input"
                      value={otherText}
                      placeholder={other.placeholder}
                      aria-label={other.placeholder}
                      // Clicking into the field picks it, leaving it empty lets it go
                      onFocus={() => !otherOn && pick(otherId)}
                      onBlur={() => otherOn && !otherText.trim() && pick(otherId)}
                      onChange={(e) => setOther(e.target.value)}
                    />
                  </label>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* The last row of the card: it says what you are pointing at, and holds the action once a winner is picked */}
        <div className="ui-xcc__fold" inert={!isOpen}>
          <div className="ui-xcc__clip">
            <div className="ui-xcc__foot">
              <span className="ui-xcc__caption" aria-live="polite">
                <span key={captionKey}>{caption}</span>
              </span>
              {secondary && (
                <button type="button" className="ui-xcc__secondary" onClick={secondary.onClick}>
                  {secondary.label}
                </button>
              )}
              {ready && action && actionFor && (
                <button type="button" className="ui-xcc__action" key={choice ? "action" : actionFor.id} title={actionLabel ?? undefined} onClick={() => action.onClick(actionFor)}>
                  <span className="ui-xcc__action-text">{actionLabel}</span>
                  {choice && <kbd className="ui-xcc__kbd">⌘↵</kbd>}
                  {!choice && <ArrowIcon />}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Styles ---------- */

const css = /* css */ `
/* Colors and motion as variables – override them on .ui-xcc */
.ui-xcc {
  --ui-xcc-card: #ffffff;
  --ui-xcc-ink: rgba(0, 0, 0, 0.88);
  --ui-xcc-strong: #000000;
  --ui-xcc-text: rgba(0, 0, 0, 0.61);
  --ui-xcc-muted: rgba(0, 0, 0, 0.45);
  --ui-xcc-faint: rgba(0, 0, 0, 0.27);
  --ui-xcc-icon: rgba(0, 0, 0, 0.447);
  --ui-xcc-line: rgba(0, 0, 0, 0.06);
  --ui-xcc-fill: rgba(0, 0, 0, 0.06);
  --ui-xcc-wash: rgba(0, 0, 0, 0.03);
  --ui-xcc-track: rgba(0, 0, 0, 0.06);
  --ui-xcc-pick: rgba(0, 96, 226, 0.05);
  --ui-xcc-pick-line: rgba(0, 96, 226, 0.35);
  --ui-xcc-tile-line: rgba(0, 0, 0, 0.1);
  --ui-xcc-primary: rgba(0, 0, 0, 0.88);
  --ui-xcc-on-primary: #fcfcfc;
  --ui-xcc-c0: rgba(0, 0, 0, 0.22);
  --ui-xcc-c1: rgba(0, 96, 226, 0.765);
  --ui-xcc-c2: #5b5bd6;
  --ui-xcc-c3: #e8a20c;
  --ui-xcc-c4: #1a9a52;
  /* Strokes are shadows: a 0.5px hairline plus a soft lift */
  --ui-xcc-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.06), 0 1px 1px -1px rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --ui-xcc-focus: rgba(0, 96, 226, 0.35);
  --ui-xcc-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --ui-xcc-time: 520ms;
  box-sizing: border-box;
  width: 100%;
  max-width: 340px;
  container-type: inline-size;
  font-family: "Inter", "InterVariable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  line-height: 20px;
  font-weight: 400;
  color: var(--ui-xcc-ink);
  text-align: left;
  -webkit-font-smoothing: antialiased;
}
.ui-xcc *, .ui-xcc *::before, .ui-xcc *::after { box-sizing: border-box; }
:where(.ui-xcc) button { margin: 0; padding: 0; border: 0; background: none; font: inherit; color: inherit; text-align: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }
.ui-xcc button:focus-visible { outline: 2px solid var(--ui-xcc-focus); outline-offset: 1px; }
:where(.ui-xcc) svg { display: block; flex: none; }
.ui-xcc b { font-weight: 500; color: var(--ui-xcc-ink); }

/* Tags and lifts: colored text on a light fill of the same color */
.ui-xcc [data-tone="red"] { --ui-xcc-tag: #d93d42; --ui-xcc-tag-bg: rgba(229, 72, 77, 0.08); }
.ui-xcc [data-tone="amber"] { --ui-xcc-tag: #a86f00; --ui-xcc-tag-bg: rgba(232, 162, 12, 0.1); }
.ui-xcc [data-tone="green"] { --ui-xcc-tag: #1a9a52; --ui-xcc-tag-bg: rgba(26, 154, 82, 0.08); }
.ui-xcc [data-tone="blue"] { --ui-xcc-tag: rgba(0, 96, 226, 0.9); --ui-xcc-tag-bg: rgba(0, 96, 226, 0.06); }
.ui-xcc [data-tone="violet"] { --ui-xcc-tag: #5b5bd6; --ui-xcc-tag-bg: rgba(91, 91, 214, 0.08); }
.ui-xcc [data-tone="gray"] { --ui-xcc-tag: rgba(0, 0, 0, 0.61); --ui-xcc-tag-bg: rgba(0, 0, 0, 0.05); }

/* One white card – the edge is a shadow, not a border */
.ui-xcc__card { border-radius: 10px; background: var(--ui-xcc-card); box-shadow: var(--ui-xcc-shadow); }

/* Everything that opens does it the same quiet way: it unfolds and fades, nothing travels */
.ui-xcc__fold { display: grid; grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows var(--ui-xcc-time) var(--ui-xcc-ease), opacity 260ms ease; }
.ui-xcc__clip { min-height: 0; overflow: hidden; }
.ui-xcc[data-open] > .ui-xcc__card > .ui-xcc__fold { grid-template-rows: 1fr; opacity: 1; transition: grid-template-rows var(--ui-xcc-time) var(--ui-xcc-ease), opacity 380ms ease 120ms; }

/* ----- Head: the same in both states ----- */
.ui-xcc__head { position: relative; display: flex; align-items: center; gap: 10px; padding: 12px; }
.ui-xcc__toggle { position: absolute; inset: 0; border-radius: 10px; }
.ui-xcc__head > :not(.ui-xcc__toggle) { position: relative; pointer-events: none; }
.ui-xcc[data-open] .ui-xcc__chart { pointer-events: auto; }
.ui-xcc__chart { overflow: hidden; }
.ui-xcc__chart[data-many] { gap: 1px; }

.ui-xcc__chart { display: flex; flex: none; align-items: flex-end; justify-content: center; gap: 3px; width: 36px; height: 36px; padding: 7px 6px 6px; border-radius: 8px; background: var(--ui-xcc-wash); box-shadow: inset 0 0 0 0.5px var(--ui-xcc-line); }
.ui-xcc__col { flex: 1; max-width: 6px; height: calc(var(--ui-xcc-size) * 100%); border-radius: 1.5px; background: var(--ui-xcc-color); cursor: pointer; transition: height 620ms var(--ui-xcc-ease), opacity 220ms ease, transform 260ms var(--ui-xcc-ease); transform-origin: 50% 100%; }
.ui-xcc__col[data-hot] { transform: scaleX(1.25); }
.ui-xcc__col[data-dim] { opacity: 0.3; }
.ui-xcc__col[data-passed]:not([data-hot]) { opacity: 0.35; }

.ui-xcc__titles { display: grid; grid-template-columns: minmax(0, 1fr); flex: 1; min-width: 0; }
.ui-xcc__name { overflow: hidden; text-align: start; font-size: 13px; line-height: 20px; font-weight: 500; color: var(--ui-xcc-strong); white-space: nowrap; text-overflow: ellipsis; }
.ui-xcc__sub { display: flex; align-items: center; gap: 6px; min-width: 0; height: 20px; overflow: hidden; font-size: 12px; line-height: 16px; color: var(--ui-xcc-muted); white-space: nowrap; }
.ui-xcc__tag { display: inline-flex; flex: none; max-width: 100%; min-width: 0; align-items: center; gap: 5px; height: 20px; padding: 0 6px 0 5px; border-radius: 5px; background: var(--ui-xcc-tag-bg); font-size: 12px; font-weight: 500; color: var(--ui-xcc-tag); }
.ui-xcc__tag-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ui-xcc__note { min-width: 0; overflow: hidden; text-align: start; text-overflow: ellipsis; }
.ui-xcc__lead { display: inline-flex; flex: none; align-items: center; gap: 4px; height: 24px; padding: 0 7px; border-radius: 6px; background: var(--ui-xcc-tag-bg); font-size: 12px; line-height: 16px; font-weight: 500; color: var(--ui-xcc-tag); white-space: nowrap; font-variant-numeric: tabular-nums; animation: ui-xcc-pop 360ms var(--ui-xcc-ease) both; }
.ui-xcc__lead b { color: inherit; }

/* ----- Body ----- */
.ui-xcc__body { padding: 0 12px 10px; }

/* Metric switch: the tab-button look – a soft fill marks the active one */
.ui-xcc__switch { position: relative; display: flex; gap: 4px; }
/* Many or long metrics scroll sideways; the padding keeps the focus ring visible */
.ui-xcc__switch { margin: -3px; padding: 3px; overflow-x: auto; scrollbar-width: none; }
.ui-xcc__switch::-webkit-scrollbar { display: none; }
.ui-xcc__thumb { position: absolute; top: 3px; left: 0; height: calc(100% - 6px); border-radius: 6px; background: var(--ui-xcc-fill); transition: transform 90ms ease-out, width 90ms ease-out; }
.ui-xcc__metric { position: relative; height: 28px; padding: 4px 10px; border-radius: 6px; box-shadow: inset 0 0 0 0.5px var(--ui-xcc-line); font-size: 13px; line-height: 20px; font-weight: 500; color: var(--ui-xcc-text); text-align: center; white-space: nowrap; transition: color 140ms ease, background-color 140ms ease; }
.ui-xcc__metric:hover { background: var(--ui-xcc-wash); color: var(--ui-xcc-ink); }
.ui-xcc__metric[aria-checked="true"] { background: none; color: var(--ui-xcc-ink); }

.ui-xcc__rows { display: grid; gap: 2px; margin-top: 8px; }
.ui-xcc__row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; column-gap: 8px; row-gap: 6px; width: calc(100% + 12px); margin: 0 -6px; padding: 7px 6px 8px; border-radius: 6px; transition: background-color 120ms ease-out, opacity 220ms ease, box-shadow 160ms ease; }
.ui-xcc__row[data-hot] { background: var(--ui-xcc-wash); }
.ui-xcc__row[data-dim] { opacity: 0.55; }
.ui-xcc__row[aria-checked="true"] { background: var(--ui-xcc-pick); box-shadow: 0 0 0 0.5px var(--ui-xcc-pick-line); }
.ui-xcc__badge { display: grid; place-items: center; min-width: 20px; max-width: 56px; padding: 0 4px; height: 20px; border-radius: 5px; background: color-mix(in srgb, var(--ui-xcc-color) 14%, transparent); font-size: 11px; font-weight: 500; line-height: 1; color: color-mix(in srgb, var(--ui-xcc-color) 80%, var(--ui-xcc-strong)); transition: background-color 220ms ease, color 220ms ease; }
.ui-xcc__badge > * { grid-area: 1 / 1; transition: opacity 180ms ease, transform 260ms var(--ui-xcc-ease); }
.ui-xcc__badge span { max-width: 100%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ui-xcc__badge svg { opacity: 0; transform: scale(0.5); }
.ui-xcc__row[aria-checked="true"] .ui-xcc__badge { background: var(--ui-xcc-color); color: #fff; }
.ui-xcc__row[aria-checked="true"] .ui-xcc__badge span { opacity: 0; transform: scale(0.5); }
.ui-xcc__row[aria-checked="true"] .ui-xcc__badge svg { opacity: 1; transform: none; }
.ui-xcc__label { overflow: hidden; text-align: start; color: var(--ui-xcc-ink); white-space: nowrap; text-overflow: ellipsis; }
.ui-xcc__value { font-weight: 500; color: var(--ui-xcc-strong); font-variant-numeric: tabular-nums; }
.ui-xcc__lift { min-width: 50px; height: 20px; padding: 0 6px; border-radius: 5px; background: var(--ui-xcc-tag-bg); font-size: 11px; font-weight: 500; line-height: 20px; color: var(--ui-xcc-tag); text-align: center; font-variant-numeric: tabular-nums; transition: background-color 240ms ease, color 240ms ease; }
.ui-xcc__track { grid-column: 2 / -1; height: 3px; overflow: hidden; border-radius: 1.5px; background: var(--ui-xcc-track); }
.ui-xcc__bar { display: block; width: 100%; height: 100%; border-radius: 1.5px; background: var(--ui-xcc-color); transform-origin: 0 50%; transition: transform 620ms var(--ui-xcc-ease); }

/* ----- A question: the mark in the chart's place, the question wraps, answers with a second line ----- */
.ui-xcc__mark { display: grid; flex: none; place-items: center; width: 20px; height: 20px; }
.ui-xcc[data-kind="choice"] .ui-xcc__head { align-items: flex-start; }
.ui-xcc[data-kind="choice"] .ui-xcc__name { white-space: normal; font-size: 14px; line-height: 20px; }
.ui-xcc[data-kind="choice"] .ui-xcc__sub { margin-top: 4px; }
/* Every answer, your own too, is a tile of the same width, edges in line with the switch, the title and the last row */
.ui-xcc[data-kind="choice"] .ui-xcc__rows { gap: 6px; margin-top: 10px; }
.ui-xcc[data-kind="choice"] .ui-xcc__row { grid-template-columns: auto minmax(0, 1fr); column-gap: 10px; row-gap: 2px; width: 100%; min-height: 40px; margin: 0; padding: 10px 12px; border-radius: 8px; box-shadow: inset 0 0 0 0.5px var(--ui-xcc-tile-line); }
.ui-xcc[data-kind="choice"] .ui-xcc__row[data-hot] { background: var(--ui-xcc-wash); }
.ui-xcc[data-kind="choice"] :is(.ui-xcc__row[aria-checked="true"], .ui-xcc__other[data-picked]) { background: var(--ui-xcc-pick); box-shadow: inset 0 0 0 1px var(--ui-xcc-pick-line); }
/* Answers are read side by side, so pointing at one doesn't fade the others */
.ui-xcc[data-kind="choice"] .ui-xcc__row[data-dim] { opacity: 1; }
/* One answer: round marks that fill with a dot, like radio buttons; several keep the square that turns into a check */
.ui-xcc[data-kind="choice"]:not([data-multiple]) .ui-xcc__badge { width: 20px; min-width: 20px; padding: 0; border-radius: 50%; }
.ui-xcc__desc { grid-column: 2; overflow: hidden; font-size: 12px; line-height: 16px; color: var(--ui-xcc-muted); white-space: nowrap; text-overflow: ellipsis; }
/* Several answers: the badge turns into a check box once picked, like the single answer's */
.ui-xcc__other { cursor: text; }
.ui-xcc__other[data-picked] .ui-xcc__badge { background: var(--ui-xcc-color); color: #fff; }
.ui-xcc__other[data-picked] .ui-xcc__badge span { opacity: 0; transform: scale(0.5); }
.ui-xcc__other[data-picked] .ui-xcc__badge svg { opacity: 1; transform: none; }
.ui-xcc__input { min-width: 0; height: 20px; padding: 0; border: 0; outline: 0; background: none; font: inherit; color: var(--ui-xcc-ink); }
.ui-xcc__input::placeholder { color: var(--ui-xcc-faint); }
.ui-xcc__secondary { flex: none; height: 28px; padding: 0 10px; border-radius: 6px; font-size: 13px; line-height: 20px; font-weight: 500; color: var(--ui-xcc-text); transition: background-color 140ms ease, color 140ms ease; }
.ui-xcc__secondary:hover { background: var(--ui-xcc-wash); color: var(--ui-xcc-ink); }
.ui-xcc__kbd { margin-left: 4px; padding: 0 4px; border-radius: 4px; background: rgba(255, 255, 255, 0.16); font: inherit; font-size: 11px; line-height: 16px; font-weight: 500; }

/* ----- The last row inside the card ----- */
.ui-xcc__foot { display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 8px 0 12px; border-top: 0.5px solid var(--ui-xcc-line); }
.ui-xcc__caption { flex: 1; min-width: 0; overflow: hidden; font-size: 12px; line-height: 16px; color: var(--ui-xcc-muted); white-space: nowrap; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.ui-xcc__caption > span { display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; vertical-align: top; animation: ui-xcc-in 280ms var(--ui-xcc-ease) both; }
/* Primary: the dark chip */
.ui-xcc__action { display: inline-flex; align-items: center; gap: 4px; flex: 0 1 auto; min-width: 0; max-width: 65%; height: 28px; padding: 0 7px 0 10px; border-radius: 6px; background: var(--ui-xcc-primary); font-size: 13px; line-height: 20px; font-weight: 500; color: var(--ui-xcc-on-primary); white-space: nowrap; animation: ui-xcc-pop 360ms var(--ui-xcc-ease) both; transition: opacity 160ms ease; }
.ui-xcc__action-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ui-xcc__action:hover { opacity: 0.9; }
.ui-xcc__action svg { transition: transform 220ms var(--ui-xcc-ease); }
.ui-xcc__action:hover svg { transform: translateX(2px); }

@keyframes ui-xcc-in { from { opacity: 0; transform: translateY(3px); } }
@keyframes ui-xcc-pop { from { opacity: 0; transform: scale(0.94); } }

/* Narrow cards: the note gives way first, then the chips lose their padding */
@container (max-width: 300px) {
  .ui-xcc__head { gap: 8px; padding: 10px; }
  .ui-xcc__chart { width: 32px; height: 32px; padding: 6px 5px 5px; gap: 2.5px; }
  .ui-xcc__note { display: none; }
  .ui-xcc__lead { gap: 3px; padding: 0 6px; }
  .ui-xcc__lead svg { display: none; }
  .ui-xcc__body { padding: 0 10px 10px; }
  .ui-xcc__switch { gap: 2px; }
  .ui-xcc__metric { flex: 1; padding: 4px 6px; }
  .ui-xcc__row { column-gap: 7px; }
  .ui-xcc__lift { min-width: 44px; padding: 0 4px; }
  .ui-xcc__foot { padding: 0 8px 0 10px; }
}

@media (pointer: coarse) {
  .ui-xcc__metric { height: 34px; padding: 7px 12px; }
  .ui-xcc__row { padding: 10px 6px 11px; }
  .ui-xcc__foot { height: 52px; }
  .ui-xcc__action { height: 34px; }
}

@media (prefers-reduced-motion: reduce) {
  .ui-xcc *, .ui-xcc *::before, .ui-xcc *::after { animation: none !important; transition: none !important; }
}

/* Dark mode: follows a .dark class or data-theme="dark" on any ancestor, e.g. <html> */
:where(.dark, [data-theme="dark"]) .ui-xcc {
  --ui-xcc-card: #1c1c1e;
  --ui-xcc-ink: rgba(255, 255, 255, 0.9);
  --ui-xcc-strong: #ffffff;
  --ui-xcc-text: rgba(255, 255, 255, 0.62);
  --ui-xcc-muted: rgba(255, 255, 255, 0.46);
  --ui-xcc-faint: rgba(255, 255, 255, 0.3);
  --ui-xcc-icon: rgba(255, 255, 255, 0.5);
  --ui-xcc-line: rgba(255, 255, 255, 0.08);
  --ui-xcc-fill: rgba(255, 255, 255, 0.08);
  --ui-xcc-wash: rgba(255, 255, 255, 0.04);
  --ui-xcc-track: rgba(255, 255, 255, 0.08);
  --ui-xcc-pick: rgba(77, 141, 255, 0.14);
  --ui-xcc-pick-line: rgba(77, 141, 255, 0.4);
  --ui-xcc-tile-line: rgba(255, 255, 255, 0.1);
  --ui-xcc-primary: rgba(255, 255, 255, 0.9);
  --ui-xcc-on-primary: #1c1c1e;
  --ui-xcc-c0: rgba(255, 255, 255, 0.3);
  --ui-xcc-c1: #4d8dff;
  --ui-xcc-c2: #8585f0;
  --ui-xcc-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.4);
  --ui-xcc-focus: rgba(77, 141, 255, 0.5);
}
:where(.dark, [data-theme="dark"]) .ui-xcc [data-tone="red"] { --ui-xcc-tag: #ff8a8d; --ui-xcc-tag-bg: rgba(229, 72, 77, 0.14); }
:where(.dark, [data-theme="dark"]) .ui-xcc [data-tone="amber"] { --ui-xcc-tag: #f5c264; --ui-xcc-tag-bg: rgba(232, 162, 12, 0.14); }
:where(.dark, [data-theme="dark"]) .ui-xcc [data-tone="green"] { --ui-xcc-tag: #5fd394; --ui-xcc-tag-bg: rgba(26, 154, 82, 0.14); }
:where(.dark, [data-theme="dark"]) .ui-xcc [data-tone="blue"] { --ui-xcc-tag: #8fb6ff; --ui-xcc-tag-bg: rgba(77, 141, 255, 0.14); }
:where(.dark, [data-theme="dark"]) .ui-xcc [data-tone="violet"] { --ui-xcc-tag: #ababf5; --ui-xcc-tag-bg: rgba(91, 91, 214, 0.18); }
:where(.dark, [data-theme="dark"]) .ui-xcc [data-tone="gray"] { --ui-xcc-tag: rgba(255, 255, 255, 0.62); --ui-xcc-tag-bg: rgba(255, 255, 255, 0.08); }
:where(.dark, [data-theme="dark"]) .ui-xcc__badge { color: color-mix(in srgb, var(--ui-xcc-color) 75%, #fff); }
:where(.dark, [data-theme="dark"]) .ui-xcc__row[aria-checked="true"] .ui-xcc__badge,
:where(.dark, [data-theme="dark"]) .ui-xcc__other[data-picked] .ui-xcc__badge { color: #1c1c1e; }
:where(.dark, [data-theme="dark"]) .ui-xcc__kbd { background: rgba(0, 0, 0, 0.12); }
`;
