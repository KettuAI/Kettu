// affectUI Pro - licensed under https://www.affectui.com/license, not under this project's open-source license. Don't copy it out of this project.
"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

/*
 * Date Range Picker (Clean) – pick a period from presets or two calendars, in a single self-contained file.
 * Clean style: no tray – a white one-line field with a hairline shadow opens one white popover; the picked ends are
 * dark chips with a light gray band between them, today carries a small blue dot, and Cancel / Apply sit in a last row
 * under a hairline.
 * Presets on the left ("Last 7 days", "This month" …), two months on the right: click a start, hover to preview,
 * click an end. Optionally compare with the previous period or the previous year – shown as a second band.
 * Arrow keys move day by day, PageUp/PageDown month by month, Enter picks, Esc closes.
 * On narrow screens the presets become a row of chips and one month is shown.
 * The styles are injected below, so no extra files are needed.
 */

export type DateRange = { start: Date; end: Date };
export type CompareMode = "off" | "previous" | "year";

export type RangePreset = {
  id: string;
  label: string;
  /** Builds the range from today */
  range: (today: Date) => DateRange;
};

export type DateRangePickerProps = {
  /** Controlled range */
  value?: DateRange;
  /** Starting range when uncontrolled – defaults to the last 30 days */
  defaultValue?: DateRange;
  /** Called on Apply with the range and the comparison range (if any) */
  onChange?: (range: DateRange, compare: DateRange | null, mode: CompareMode) => void;
  presets?: RangePreset[];
  /** Show the "Compare to" control */
  compare?: boolean;
  defaultCompare?: CompareMode;
  /** 0 = Sunday, 1 = Monday */
  weekStartsOn?: 0 | 1;
  /** Days after this can't be picked – defaults to today */
  max?: Date;
  min?: Date;
  /** Open the panel right away – nice for previews */
  defaultOpen?: boolean;
  /** "Today" for the presets – defaults to the real today */
  today?: Date;
  /** Which edge of the trigger the panel lines up with – "end" for a trigger at the right of the page */
  align?: "start" | "end";
  /** Kettu: the locale dates are written in */
  locale?: string;
  /** Kettu: the panel's words, translated (the compare control keeps its English) */
  labels?: Partial<DateRangeLabels>;
  /** Kettu: days that get a faint dot under their number, such as days with usage */
  marked?: (day: Date) => boolean;
  className?: string;
};

/** Kettu: the words the picker shows, with English defaults */
export type DateRangeLabels = {
  choose: string;
  presets: string;
  custom: string;
  previousMonth: string;
  nextMonth: string;
  /** The draft's start while its end is not picked yet */
  pickEnd: (start: string) => string;
  days: (count: number, formatted: string) => string;
  cancel: string;
  apply: string;
};

const englishLabels: DateRangeLabels = {
  choose: "Choose a date range",
  presets: "Presets",
  custom: "Custom",
  previousMonth: "Previous month",
  nextMonth: "Next month",
  pickEnd: (start) => `${start} – pick an end`,
  days: (n, formatted) => `${formatted} ${n === 1 ? "day" : "days"}`,
  cancel: "Cancel",
  apply: "Apply",
};

/* ---------- Dates (local days, no library) ---------- */

const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const addMonths = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const endOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth() + 1, 0);
const same = (a?: Date | null, b?: Date | null) => !!a && !!b && a.getTime() === b.getTime();
const utc = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
/** Days from a to b, counting both */
const span = (a: Date, b: Date) => Math.round((utc(b) - utc(a)) / 864e5) + 1;
const clamp = (d: Date, min?: Date, max?: Date) => (min && d < min ? min : max && d > max ? max : d);
const order = (a: Date, b: Date): DateRange => (a <= b ? { start: a, end: b } : { start: b, end: a });
const valid = (d?: Date | null): d is Date => d instanceof Date && !Number.isNaN(d.getTime());
/** Both ends real days, the start first – or the fallback */
const sane = (r: DateRange | null | undefined, fallback: DateRange): DateRange =>
  r && valid(r.start) && valid(r.end) ? order(day(r.start), day(r.end)) : fallback;
/** Kettu: the date and number formats of a locale */
const formatsOf = (locale: string) => ({
  count: new Intl.NumberFormat(locale),
  fmtDay: new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }),
  fmtDayYear: new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", year: "numeric" }),
  fmtMonth: new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }),
  fmtLong: new Intl.DateTimeFormat(locale, { weekday: "long", month: "long", day: "numeric", year: "numeric" }),
  weekday: new Intl.DateTimeFormat(locale, { weekday: "short" }),
});
const english = formatsOf("en-US");

/** "Sep 9 – Oct 8, 2026", "Dec 20, 2025 – Jan 5, 2026", "Oct 8, 2026" */
export function formatRange({ start, end }: DateRange, { fmtDay, fmtDayYear } = english) {
  if (!valid(start) || !valid(end)) return "–";
  if (same(start, end)) return fmtDayYear.format(start);
  const sameYear = start.getFullYear() === end.getFullYear();
  return `${(sameYear ? fmtDay : fmtDayYear).format(start)} – ${fmtDayYear.format(end)}`;
}

export function compareRange(range: DateRange, mode: CompareMode): DateRange | null {
  if (mode === "previous") {
    const length = span(range.start, range.end);
    return { start: addDays(range.start, -length), end: addDays(range.start, -1) };
  }
  if (mode === "year") {
    // Feb 29 goes back to Feb 28, not Mar 1
    const back = (d: Date) => new Date(d.getFullYear() - 1, d.getMonth(), Math.min(d.getDate(), endOfMonth(new Date(d.getFullYear() - 1, d.getMonth(), 1)).getDate()));
    return { start: back(range.start), end: back(range.end) };
  }
  return null;
}

const quarterStart = (d: Date) => new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1);

export const defaultPresets: RangePreset[] = [
  { id: "today", label: "Today", range: (t) => ({ start: t, end: t }) },
  { id: "yesterday", label: "Yesterday", range: (t) => ({ start: addDays(t, -1), end: addDays(t, -1) }) },
  { id: "7d", label: "Last 7 days", range: (t) => ({ start: addDays(t, -6), end: t }) },
  { id: "30d", label: "Last 30 days", range: (t) => ({ start: addDays(t, -29), end: t }) },
  { id: "90d", label: "Last 90 days", range: (t) => ({ start: addDays(t, -89), end: t }) },
  { id: "month", label: "This month", range: (t) => ({ start: startOfMonth(t), end: t }) },
  { id: "last-month", label: "Last month", range: (t) => ({ start: addMonths(t, -1), end: endOfMonth(addMonths(t, -1)) }) },
  { id: "quarter", label: "This quarter", range: (t) => ({ start: quarterStart(t), end: t }) },
  { id: "ytd", label: "Year to date", range: (t) => ({ start: new Date(t.getFullYear(), 0, 1), end: t }) },
];

const COMPARE: { id: CompareMode; label: string }[] = [
  { id: "off", label: "Off" },
  { id: "previous", label: "Previous period" },
  { id: "year", label: "Previous year" },
];

/* ---------- Icons ---------- */

const Glyph = ({ d, className }: { d: string; className?: string }) => (
  <svg viewBox="0 0 24 24" className={["ui-drpc__glyph", className].filter(Boolean).join(" ")} aria-hidden="true">
    <path d={d} />
  </svg>
);
const icons = {
  calendar: "M7 3v3M17 3v3M4.5 9.5h15M6 5h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z",
  chevron: "M8 10l4 4 4-4",
  left: "M14.5 6l-6 6 6 6",
  right: "M9.5 6l6 6-6 6",
  arrow: "M5 12h14M13 6l6 6-6 6",
};

/* ---------- Month grid ---------- */

/** The weeks of a month, each 7 days or null for days of the neighbouring months */
function weeks(month: Date, weekStartsOn: number) {
  const first = startOfMonth(month);
  const lead = (first.getDay() - weekStartsOn + 7) % 7;
  const days = endOfMonth(month).getDate();
  const cells: (Date | null)[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(new Date(month.getFullYear(), month.getMonth(), d));
  while (cells.length % 7) cells.push(null);
  const out: (Date | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) out.push(cells.slice(i, i + 7));
  return out;
}

export function DateRangePicker({
  value,
  defaultValue,
  onChange,
  presets = defaultPresets,
  compare = true,
  defaultCompare = "previous",
  weekStartsOn = 1,
  max,
  min,
  defaultOpen = false,
  today: todayProp,
  align = "start",
  locale = "en-US",
  labels: labelsProp,
  marked,
  className,
}: DateRangePickerProps) {
  const formats = useMemo(() => formatsOf(locale), [locale]);
  const { count, fmtDayYear, fmtMonth, fmtLong } = formats;
  const labels = { ...englishLabels, ...labelsProp };
  // Invalid dates, an unknown week start or compare mode fall back instead of crashing
  const wso = weekStartsOn === 0 ? 0 : 1;
  const today = useMemo(() => day(valid(todayProp) ? todayProp : new Date()), [todayProp?.getTime()]); // eslint-disable-line react-hooks/exhaustive-deps
  const maxDay = valid(max) ? day(max) : today;
  const minDay = valid(min) && day(min) <= maxDay ? day(min) : undefined;

  const [own, setOwn] = useState<DateRange>(() => {
    // The last 30 days – kept inside min / max
    const end = clamp(today, minDay, maxDay);
    return sane(defaultValue, { start: clamp(addDays(end, -29), minDay, maxDay), end });
  });
  const applied = value ? sane(value, own) : own;
  const [appliedMode, setAppliedMode] = useState<CompareMode>(compare && COMPARE.some((c) => c.id === defaultCompare) ? defaultCompare : "off");
  const appliedCompare = compare && appliedMode !== "off" ? compareRange(applied, appliedMode) : null;

  const [open, setOpen] = useState(defaultOpen);
  // The draft while the panel is open: end is null between the first and second click
  const [draft, setDraft] = useState<{ start: Date; end: Date | null }>(applied);
  const [hover, setHover] = useState<Date | null>(null);
  const [mode, setMode] = useState<CompareMode>(appliedMode);
  const [month, setMonth] = useState(() => addMonths(applied.end, -1)); // left month
  const [dir, setDir] = useState<1 | -1>(1);
  const [focus, setFocus] = useState<Date>(() => clamp(applied.end, minDay, maxDay));

  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const keyboard = useRef(false);
  const uid = useId();
  const panelInner = useRef<HTMLDivElement>(null);
  const triggerInner = useRef<HTMLSpanElement>(null);
  const presetList = useRef<HTMLDivElement>(null);
  const lastCompare = useRef<DateRange | null>(null);

  // Reset the draft whenever the panel opens
  const openPanel = () => {
    setDraft(applied);
    setMode(appliedMode);
    setMonth(addMonths(applied.end, -1));
    setFocus(clamp(applied.end, minDay, maxDay));
    setHover(null);
    setOpen(true);
  };
  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };

  // Click outside and Esc close the panel
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  // Keyboard focus follows the focused day
  useLayoutEffect(() => {
    if (!open || !keyboard.current) return;
    grid.current?.querySelector<HTMLButtonElement>(`[data-day="${focus.getTime()}"]`)?.focus();
  }, [focus, month, open]);

  const range: DateRange | null = draft.end ? order(draft.start, draft.end) : hover ? order(draft.start, hover) : null;
  const shown = range ?? { start: draft.start, end: draft.start };
  const cmp = compare && range ? compareRange(range, mode) : null;
  const presetAt = draft.end ? presets.findIndex((p) => {
    const r = p.range(today);
    return valid(r?.start) && valid(r?.end) && same(day(r.start), shown.start) && same(day(r.end), shown.end);
  }) : -1;
  const preset = presets[presetAt];

  const pick = (d: Date) => {
    if (draft.end) setDraft({ start: d, end: null });
    else {
      const r = order(draft.start, d);
      setDraft(r);
    }
    setHover(null);
    setFocus(d);
  };
  const choosePreset = (p: RangePreset) => {
    const r = p.range(today);
    if (!valid(r?.start) || !valid(r?.end)) return;
    const next = { start: clamp(day(r.start), minDay, maxDay), end: clamp(day(r.end), minDay, maxDay) };
    setDraft(next);
    setHover(null);
    setFocus(next.end);
    const left = addMonths(next.end, -1);
    if (left.getTime() !== month.getTime()) {
      setDir(left > month ? 1 : -1);
      setMonth(left);
    }
  };
  const shift = (n: number) => {
    setDir(n > 0 ? 1 : -1);
    setMonth((m) => addMonths(m, n));
  };
  const apply = () => {
    const r = draft.end ? order(draft.start, draft.end) : { start: draft.start, end: draft.start };
    if (!value) setOwn(r);
    setAppliedMode(mode);
    onChange?.(r, compare ? compareRange(r, mode) : null, mode);
    close();
  };

  const disabled = (d: Date) => d > maxDay || (!!minDay && d < minDay);

  const onGridKey = (e: KeyboardEvent) => {
    const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    let next: Date | null = null;
    if (e.key in moves) next = addDays(focus, moves[e.key]);
    else if (e.key === "PageUp") next = new Date(focus.getFullYear(), focus.getMonth() - 1, Math.min(focus.getDate(), 28));
    else if (e.key === "PageDown") next = new Date(focus.getFullYear(), focus.getMonth() + 1, Math.min(focus.getDate(), 28));
    else if (e.key === "Home") next = addDays(focus, -((focus.getDay() - wso + 7) % 7));
    else if (e.key === "End") next = addDays(focus, 6 - ((focus.getDay() - wso + 7) % 7));
    if (!next) return;
    e.preventDefault();
    keyboard.current = true;
    next = clamp(next, minDay, maxDay);
    setFocus(next);
    if (!draft.end) setHover(next);
    // Keep the focused day on screen
    const right = endOfMonth(addMonths(month, 1));
    if (next < month) shift(-1);
    else if (next > right) shift(1);
  };

  const weekdays = Array.from({ length: 7 }, (_, i) =>
    formats.weekday.format(new Date(2026, 0, 4 + wso + i)).slice(0, 2),
  );
  const months = [month, addMonths(month, 1)];
  const rows = Math.max(...months.map((m) => weeks(m, wso).length));
  const length = span(shown.start, shown.end);

  const inRange = (d: Date, r: DateRange | null) => !!r && d >= r.start && d <= r.end;
  if (cmp) lastCompare.current = cmp;

  // Phones: the row of preset chips scrolls the active one into view (at once when opening, smoothly afterwards)
  const scrolled = useRef(false);
  useEffect(() => {
    if (!open) {
      scrolled.current = false;
      return;
    }
    const list = presetList.current;
    const active = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !active || list.scrollWidth <= list.clientWidth) return;
    const left = Math.max(0, active.offsetLeft - (list.clientWidth - active.offsetWidth) / 2);
    list.scrollTo({ left, behavior: scrolled.current ? "smooth" : "auto" });
    scrolled.current = true;
  }, [open, presetAt]);

  // The panel stays on screen: near the right edge it opens leftwards
  useLayoutEffect(() => {
    const el = root.current?.querySelector<HTMLElement>('[role="dialog"]');
    if (!open || !el) return;
    el.style.left = "";
    const r = el.getBoundingClientRect();
    const over = r.right - (document.documentElement.clientWidth - 8);
    if (over > 0) el.style.left = `${-Math.max(0, Math.min(over, r.left - 8))}px`;
  }, [open]);

  // The calendars glide to their new height (5 or 6 weeks) instead of jumping – only this part clips,
  // the last row with Cancel / Apply is never cut off while it moves
  useLayoutEffect(() => {
    const box = panel.current;
    const inner = panelInner.current;
    if (!open || !box || !inner) return;
    const set = () => (box.style.height = `${inner.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [open]);

  // The trigger glides to the width of its new text
  useLayoutEffect(() => {
    const box = trigger.current;
    const inner = triggerInner.current;
    if (!box || !inner) return;
    const set = () => (box.style.width = `${inner.offsetWidth + 16}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={root} className={["ui-drpc", className].filter(Boolean).join(" ")} data-open={open || undefined} data-align={align === "end" ? "end" : undefined}>
      {/* React 19 hoists this into <head> once, no matter how many pickers render */}
      <style href="ui-date-range-picker-clean" precedence="default">
        {css}
      </style>

      <button
        ref={trigger}
        type="button"
        className="ui-drpc__trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={`${uid}-panel`}
        onClick={() => (open ? close() : openPanel())}
      >
        <span ref={triggerInner} className="ui-drpc__trigger-inner">
          <Glyph d={icons.calendar} />
          <span className="ui-drpc__trigger-text" key={`${formatRange(applied, formats)}-${appliedMode}`}>
            <span className="ui-drpc__trigger-range">{formatRange(applied, formats)}</span>
            {appliedCompare && <span className="ui-drpc__trigger-compare">vs. {formatRange(appliedCompare, formats)}</span>}
          </span>
          <Glyph d={icons.chevron} className="ui-drpc__chevron" />
        </span>
      </button>

      {open && (
        <div
          id={`${uid}-panel`}
          role="dialog"
          aria-label={labels.choose}
          className="ui-drpc__panel"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              close();
            }
          }}
        >
          <div ref={panel} className="ui-drpc__clip">
          <div ref={panelInner} className="ui-drpc__body">
            <div ref={presetList} className="ui-drpc__presets" role="listbox" aria-label={labels.presets}>
              {presets.map((p, i) => (
                <button
                  key={`${p.id}-${i}`}
                  type="button"
                  role="option"
                  title={p.label}
                  dir="auto"
                  aria-selected={presetAt === i}
                  className="ui-drpc__preset"
                  onClick={() => choosePreset(p)}
                >
                  <span className="ui-drpc__preset-label">{p.label}</span>
                </button>
              ))}
              <span className="ui-drpc__preset ui-drpc__preset-custom" aria-hidden={!!preset} data-active={!preset || undefined}>
                {labels.custom}
              </span>
            </div>

            <div className="ui-drpc__cal">
              <div className="ui-drpc__nav">
                <button type="button" className="ui-drpc__icon-btn" aria-label={labels.previousMonth} onClick={() => shift(-1)}>
                  <Glyph d={icons.left} />
                </button>
                <button type="button" className="ui-drpc__icon-btn" aria-label={labels.nextMonth} onClick={() => shift(1)}>
                  <Glyph d={icons.right} />
                </button>
              </div>

              <div
                ref={grid}
                className="ui-drpc__months"
                key={month.getTime()}
                data-dir={dir}
                onKeyDown={onGridKey}
                onPointerLeave={() => !draft.end && setHover(null)}
                onPointerDown={() => (keyboard.current = false)}
              >
                {months.map((m, mi) => (
                  <div key={m.getTime()} className="ui-drpc__month" data-second={mi === 1 || undefined}>
                    <div className="ui-drpc__month-name" aria-live={mi === 0 ? "polite" : undefined}>
                      {fmtMonth.format(m)}
                    </div>
                    <div role="grid" aria-label={fmtMonth.format(m)} className="ui-drpc__grid">
                      <div role="row" className="ui-drpc__weekdays">
                        {weekdays.map((w) => (
                          <span key={w} role="columnheader" className="ui-drpc__weekday">
                            {w}
                          </span>
                        ))}
                      </div>
                      {Array.from({ length: rows }, (_, ri) => weeks(m, wso)[ri] ?? Array(7).fill(null)).map((week, wi) => (
                        <div role="row" key={wi} className="ui-drpc__week">
                          {week.map((d, di) => {
                            if (!d) return <span key={di} className="ui-drpc__day ui-drpc__day-empty" role="gridcell" />;
                            const isStart = same(d, shown.start);
                            const isEnd = same(d, shown.end);
                            const inMain = inRange(d, range);
                            const inCmp = !inMain && inRange(d, cmp);
                            const off = disabled(d);
                            return (
                              <span
                                key={di}
                                role="gridcell"
                                aria-selected={inMain || isStart || undefined}
                                className="ui-drpc__day"
                                data-range={inMain || undefined}
                                data-start={isStart || undefined}
                                data-end={isEnd || undefined}
                                data-preview={!draft.end && inMain || undefined}
                                data-compare={inCmp || undefined}
                                data-compare-start={cmp && same(d, cmp.start) || undefined}
                                data-compare-end={cmp && same(d, cmp.end) || undefined}
                                data-row-start={di === 0 || d.getDate() === 1 || undefined}
                                data-row-end={di === 6 || same(d, endOfMonth(d)) || undefined}
                                data-marked={marked?.(d) || undefined}
                              >
                                <button
                                  type="button"
                                  data-day={d.getTime()}
                                  tabIndex={same(d, focus) ? 0 : -1}
                                  disabled={off}
                                  aria-label={fmtLong.format(d)}
                                  aria-current={same(d, today) ? "date" : undefined}
                                  onClick={() => pick(d)}
                                  onPointerEnter={() => !draft.end && setHover(d)}
                                  onFocus={() => setFocus(d)}
                                >
                                  {d.getDate()}
                                </button>
                              </span>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          </div>

          <div className="ui-drpc__foot">
            <div className="ui-drpc__summary">
              <div className="ui-drpc__summary-range">
                <span key={`${shown.start.getTime()}-${shown.end.getTime()}`}>
                  {draft.end || hover ? formatRange(shown, formats) : labels.pickEnd(fmtDayYear.format(draft.start))}
                </span>
                <span className="ui-drpc__count" key={length}>
                  {labels.days(length, count.format(length))}
                </span>
              </div>
              {compare && (
                <div className="ui-drpc__compare">
                  <span className="ui-drpc__compare-label">Compare</span>
                  <div className="ui-drpc__segments" role="radiogroup" aria-label="Compare to">
                    {COMPARE.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        role="radio"
                        aria-checked={mode === c.id}
                        className="ui-drpc__segment"
                        onClick={() => setMode(c.id)}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {/* Folds open and closed; keeps the last text while folding away */}
              {compare && (
                <div className="ui-drpc__fold" data-open={!!cmp || undefined}>
                  <div>
                    {lastCompare.current && (
                      <div className="ui-drpc__compare-range" key={`${lastCompare.current.start.getTime()}-${lastCompare.current.end.getTime()}`}>
                        vs. {formatRange(lastCompare.current, formats)}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
            <div className="ui-drpc__buttons">
              <button type="button" className="ui-drpc__btn" onClick={() => close()}>
                {labels.cancel}
              </button>
              <button type="button" className="ui-drpc__btn ui-drpc__btn-primary" disabled={!draft.end} onClick={apply}>
                {labels.apply}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- Styles ---------- */

const css = /* css */ `
/* Colors and motion as variables – override them on .ui-drpc */
.ui-drpc {
  --ui-drpc-card: #ffffff;
  --ui-drpc-ink: rgba(0, 0, 0, 0.88);
  --ui-drpc-strong: #000000;
  --ui-drpc-text: rgba(0, 0, 0, 0.61);
  --ui-drpc-muted: rgba(0, 0, 0, 0.45);
  --ui-drpc-faint: rgba(0, 0, 0, 0.27);
  --ui-drpc-icon: rgba(0, 0, 0, 0.447);
  --ui-drpc-line: rgba(0, 0, 0, 0.06);
  --ui-drpc-wash: rgba(0, 0, 0, 0.03);
  --ui-drpc-fill: rgba(0, 0, 0, 0.06);
  --ui-drpc-fill-strong: rgba(0, 0, 0, 0.1);
  /* The picked range: dark chips at the ends, a light gray band between them */
  --ui-drpc-chip: rgba(0, 0, 0, 0.88);
  --ui-drpc-chip-hover: rgba(0, 0, 0, 0.78);
  --ui-drpc-on-chip: #fcfcfc;
  --ui-drpc-band: rgba(0, 0, 0, 0.06);
  --ui-drpc-band-preview: rgba(0, 0, 0, 0.04);
  /* The comparison period: a soft blue band with hairline ends */
  --ui-drpc-compare: rgba(0, 96, 226, 0.08);
  --ui-drpc-compare-edge: rgba(0, 96, 226, 0.4);
  --ui-drpc-accent: rgba(0, 96, 226, 0.765);
  --ui-drpc-today-on-chip: #6ea2ff;
  --ui-drpc-focus: rgba(0, 96, 226, 0.35);
  /* Strokes are shadows: a 0.5px hairline plus a soft lift */
  --ui-drpc-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.06), 0 1px 1px -1px rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --ui-drpc-shadow-hover: 0 0 0 0.5px rgba(0, 0, 0, 0.12), 0 1px 1px -1px rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --ui-drpc-shadow-pop: 0 0 0 0.5px rgba(0, 0, 0, 0.08), 0 12px 28px -10px rgba(0, 0, 0, 0.16), 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --ui-drpc-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --ui-drpc-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  position: relative;
  display: inline-block;
  max-width: 100%;
  font-family: "Inter", "InterVariable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  line-height: 20px;
  font-weight: 400;
  color: var(--ui-drpc-ink);
  -webkit-font-smoothing: antialiased;
}
.ui-drpc *, .ui-drpc *::before, .ui-drpc *::after { box-sizing: border-box; }
:where(.ui-drpc) button { margin: 0; padding: 0; border: 0; background: none; font: inherit; color: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }
:where(.ui-drpc) svg { display: block; flex: none; }
.ui-drpc button:focus-visible { outline: 2px solid var(--ui-drpc-focus); outline-offset: 1px; }
/* 16px icons with thin ~1.1px lines */
.ui-drpc__glyph { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.65; stroke-linecap: round; stroke-linejoin: round; }

/* The trigger: a white one-line field with the hairline shadow; its width glides to the new text */
.ui-drpc__trigger {
  display: inline-flex;
  align-items: center;
  overflow: hidden;
  max-width: 100%;
  height: 32px;
  padding: 0 8px;
  border-radius: 8px;
  background: var(--ui-drpc-card);
  box-shadow: var(--ui-drpc-shadow);
  text-align: left;
  transition: box-shadow 160ms ease, width 320ms var(--ui-drpc-ease);
}
.ui-drpc__trigger:hover { box-shadow: var(--ui-drpc-shadow-hover); }
.ui-drpc__trigger-inner { display: inline-flex; flex: none; align-items: center; gap: 8px; max-width: calc(100vw - 56px); color: var(--ui-drpc-icon); }
.ui-drpc__trigger-text { display: flex; align-items: baseline; gap: 6px; min-width: 0; white-space: nowrap; animation: ui-drpc-in 240ms var(--ui-drpc-ease) both; }
.ui-drpc__trigger-range { flex: 0 0 auto; max-width: 100%; overflow: hidden; color: var(--ui-drpc-ink); font-weight: 500; text-overflow: ellipsis; }
/* The comparison stays on the same line and gives way first when space runs out */
.ui-drpc__trigger-compare { flex: 0 1 auto; min-width: 0; overflow: hidden; font-size: 12px; line-height: 16px; color: var(--ui-drpc-muted); text-overflow: ellipsis; }
.ui-drpc__chevron { transition: transform 260ms var(--ui-drpc-ease); }
.ui-drpc[data-open] .ui-drpc__chevron { transform: rotate(180deg); }

/* The panel: one white popover; the calendars glide to their height, the last row sits below them */
.ui-drpc__panel {
  position: absolute;
  z-index: 30;
  top: calc(100% + 6px);
  left: 0;
  container-type: inline-size;
  /* A fixed width (not max-content), so the container queries below can measure it; override --ui-drpc-panel-width to fit your layout */
  width: var(--ui-drpc-panel-width, min(652px, calc(100vw - 32px)));
  overflow: hidden;
  border-radius: 10px;
  background: var(--ui-drpc-card);
  box-shadow: var(--ui-drpc-shadow-pop);
  transform-origin: top left;
  animation: ui-drpc-open 240ms var(--ui-drpc-ease) both;
}
.ui-drpc[data-align="end"] .ui-drpc__panel { left: auto; right: 0; transform-origin: top right; }
.ui-drpc__clip { overflow: hidden; transition: height 320ms var(--ui-drpc-ease); }
.ui-drpc__body { display: grid; grid-template-columns: 140px 1fr; }

/* Presets: tab-style rows – gray text, the active one gets the gray fill (no gliding highlight) */
.ui-drpc__presets { position: relative; display: flex; flex-direction: column; gap: 2px; padding: 4px; border-right: 0.5px solid var(--ui-drpc-line); }
.ui-drpc__preset {
  display: flex;
  align-items: center;
  flex: none;
  height: 28px;
  padding: 0 10px;
  border-radius: 6px;
  text-align: left;
  white-space: nowrap;
  font-weight: 500;
  color: var(--ui-drpc-text);
  transition: background-color 120ms ease, color 120ms ease;
}
/* A long label shortens inside its row – the full text is the tooltip */
.ui-drpc__preset { max-width: 100%; min-width: 0; }
.ui-drpc__preset-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
button.ui-drpc__preset:hover:not([aria-selected="true"]) { background: var(--ui-drpc-wash); color: var(--ui-drpc-ink); }
.ui-drpc__preset[aria-selected="true"], .ui-drpc__preset-custom[data-active] { background: var(--ui-drpc-fill); color: var(--ui-drpc-ink); }
.ui-drpc__preset-custom { margin-top: auto; color: var(--ui-drpc-faint); cursor: default; }

/* Calendars */
.ui-drpc__cal { position: relative; padding: 10px 12px 10px; overflow: hidden; }
.ui-drpc__nav { position: absolute; top: 10px; left: 12px; right: 12px; z-index: 1; display: flex; justify-content: space-between; pointer-events: none; }
.ui-drpc__nav > * { pointer-events: auto; }
.ui-drpc__icon-btn { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 6px; color: var(--ui-drpc-icon); transition: background-color 120ms ease, color 120ms ease; }
.ui-drpc__icon-btn:hover { background: var(--ui-drpc-wash); color: var(--ui-drpc-ink); }
.ui-drpc__months { display: grid; grid-template-columns: repeat(2, auto); justify-content: center; gap: 24px; animation: ui-drpc-slide 320ms var(--ui-drpc-ease) both; }
.ui-drpc__months[data-dir="-1"] { animation-name: ui-drpc-slide-back; }
.ui-drpc__month-name { height: 28px; margin-bottom: 4px; font-weight: 500; line-height: 28px; text-align: center; color: var(--ui-drpc-strong); }
.ui-drpc__grid { display: grid; gap: 2px; }
.ui-drpc__weekdays, .ui-drpc__week { display: grid; grid-template-columns: repeat(7, 32px); }
.ui-drpc__weekday { height: 24px; font-size: 10px; font-weight: 500; line-height: 24px; letter-spacing: 0.5px; text-transform: uppercase; text-align: center; color: var(--ui-drpc-muted); }

/* A day: the band sits behind the number and runs on into its neighbours */
.ui-drpc__day { position: relative; display: grid; height: 32px; }
.ui-drpc__day::before { content: ""; position: absolute; inset: 2px 0; transition: background-color 160ms ease, border-radius 220ms var(--ui-drpc-ease), left 220ms var(--ui-drpc-ease), right 220ms var(--ui-drpc-ease); }
.ui-drpc__day[data-range]::before { background: var(--ui-drpc-band); }
.ui-drpc__day[data-preview]::before { background: var(--ui-drpc-band-preview); }
.ui-drpc__day[data-compare]::before { background: var(--ui-drpc-compare); }
.ui-drpc__day[data-start]::before, .ui-drpc__day[data-compare-start]::before, .ui-drpc__day[data-row-start]::before { left: 2px; border-top-left-radius: 6px; border-bottom-left-radius: 6px; }
.ui-drpc__day[data-end]::before, .ui-drpc__day[data-compare-end]::before, .ui-drpc__day[data-row-end]::before { right: 2px; border-top-right-radius: 6px; border-bottom-right-radius: 6px; }
.ui-drpc__day button {
  position: relative;
  margin: 2px;
  border-radius: 6px;
  font-size: 13px;
  line-height: 20px;
  font-variant-numeric: tabular-nums;
  color: var(--ui-drpc-ink);
  transition: background-color 120ms ease, color 120ms ease, box-shadow 120ms ease, transform 160ms var(--ui-drpc-ease);
}
.ui-drpc__day button:hover:not(:disabled) { background: var(--ui-drpc-fill); }
.ui-drpc__day button:active:not(:disabled) { transform: scale(0.94); }
.ui-drpc__day button:disabled { color: var(--ui-drpc-faint); cursor: default; }
/* Today: a small blue dot under the number */
.ui-drpc__day button[aria-current="date"] { color: var(--ui-drpc-accent); font-weight: 500; }
.ui-drpc__day button[aria-current="date"]::after { content: ""; position: absolute; left: 50%; bottom: 3px; width: 4px; height: 4px; margin-left: -2px; border-radius: 50%; background: var(--ui-drpc-accent); }
/* Kettu: a marked day's dot, fainter than today's */
.ui-drpc__day[data-marked] button:not([aria-current="date"])::after { content: ""; position: absolute; left: 50%; bottom: 3px; width: 3px; height: 3px; margin-left: -1.5px; border-radius: 50%; background: currentColor; opacity: .35; }
/* The ends of the range: dark chips */
.ui-drpc__day[data-start] button, .ui-drpc__day[data-end] button { background: var(--ui-drpc-chip) !important; color: var(--ui-drpc-on-chip); font-weight: 500; box-shadow: none !important; animation: ui-drpc-pick 380ms var(--ui-drpc-spring); }
.ui-drpc__day[data-start] button[aria-current="date"]::after, .ui-drpc__day[data-end] button[aria-current="date"]::after { background: var(--ui-drpc-today-on-chip); }
/* While previewing, the end follows the pointer – no pop on every move */
.ui-drpc__day[data-preview][data-end] button { animation: none; }
.ui-drpc__day[data-compare-start] button, .ui-drpc__day[data-compare-end] button { box-shadow: inset 0 0 0 0.5px var(--ui-drpc-compare-edge); }
.ui-drpc__day-empty::before { display: none; }

/* The last row, under a hairline: summary and compare on the left, Cancel / Apply on the right */
.ui-drpc__foot { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; padding: 10px 10px 10px 14px; border-top: 0.5px solid var(--ui-drpc-line); }
.ui-drpc__summary { display: grid; gap: 8px; min-width: 0; }
.ui-drpc__summary-range { display: flex; align-items: baseline; gap: 8px; min-width: 0; white-space: nowrap; color: var(--ui-drpc-strong); font-weight: 500; }
.ui-drpc__summary-range > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; animation: ui-drpc-in 240ms var(--ui-drpc-ease) both; }
.ui-drpc__count { flex: none; font-size: 12px; line-height: 16px; font-weight: 400; font-variant-numeric: tabular-nums; color: var(--ui-drpc-muted); animation: ui-drpc-in 240ms var(--ui-drpc-ease) both; }
.ui-drpc__compare { display: flex; align-items: center; gap: 8px; }
.ui-drpc__compare-label { font-size: 12px; line-height: 16px; color: var(--ui-drpc-muted); }
/* Compare: tab-style buttons with a hairline, the active one filled */
.ui-drpc__segments { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.ui-drpc__segment { padding: 4px 10px; border-radius: 6px; box-shadow: inset 0 0 0 0.5px var(--ui-drpc-line); font-weight: 500; white-space: nowrap; color: var(--ui-drpc-text); transition: background-color 120ms ease, color 120ms ease; }
.ui-drpc__segment:hover:not([aria-checked="true"]) { background: var(--ui-drpc-wash); color: var(--ui-drpc-ink); }
.ui-drpc__segment[aria-checked="true"] { background: var(--ui-drpc-fill); color: var(--ui-drpc-ink); }
.ui-drpc__fold { display: grid; grid-template-rows: 0fr; opacity: 0; margin-top: -8px; transition: grid-template-rows 300ms var(--ui-drpc-ease), opacity 200ms ease, margin-top 300ms var(--ui-drpc-ease); }
.ui-drpc__fold[data-open] { grid-template-rows: 1fr; opacity: 1; margin-top: 0; }
.ui-drpc__fold > div { min-height: 0; overflow: hidden; }
.ui-drpc__compare-range { display: flex; align-items: center; gap: 6px; font-size: 12px; line-height: 16px; color: var(--ui-drpc-muted); animation: ui-drpc-in 220ms var(--ui-drpc-ease) both; }
.ui-drpc__compare-range::before { content: ""; flex: none; width: 14px; height: 8px; border-radius: 3px; background: var(--ui-drpc-compare); box-shadow: inset 0 0 0 0.5px var(--ui-drpc-compare-edge); }
.ui-drpc__buttons { display: flex; flex: none; gap: 8px; }
.ui-drpc__btn {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 10px;
  border-radius: 6px;
  background: var(--ui-drpc-card);
  box-shadow: var(--ui-drpc-shadow);
  font-weight: 500;
  color: var(--ui-drpc-strong);
  transition: background-color 140ms ease, box-shadow 140ms ease, opacity 140ms ease, transform 140ms ease;
}
.ui-drpc__btn:not(.ui-drpc__btn-primary):hover { box-shadow: var(--ui-drpc-shadow-hover); }
.ui-drpc__btn-primary { background: var(--ui-drpc-chip); box-shadow: none; color: var(--ui-drpc-on-chip); }
.ui-drpc__btn-primary:hover:not(:disabled) { background: var(--ui-drpc-chip-hover); }
.ui-drpc__btn:active:not(:disabled) { transform: scale(0.97); }
.ui-drpc__btn-primary:disabled { opacity: 0.35; cursor: default; }

@keyframes ui-drpc-open { from { opacity: 0; transform: translateY(-4px) scale(0.98); } to { opacity: 1; transform: none; } }
@keyframes ui-drpc-slide { from { opacity: 0; transform: translateX(14px); } to { opacity: 1; transform: none; } }
@keyframes ui-drpc-slide-back { from { opacity: 0; transform: translateX(-14px); } to { opacity: 1; transform: none; } }
@keyframes ui-drpc-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
@keyframes ui-drpc-pick { 0% { transform: scale(0.82); } 60% { transform: scale(1.06); } 100% { transform: scale(1); } }

/* Narrow panel (phones): presets as a scrolling row of tab chips, one month, stacked last row */
@container (max-width: 600px) {
  .ui-drpc__body { grid-template-columns: 1fr; }
  .ui-drpc__presets {
    flex-direction: row;
    gap: 4px;
    padding: 8px;
    overflow-x: auto;
    border-right: 0;
    border-bottom: 0.5px solid var(--ui-drpc-line);
    scrollbar-width: none;
  }
  .ui-drpc__presets::-webkit-scrollbar { display: none; }
  .ui-drpc__preset { height: auto; padding: 4px 10px; box-shadow: inset 0 0 0 0.5px var(--ui-drpc-line); }
  .ui-drpc__preset-custom { display: none; }
  .ui-drpc__months { grid-template-columns: 1fr; justify-items: center; }
  /* One month: the one the range ends in */
  .ui-drpc__month:not([data-second]) { display: none; }
  .ui-drpc__foot { flex-direction: column; align-items: stretch; padding: 10px 10px 10px 12px; }
  .ui-drpc__buttons { justify-content: flex-end; }
  .ui-drpc__compare { flex-wrap: wrap; }
}
@container (max-width: 340px) {
  .ui-drpc__weekdays, .ui-drpc__week { grid-template-columns: repeat(7, 1fr); }
  .ui-drpc__cal { padding: 10px 8px; }
  .ui-drpc__nav { left: 8px; right: 8px; }
  .ui-drpc__months { justify-items: stretch; }
}
/* Touch screens: bigger targets */
@media (hover: none) and (pointer: coarse) {
  .ui-drpc__trigger { height: 40px; }
  .ui-drpc__day { height: 40px; }
  .ui-drpc__weekdays, .ui-drpc__week { grid-template-columns: repeat(7, minmax(0, 40px)); }
  .ui-drpc__icon-btn { width: 36px; height: 36px; }
  .ui-drpc__month-name { height: 36px; line-height: 36px; }
  .ui-drpc__preset { height: 36px; }
  .ui-drpc__btn { height: 36px; padding: 0 14px; }
  .ui-drpc__segment { padding: 8px 12px; }
}
@media (prefers-reduced-motion: reduce) {
  .ui-drpc *, .ui-drpc *::before, .ui-drpc *::after { animation: none !important; transition: none !important; }
}

/* Dark mode: follows a .dark class or data-theme="dark" on any ancestor, e.g. <html> */
:where(.dark, [data-theme="dark"]) .ui-drpc {
  --ui-drpc-card: #1c1c1e;
  --ui-drpc-ink: rgba(255, 255, 255, 0.9);
  --ui-drpc-strong: #ffffff;
  --ui-drpc-text: rgba(255, 255, 255, 0.62);
  --ui-drpc-muted: rgba(255, 255, 255, 0.46);
  --ui-drpc-faint: rgba(255, 255, 255, 0.3);
  --ui-drpc-icon: rgba(255, 255, 255, 0.5);
  --ui-drpc-line: rgba(255, 255, 255, 0.08);
  --ui-drpc-wash: rgba(255, 255, 255, 0.04);
  --ui-drpc-fill: rgba(255, 255, 255, 0.08);
  --ui-drpc-fill-strong: rgba(255, 255, 255, 0.13);
  --ui-drpc-chip: rgba(255, 255, 255, 0.9);
  --ui-drpc-chip-hover: rgba(255, 255, 255, 0.8);
  --ui-drpc-on-chip: #111113;
  --ui-drpc-band: rgba(255, 255, 255, 0.08);
  --ui-drpc-band-preview: rgba(255, 255, 255, 0.05);
  --ui-drpc-compare: rgba(77, 141, 255, 0.14);
  --ui-drpc-compare-edge: rgba(77, 141, 255, 0.55);
  --ui-drpc-accent: #4d8dff;
  --ui-drpc-today-on-chip: #0060e2;
  --ui-drpc-focus: rgba(77, 141, 255, 0.5);
  --ui-drpc-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.4);
  --ui-drpc-shadow-hover: 0 0 0 0.5px rgba(255, 255, 255, 0.18), 0 1px 2px 0 rgba(0, 0, 0, 0.4);
  --ui-drpc-shadow-pop: 0 0 0 0.5px rgba(255, 255, 255, 0.1), 0 12px 28px -10px rgba(0, 0, 0, 0.6), 0 1px 2px 0 rgba(0, 0, 0, 0.4);
}
`;
