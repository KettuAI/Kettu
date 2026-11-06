// affectUI Pro - licensed under https://www.affectui.com/license, not under this project's open-source license. Don't copy it out of this project.
"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

/*
 * Compact Breakdown (clean style) – one total split into its parts, in one white card with hairline shadows
 * and a single self-contained file.
 * A big number, a thin stacked bar and the parts as a ranked list. Switching the period rolls every number,
 * the bar glides to its new split and the rows trade places when the ranking changes. Hovering a part (in the
 * bar or the list) dims the rest and rolls the big number to that part's value; leaving rolls it back.
 * The styles are injected below, so no extra files are needed.
 */

export type BreakdownItem = {
  /** Stable key across periods – defaults to the label */
  id?: string;
  label: string;
  value: number;
  /** Any CSS color – defaults to shades of the accent, then grays */
  color?: string;
};

export type BreakdownPeriod = { id: string; label: string };

export type CompactBreakdownProps = {
  title?: string;
  /** The parts of the shown period – the list ranks them by value */
  items: BreakdownItem[];
  /** Options of the period switch – no switch when left out */
  periods?: BreakdownPeriod[];
  /** Controlled period id */
  period?: string;
  defaultPeriod?: string;
  /** Called with the new period id – pass the matching `items` and `delta` back in */
  onPeriodChange?: (id: string) => void;
  /** Change against the previous period in percent, e.g. 12.4 or -3 – shown as a small pill */
  delta?: number;
  /** Formats every value, e.g. (n) => `$${Math.round(n).toLocaleString("en-US")}` */
  format?: (value: number) => string;
  /** Text under the big number while nothing is hovered */
  totalLabel?: string;
  /** Replaces the last row of the card (default: the largest part); null hides that row */
  footer?: ReactNode;
  /** Kettu: the period switch's name, translated */
  switchLabel?: string;
  className?: string;
};

/* ---------- Helpers ---------- */

const defaultFormat = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
const PALETTE = ["var(--ui-cbc-c1)", "var(--ui-cbc-c2)", "var(--ui-cbc-c3)", "var(--ui-cbc-c4)", "var(--ui-cbc-c5)"];
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const ease = (t: number) => 1 - Math.pow(1 - t, 4);
const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const keyOf = (item: BreakdownItem) => item.id ?? item.label;
// NaN, Infinity and negatives count as nothing, so no share or width turns into NaN
const num = (n: number) => (Number.isFinite(n) ? Math.max(0, n) : 0);
// A part that exists but rounds to 0% still says so – and one that isn't everything never reads 100%
const pct = (v: number) => (v > 0 && v < 1 ? "<1%" : v > 99 && v < 100 ? ">99%" : `${Math.round(v)}%`);

/**
 * Tweens a set of named numbers: every key rolls from where it is now to its target, new keys from zero.
 * One animation frame loop for the whole card, so numbers and bar widths move in step.
 */
function useTween(target: Record<string, number>, first: number, then: number) {
  const [shown, setShown] = useState<Record<string, number>>(() => Object.fromEntries(Object.keys(target).map((k) => [k, 0])));
  const current = useRef(shown);
  const started = useRef(false);
  const signature = JSON.stringify(target);
  useEffect(() => {
    const to = JSON.parse(signature) as Record<string, number>;
    const from = { ...current.current };
    if (reduced()) {
      current.current = to;
      setShown(to);
      return;
    }
    const duration = started.current ? then : first;
    started.current = true;
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const e = ease(t);
      const next: Record<string, number> = {};
      for (const k in to) next[k] = (from[k] ?? 0) + (to[k] - (from[k] ?? 0)) * e;
      current.current = next;
      setShown(next);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps
  return shown;
}

export function CompactBreakdown({
  title = "Breakdown",
  items,
  periods,
  period,
  defaultPeriod,
  onPeriodChange,
  delta,
  format = defaultFormat,
  totalLabel = "Total",
  footer,
  switchLabel = "Period",
  className,
}: CompactBreakdownProps) {
  const uid = useId();
  const [innerPeriod, setInnerPeriod] = useState(defaultPeriod ?? periods?.[0]?.id);
  const activePeriod = period ?? innerPeriod;
  const [active, setActive] = useState<string | null>(null);

  // Every part ever shown keeps its place in the bar and its color, so the bar only glides – never reshuffles
  const known = useRef<{ key: string; label: string; color: string }[]>([]);
  // Parts with the same label or id keep their own row: the second one becomes "label#1"
  const counts = new Map<string, number>();
  const keyed = items.map((item) => {
    const base = keyOf(item);
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    return { item, key: n ? `${base}#${n}` : base };
  });
  for (const { item, key } of keyed) {
    const seen = known.current.find((k) => k.key === key);
    if (seen) {
      seen.label = item.label;
      if (item.color) seen.color = item.color;
    } else {
      known.current.push({ key, label: item.label, color: item.color ?? PALETTE[known.current.length] ?? "var(--ui-cbc-c5)" });
    }
  }

  const now = new Map(keyed.map(({ item, key }) => [key, num(item.value)]));
  const total = [...now.values()].reduce((a, b) => a + b, 0);
  const activeValid = active !== null && now.has(active) ? active : null;

  // One tween for everything: each part, the total and the big figure (the total, or the hovered part)
  const target: Record<string, number> = { "#total": total, "#figure": activeValid ? (now.get(activeValid) ?? 0) : total };
  for (const k of known.current) target[k.key] = now.get(k.key) ?? 0;
  const shown = useTween(target, 900, 620);
  const shownTotal = Math.max(shown["#total"] ?? 0, 0.0001);

  // Rows: ranked by the new values; parts that left the period fold away at the end
  const rows = known.current
    .map((k) => ({ ...k, value: now.get(k.key) ?? 0, leaving: !now.has(k.key) }))
    .filter((r) => !r.leaving || (shown[r.key] ?? 0) > 0.5)
    .sort((a, b) => Number(a.leaving) - Number(b.leaving) || b.value - a.value);
  const order = rows.map((r) => r.key).join("|");
  // "Largest" only names a part that has a value – not the first of all zeros
  const top = rows.find((r) => !r.leaving && r.value > 0);

  // Rows glide to their new rank (FLIP): remember where each one was, then animate from there
  const rowEls = useRef(new Map<string, HTMLLIElement>());
  const tops = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const next = new Map<string, number>();
    rowEls.current.forEach((el, key) => next.set(key, el.offsetTop));
    if (!reduced()) {
      next.forEach((y, key) => {
        const before = tops.current.get(key);
        const el = rowEls.current.get(key);
        if (el && before !== undefined && before !== y) {
          el.animate([{ transform: `translateY(${before - y}px)` }, { transform: "none" }], { duration: 560, easing: EASE });
        }
      });
    }
    tops.current = next;
  }, [order]);

  // The period switch: a light fill that slides to the chosen option – short and crisp
  const switchRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);
  useLayoutEffect(() => {
    const box = switchRef.current;
    const pill = pillRef.current;
    const option = box?.querySelector<HTMLElement>('[aria-checked="true"]');
    if (!box || !pill || !option) return;
    const place = () => {
      if (!placed.current) pill.style.transition = "none";
      pill.style.width = `${option.offsetWidth}px`;
      pill.style.height = `${option.offsetHeight}px`;
      pill.style.transform = `translate(${option.offsetLeft}px, ${option.offsetTop}px)`;
      pill.style.opacity = "1";
      if (!placed.current) {
        void pill.offsetWidth;
        pill.style.transition = "";
        placed.current = true;
      }
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(box);
    return () => ro.disconnect();
  }, [activePeriod, periods?.length]);

  const choose = (id: string) => {
    if (period === undefined) setInnerPeriod(id);
    onPeriodChange?.(id);
  };
  const onSwitchKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!periods?.length) return;
    const i = periods.findIndex((p) => p.id === activePeriod);
    const to = e.key === "ArrowRight" || e.key === "ArrowDown" ? i + 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? periods.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    const next = periods[(to + periods.length) % periods.length];
    choose(next.id);
    requestAnimationFrame(() => switchRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
  };

  const activeRow = activeValid ? rows.find((r) => r.key === activeValid) : undefined;
  const share = (key: string) => ((shown[key] ?? 0) / shownTotal) * 100;
  const hasDelta = delta !== undefined && Number.isFinite(delta);
  const up = (delta ?? 0) >= 0;

  return (
    <div className={["ui-cbc", className].filter(Boolean).join(" ")} role="group" aria-labelledby={`${uid}-title`}>
      {/* React 19 hoists this into <head> once, no matter how many cards render */}
      <style href="ui-compact-breakdown-clean" precedence="default">
        {css}
      </style>

      <div className="ui-cbc__body">
        <header className="ui-cbc__head">
          <h3 id={`${uid}-title`} className="ui-cbc__title" title={title} dir="auto">
            {title}
          </h3>
          {periods && periods.length > 1 && (
            <div ref={switchRef} className="ui-cbc__switch" role="radiogroup" aria-label={switchLabel} onKeyDown={onSwitchKey}>
              <span ref={pillRef} className="ui-cbc__pill" aria-hidden="true" />
              {periods.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={p.id === activePeriod}
                  tabIndex={p.id === activePeriod ? 0 : -1}
                  className="ui-cbc__option"
                  title={p.label}
                  onClick={() => choose(p.id)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}
        </header>

        {/* The big number: the total – or the hovered part, rolled to */}
        <div className="ui-cbc__figure">
          <p className="ui-cbc__big" aria-hidden="true">
            {format(shown["#figure"] ?? 0)}
          </p>
          {hasDelta && !activeRow && (
            <span key={`${activePeriod}-${delta}`} className="ui-cbc__delta" data-up={up || undefined}>
              <svg viewBox="0 0 12 12" aria-hidden="true">
                <path d={up ? "M6 9.5v-7M2.8 5.6 6 2.4l3.2 3.2" : "M6 2.5v7M2.8 6.4 6 9.6l3.2-3.2"} />
              </svg>
              {Math.abs(delta ?? 0).toLocaleString("en-US", { maximumFractionDigits: 1 })}%
            </span>
          )}
        </div>
        <p className="ui-cbc__caption" aria-hidden="true">
          <span key={activeRow?.key ?? "#total"} className="ui-cbc__caption-in">
            {activeRow ? (
              <>
                <i className="ui-cbc__swatch" style={{ background: activeRow.color }} />
                <span className="ui-cbc__caption-label" dir="auto">{activeRow.label}</span>
                <span className="ui-cbc__caption-share">· {pct(share(activeRow.key))}</span>
              </>
            ) : (
              totalLabel
            )}
          </span>
        </p>
        <p className="ui-cbc__sr">
          {totalLabel}: {format(total)}
          {hasDelta ? `, ${up ? "up" : "down"} ${Math.abs(delta ?? 0).toLocaleString("en-US", { maximumFractionDigits: 1 })}% against the previous period` : ""}
        </p>

        <div className="ui-cbc__bar" data-active={activeValid ? "" : undefined} aria-hidden="true" onPointerLeave={() => setActive(null)}>
          {known.current.map((k) => {
            const w = share(k.key);
            return w > 0.05 ? (
              <span
                key={k.key}
                className="ui-cbc__seg"
                data-active={k.key === activeValid || undefined}
                style={{ flexGrow: w, background: k.color }}
                onPointerEnter={() => now.has(k.key) && setActive(k.key)}
              />
            ) : null;
          })}
        </div>

        <ul className="ui-cbc__list" data-active={activeValid ? "" : undefined} onPointerLeave={() => setActive(null)}>
          {rows.map((r) => (
            <li
              key={r.key}
              ref={(el) => {
                if (el) rowEls.current.set(r.key, el);
                else rowEls.current.delete(r.key);
              }}
              className="ui-cbc__row"
              data-leaving={r.leaving || undefined}
            >
              <div
                className="ui-cbc__item"
                tabIndex={r.leaving ? -1 : 0}
                data-active={r.key === activeValid || undefined}
                onPointerEnter={() => !r.leaving && setActive(r.key)}
                onFocus={() => !r.leaving && setActive(r.key)}
                onBlur={() => setActive(null)}
              >
                <i className="ui-cbc__swatch" style={{ background: r.color }} />
                <span className="ui-cbc__label" title={r.label} dir="auto">
                  {r.label}
                </span>
                <span className="ui-cbc__value">{format(shown[r.key] ?? 0)}</span>
                <span className="ui-cbc__share">{pct(share(r.key))}</span>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* The last row inside the card */}
      {footer !== null && (
        <div className="ui-cbc__foot">
          {footer ??
            (top && (
              <span key={top.key} className="ui-cbc__foot-in">
                Largest: <b title={top.label} dir="auto">{top.label}</b>
              </span>
            ))}
        </div>
      )}
    </div>
  );
}

const css = /* css */ `
/* Colors and motion as variables – override them on .ui-cbc */
.ui-cbc {
  --ui-cbc-card: #ffffff;
  --ui-cbc-ink: rgba(0, 0, 0, 0.88);
  --ui-cbc-strong: #000000;
  --ui-cbc-text: rgba(0, 0, 0, 0.61);
  --ui-cbc-muted: rgba(0, 0, 0, 0.45);
  --ui-cbc-faint: rgba(0, 0, 0, 0.27);
  --ui-cbc-line: rgba(0, 0, 0, 0.06);
  --ui-cbc-wash: rgba(0, 0, 0, 0.03);
  --ui-cbc-fill: rgba(0, 0, 0, 0.06);
  --ui-cbc-up: #1a9a52;
  --ui-cbc-up-bg: rgba(26, 154, 82, 0.08);
  --ui-cbc-down: #e5484d;
  --ui-cbc-down-bg: rgba(229, 72, 77, 0.08);
  /* Parts: the accent blue, then lighter tints of it, then a gray */
  --ui-cbc-c1: rgba(0, 96, 226, 0.765);
  --ui-cbc-c2: rgba(0, 96, 226, 0.5);
  --ui-cbc-c3: rgba(0, 96, 226, 0.32);
  --ui-cbc-c4: rgba(0, 96, 226, 0.18);
  --ui-cbc-c5: rgba(0, 0, 0, 0.14);
  /* Strokes are shadows: a 0.5px hairline plus a soft lift */
  --ui-cbc-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.06), 0 1px 1px -1px rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --ui-cbc-focus: rgba(0, 96, 226, 0.35);
  --ui-cbc-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --ui-cbc-snap: cubic-bezier(0.25, 0.9, 0.3, 1);
  box-sizing: border-box;
  container-type: inline-size;
  display: grid;
  /* The card never grows past its container, whatever the title or switch hold */
  grid-template-columns: minmax(0, 1fr);
  width: 100%;
  max-width: 360px;
  overflow: hidden;
  border-radius: 10px;
  background: var(--ui-cbc-card);
  box-shadow: var(--ui-cbc-shadow);
  font-family: "Inter", "InterVariable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  line-height: 20px;
  font-weight: 400;
  color: var(--ui-cbc-ink);
  -webkit-font-smoothing: antialiased;
}
.ui-cbc *, .ui-cbc *::before, .ui-cbc *::after { box-sizing: border-box; }
:where(.ui-cbc) button { margin: 0; padding: 0; border: 0; background: none; font: inherit; color: inherit; cursor: pointer; }
:where(.ui-cbc) :is(h3, p, ul) { margin: 0; padding: 0; }
:where(.ui-cbc) ul { list-style: none; }
:where(.ui-cbc) svg { display: block; flex: none; }
.ui-cbc :is(button, [tabindex="0"]):focus-visible { outline: 2px solid var(--ui-cbc-focus); outline-offset: 1px; }
.ui-cbc b { font-weight: 500; color: var(--ui-cbc-ink); }
.ui-cbc__sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

.ui-cbc__body { padding: 16px 16px 10px; }

/* Head: title, the period switch on the right */
.ui-cbc__head { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 28px; }
.ui-cbc__title { overflow: hidden; font-size: 15px; font-weight: 500; line-height: 24px; color: var(--ui-cbc-strong); white-space: nowrap; text-overflow: ellipsis; }
/* The "button switch": separate chips with a hairline; the light-gray fill slides to the chosen one */
.ui-cbc__switch { position: relative; display: grid; grid-auto-columns: minmax(0, auto); grid-auto-flow: column; gap: 4px; flex: 0 1 auto; min-width: 0; }
.ui-cbc__pill {
  position: absolute;
  top: 0;
  left: 0;
  border-radius: 6px;
  background: var(--ui-cbc-fill);
  opacity: 0;
  pointer-events: none;
  transition: transform 200ms var(--ui-cbc-snap), width 200ms var(--ui-cbc-snap);
}
.ui-cbc__option {
  position: relative;
  z-index: 1;
  height: 28px;
  padding: 4px 10px;
  border-radius: 6px;
  box-shadow: inset 0 0 0 0.5px var(--ui-cbc-line);
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
  color: var(--ui-cbc-text);
  white-space: nowrap;
  /* Long period names shorten instead of pushing the card wider */
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color 90ms ease, background-color 90ms ease;
}
.ui-cbc__option[aria-checked="true"] { color: var(--ui-cbc-ink); }
@media (hover: hover) {
  .ui-cbc__option[aria-checked="false"]:hover { background: var(--ui-cbc-wash); }
}

/* The big number and the change against the period before */
.ui-cbc__figure { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
.ui-cbc__big { font-size: 24px; font-weight: 500; line-height: 32px; letter-spacing: -0.02em; color: var(--ui-cbc-strong); font-variant-numeric: tabular-nums; }
.ui-cbc__delta {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 20px;
  padding: 0 6px 0 4px;
  border-radius: 5px;
  background: var(--ui-cbc-down-bg);
  color: var(--ui-cbc-down);
  font-size: 12px;
  font-weight: 500;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
  animation: ui-cbc-pop 380ms var(--ui-cbc-ease) both;
}
.ui-cbc__delta[data-up] { background: var(--ui-cbc-up-bg); color: var(--ui-cbc-up); }
.ui-cbc__delta svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round; }
.ui-cbc__caption { height: 16px; overflow: hidden; font-size: 12px; line-height: 16px; color: var(--ui-cbc-muted); font-variant-numeric: tabular-nums; }
.ui-cbc__caption-label { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ui-cbc__caption-share { flex: none; }
.ui-cbc__caption-in { display: inline-flex; max-width: 100%; align-items: center; gap: 6px; animation: ui-cbc-in 260ms var(--ui-cbc-ease) both; }

/* The stacked bar – parts keep their place and color, only the widths glide */
.ui-cbc__bar { display: flex; gap: 2px; height: 6px; margin-top: 16px; padding: 0; border-radius: 3px; }
/* Shares as flex-grow, so the 2px gaps come out of the bar instead of making it wider than the card */
.ui-cbc__seg { flex: 0 1 0; height: 100%; min-width: 2px; border-radius: 1.5px; transition: opacity 160ms ease, transform 200ms var(--ui-cbc-ease); }
.ui-cbc__seg:first-child { border-radius: 3px 1.5px 1.5px 3px; }
.ui-cbc__seg:last-child { border-radius: 1.5px 3px 3px 1.5px; }
.ui-cbc__bar[data-active] .ui-cbc__seg:not([data-active]) { opacity: 0.3; }
.ui-cbc__seg[data-active] { transform: scaleY(1.5); }

/* The ranked list */
.ui-cbc__list { position: relative; display: grid; margin-top: 10px; }
.ui-cbc__row { display: grid; grid-template-rows: 1fr; transition: grid-template-rows 320ms var(--ui-cbc-ease), opacity 200ms ease; }
.ui-cbc__row[data-leaving] { grid-template-rows: 0fr; opacity: 0; pointer-events: none; }
.ui-cbc__item {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 0;
  height: 32px;
  margin: 0 -8px;
  padding: 0 8px;
  overflow: hidden;
  border-radius: 6px;
  cursor: default;
  /* The hover wash is short and crisp – no long glide between rows */
  transition: background-color 90ms ease-out, opacity 160ms ease;
}
.ui-cbc__item[data-active] { background: var(--ui-cbc-wash); }
.ui-cbc__list[data-active] .ui-cbc__item:not([data-active]) { opacity: 0.45; }
.ui-cbc__swatch { flex: none; width: 8px; height: 8px; border-radius: 2px; }
.ui-cbc__label { flex: 1; min-width: 0; overflow: hidden; color: var(--ui-cbc-ink); white-space: nowrap; text-overflow: ellipsis; }
.ui-cbc__value { flex: none; white-space: nowrap; color: var(--ui-cbc-ink); font-weight: 500; font-variant-numeric: tabular-nums; }
.ui-cbc__share { flex: none; width: 34px; white-space: nowrap; font-size: 12px; line-height: 16px; text-align: right; color: var(--ui-cbc-muted); font-variant-numeric: tabular-nums; }

/* The last row inside the card */
.ui-cbc__foot {
  display: flex;
  align-items: center;
  min-height: 40px;
  padding: 0 16px;
  overflow: hidden;
  border-top: 0.5px solid var(--ui-cbc-line);
  font-size: 12px;
  line-height: 16px;
  color: var(--ui-cbc-muted);
  white-space: nowrap;
}
.ui-cbc__foot-in { overflow: hidden; text-overflow: ellipsis; animation: ui-cbc-in 320ms var(--ui-cbc-ease) both; }

@keyframes ui-cbc-in {
  from { opacity: 0; transform: translateY(4px); filter: blur(2px); }
  to { opacity: 1; transform: none; filter: none; }
}
@keyframes ui-cbc-pop {
  from { opacity: 0; transform: scale(0.85); }
  to { opacity: 1; transform: none; }
}

/* Narrow cards: tighter chips, then the share column goes and the values stay */
@container (max-width: 320px) {
  .ui-cbc__body { padding: 14px 14px 8px; }
  .ui-cbc__foot { padding: 0 14px; }
  .ui-cbc__switch { gap: 2px; }
  .ui-cbc__option { padding: 4px 8px; }
}
@container (max-width: 250px) {
  .ui-cbc__share { display: none; }
  .ui-cbc__option { padding: 4px 6px; }
}
@media (hover: none) and (pointer: coarse) {
  .ui-cbc__option { height: 32px; padding: 6px 10px; }
  .ui-cbc__item { height: 40px; }
  .ui-cbc__foot { min-height: 44px; }
}

@media (prefers-reduced-motion: reduce) {
  .ui-cbc *, .ui-cbc *::before, .ui-cbc *::after { animation: none !important; transition: none !important; }
}

/* Dark mode: follows a .dark class or data-theme="dark" on any ancestor, e.g. <html> */
:where(.dark, [data-theme="dark"]) .ui-cbc {
  --ui-cbc-card: #1c1c1e;
  --ui-cbc-ink: rgba(255, 255, 255, 0.9);
  --ui-cbc-strong: #ffffff;
  --ui-cbc-text: rgba(255, 255, 255, 0.62);
  --ui-cbc-muted: rgba(255, 255, 255, 0.46);
  --ui-cbc-faint: rgba(255, 255, 255, 0.3);
  --ui-cbc-line: rgba(255, 255, 255, 0.08);
  --ui-cbc-wash: rgba(255, 255, 255, 0.04);
  --ui-cbc-fill: rgba(255, 255, 255, 0.08);
  --ui-cbc-up: #3ec27a;
  --ui-cbc-up-bg: rgba(62, 194, 122, 0.14);
  --ui-cbc-down: #ff6b70;
  --ui-cbc-down-bg: rgba(229, 72, 77, 0.14);
  --ui-cbc-c1: #4d8dff;
  --ui-cbc-c2: rgba(77, 141, 255, 0.62);
  --ui-cbc-c3: rgba(77, 141, 255, 0.4);
  --ui-cbc-c4: rgba(77, 141, 255, 0.22);
  --ui-cbc-c5: rgba(255, 255, 255, 0.16);
  --ui-cbc-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.4);
  --ui-cbc-focus: rgba(77, 141, 255, 0.5);
}
`;
