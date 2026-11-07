// affectUI Pro - licensed under https://www.affectui.com/license, not under this project's open-source license. Don't copy it out of this project.
"use client";

import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

/*
 * Model Picker (clean style) – the model menu of an AI chat, in a single self-contained file.
 * Clean style: one white popover with hairline shadows, Inter 13px, a blue accent – no gray tray.
 * A small trigger (glyph, model name, chevron) sits in your composer toolbar; it opens a menu that unfolds softly from it:
 *   · one row per model with three tiny strength bars – Speed, Quality, Cost. Point at a row and its bars fill,
 *     the other rows step back
 *   · Extended thinking and Web search as switches; the Effort control (Low / Medium / High) unfolds under thinking
 *   · the last row of the menu says what the model you point at costs you – first-token time and price –
 *     and its numbers roll when the model or the effort changes
 *   · arrows move, Enter picks, Tab reaches the switches, Esc or a click outside closes
 * The styles are injected below, so no extra files are needed.
 */

export type PickerModel = {
  id: string;
  name: string;
  /** One short line under the name, e.g. "Hardest problems" */
  description?: string;
  /** Glyph in front of the name – any node, sized to 18px. Defaults to the first letter on a soft tile */
  icon?: ReactNode;
  /** Strengths from 1 to 5. Cost 5 is the most expensive. Leave all three out for a router like "Auto" */
  speed?: number;
  quality?: number;
  cost?: number;
  /** Typical time to the first token without extended thinking, in milliseconds */
  latencyMs?: number;
  /** Price per million output tokens, in dollars */
  pricePerM?: number;
};

export type ModelEffort = string;

/** A switch of your own in place of Extended thinking and Web search */
export type PickerToggle = {
  id: string;
  label: string;
  icon?: ReactNode;
  /** What the last row says while the switch is pointed at */
  hint?: string;
  defaultOn?: boolean;
  disabled?: boolean;
  /** Shows "· label" on the trigger while on, unfolding and folding away like a flag */
  indicator?: boolean;
  /** Unfolds the switch's icon next to the model name while on, like the thinking bulb */
  flag?: boolean;
  /** The label as the row and the trigger show it while on, such as words with a light running through them */
  onLabel?: ReactNode;
  /** A background for the menu while the switch is on, such as a glow rising from its bottom edge; it fades in and out */
  effect?: ReactNode;
  /** Whether it is on (controlled); report changes through `onToggle` */
  on?: boolean;
  /** A small row under the switch that hands the value back, such as to a setting it overrides */
  reset?: { label: string; onReset: () => void };
};

/** Words the picker shows and says – pass your own to translate them */
export type PickerLabels = {
  model: string;
  settings: string;
  speed: string;
  quality: string;
  cost: string;
  varies: string;
  moreModels: string;
  searchModels: string;
  noModels: string;
  noMatch: string;
  /** The trigger with no model chosen */
  choose: string;
};

const defaultLabels: PickerLabels = {
  model: "Model",
  settings: "Model settings",
  speed: "Speed",
  quality: "Quality",
  cost: "Cost",
  varies: "Varies",
  moreModels: "More models",
  searchModels: "Search models",
  noModels: "No models available",
  noMatch: "No models match",
  choose: "Choose a model",
};

export type ModelPickerProps = {
  models: PickerModel[];
  /** Id of the chosen model (controlled) */
  value?: string;
  defaultValue?: string;
  onChange?: (id: string) => void;
  /** Extended thinking switch */
  thinking?: boolean;
  defaultThinking?: boolean;
  onThinkingChange?: (on: boolean) => void;
  /** Web search switch */
  webSearch?: boolean;
  defaultWebSearch?: boolean;
  onWebSearchChange?: (on: boolean) => void;
  /** How hard the model thinks – only shown while extended thinking is on */
  effort?: ModelEffort;
  defaultEffort?: ModelEffort;
  onEffortChange?: (effort: ModelEffort) => void;
  /** Controlled open state of the menu */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Which edge of the trigger the menu lines up with */
  align?: "start" | "end";
  /** Whether the menu opens below or above the trigger – above suits a composer at the bottom of the screen. When that
   * side has too little room and the other has more, it opens on the other side */
  side?: "bottom" | "top";
  className?: string;
  /** Your own line on top of the list, in place of "Model" */
  heading?: ReactNode;
  /** Your own effort levels; the first one is the default and the control shows without thinking */
  efforts?: { id: string; label: string }[];
  effortLabel?: string;
  /** What the last row says while the effort control is pointed at */
  effortHint?: string;
  /** Your own switches in place of Extended thinking and Web search */
  toggles?: PickerToggle[];
  /** Models behind a "More models" row, with a search field */
  more?: PickerModel[];
  /** Number keys 1–4 on the first rows */
  keys?: boolean;
  /** What the last row says for models without first-token time or price, in place of their description */
  note?: ReactNode;
  /** A switch was flipped; with `on` on the toggles the parent keeps their values */
  onToggle?: (id: string, on: boolean) => void;
  /** A quiet line at the foot of the More models card, such as where the list comes from */
  moreNote?: ReactNode;
  /** Something before the glyph on the trigger, such as a warning dot */
  triggerLead?: ReactNode;
  /** The trigger's accessible name in place of "Model: …" */
  triggerLabel?: string;
  labels?: Partial<PickerLabels>;
};

/* ---------- Helpers ---------- */

const EFFORTS: { id: ModelEffort; label: string }[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];
/** How much longer the first token takes while the model thinks first */
const THINK_FACTOR: Record<ModelEffort, number> = { low: 1.6, medium: 2.5, high: 4 };
const STRENGTHS = [
  { key: "speed", label: "Speed" },
  { key: "quality", label: "Quality" },
  { key: "cost", label: "Cost" },
] as const;

const ease = (t: number) => 1 - Math.pow(1 - t, 4);
const reduced = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const clamp = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(5, Math.round(n))) : 0);
const pad = (n: number) => String(n).padStart(2, "0");
/** 2.1s under a minute, then 2m 05s and 1h 04m – a long think never reads 125.0s */
const seconds = (ms: number) => {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${pad(Math.floor(s % 60))}s`;
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
};
/** $25, $3.75, $12,345.50 – and <$0.01 for a price that would round to nothing */
const dollars = (n: number, target: number) => {
  if (target > 0 && target < 0.01) return "<$0.01";
  const digits = Number.isInteger(target) ? 0 : 2;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
};
/** A number the API sent broken (NaN, Infinity) counts as not given */
const finite = (n: number | undefined) => (n !== undefined && Number.isFinite(n) ? n : undefined);
/** The first whole letter or digit – never half an emoji */
const initial = (name: string) => (name.match(/[\p{L}\p{N}]/u)?.[0] ?? "").toUpperCase();

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
      for (const k in to)
        next[k] = (from[k] ?? to[k]) + (to[k] - (from[k] ?? to[k])) * e;
      current.current = next;
      setShown(next);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [signature, duration]);
  return shown;
}

/**
 * Text that changes without a jump: the old line stays for a moment and fades out underneath while the new one fades in.
 * Quick changes just retarget – nothing piles up. With `glide` its width also glides to the new text's, as the flags do.
 */
function Swap({ id, children, glide = false }: { id: string; children: ReactNode; glide?: boolean }) {
  type Line = { id: string; node: ReactNode };
  const last = useRef<Line>({ id, node: children });
  const [shownId, setShownId] = useState(id);
  const [out, setOut] = useState<Line | null>(null);
  if (shownId !== id) {
    setShownId(id);
    setOut(last.current);
  }
  last.current = { id, node: children };
  useEffect(() => {
    if (!out) return;
    const timer = window.setTimeout(() => setOut(null), 260);
    return () => window.clearTimeout(timer);
  }, [out]);
  // The new line's own width, read before paint; the box then glides there from the old one
  const inRef = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (glide && inRef.current) setWidth(inRef.current.scrollWidth);
  }, [glide, id]);
  return (
    <span className="ui-mdpc__swap" data-glide={glide ? "" : undefined} style={glide && width !== null ? { width } : undefined}>
      {out && (
        <span key={`out-${out.id}`} className="ui-mdpc__swap-item" data-out="" aria-hidden="true">
          {out.node}
        </span>
      )}
      <span key={id} ref={inRef} className="ui-mdpc__swap-item" dir="auto">
        {children}
      </span>
    </span>
  );
}

/* ---------- Icons ---------- */

const line = {
  stroke: "currentColor",
  strokeWidth: 1.2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;
const ChevronIcon = () => (
  <svg className="ui-mdpc__chevron" width="14" height="14" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="m3 4.5 3 3 3-3" {...line} />
  </svg>
);
const CheckIcon = () => (
  <svg className="ui-mdpc__check" width="16" height="16" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <path d="m3.4 7.3 2.4 2.4 4.8-5.2" {...line} strokeWidth={1.3} />
  </svg>
);
const ThinkIcon = () => (
  <svg width="16" height="16" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <path d="M5.3 10.6h3.4M5.8 12.3h2.4M7 1.7a3.9 3.9 0 0 0-2.3 7c.4.3.6.7.6 1.1v.1h3.4v-.1c0-.4.2-.8.6-1.1A3.9 3.9 0 0 0 7 1.7Z" {...line} />
  </svg>
);
const GlobeIcon = () => (
  <svg width="16" height="16" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <circle cx="7" cy="7" r="5.3" {...line} />
    <path d="M1.9 7h10.2M7 1.7c1.4 1.5 2 3.3 2 5.3s-.6 3.8-2 5.3c-1.4-1.5-2-3.3-2-5.3s.6-3.8 2-5.3Z" {...line} />
  </svg>
);

function Glyph({ model }: { model: PickerModel }) {
  return (
    <span className="ui-mdpc__glyph" aria-hidden="true">
      {model.icon ?? initial(model.name)}
    </span>
  );
}

type OptionProps = {
  model: PickerModel;
  index: number;
  optionId: string;
  selected: boolean;
  active: boolean;
  lit: boolean;
  onPoint: (index: number) => void;
  onPick: (index: number) => void;
};

/** One model row – memoized, so pointing at a row in a long list stays quick */
const Option = memo(function Option({ model: m, index: i, optionId, selected, active, lit, varies, onPoint, onPick }: OptionProps & { varies: string }) {
  const rated = m.speed !== undefined || m.quality !== undefined || m.cost !== undefined;
  return (
    <div
      id={optionId}
      role="option"
      aria-selected={selected}
      aria-label={`${m.name}${m.description ? `, ${m.description}` : ""}${rated ? `. Speed ${clamp(m.speed ?? 0)}, quality ${clamp(m.quality ?? 0)}, cost ${clamp(m.cost ?? 0)} of 5` : ""}`}
      className="ui-mdpc__option"
      data-active={active ? "" : undefined}
      data-lit={lit ? "" : undefined}
      onPointerEnter={(e) => {
        if (e.pointerType !== "mouse") return;
        onPoint(i);
      }}
      onClick={() => onPick(i)}
    >
      <Glyph model={m} />
      <span className="ui-mdpc__text">
        <span className="ui-mdpc__title">
          <span className="ui-mdpc__title-name" dir="auto" title={m.name}>
            {m.name}
          </span>
          {selected && <CheckIcon />}
        </span>
        {m.description && (
          <span className="ui-mdpc__desc" dir="auto" title={m.description}>
            {m.description}
          </span>
        )}
      </span>
      {rated ? (
        <span className="ui-mdpc__bars" aria-hidden="true">
          {STRENGTHS.map((s, c) => {
            const level = clamp(m[s.key] ?? 0);
            return (
              <span key={s.key} className="ui-mdpc__meter" style={{ ["--c" as string]: c }}>
                {[0, 1, 2, 3, 4].map((k) => (
                  <span key={k} className="ui-mdpc__seg" data-on={k < level ? "" : undefined} style={{ ["--s" as string]: k }} />
                ))}
              </span>
            );
          })}
        </span>
      ) : (
        <span className="ui-mdpc__varies" aria-hidden="true">
          {varies}
        </span>
      )}
    </div>
  );
});

export function ModelPicker({
  models: baseModels,
  value,
  defaultValue,
  onChange,
  thinking,
  defaultThinking = false,
  onThinkingChange,
  webSearch,
  defaultWebSearch = false,
  onWebSearchChange,
  effort,
  defaultEffort = "medium",
  onEffortChange,
  open,
  defaultOpen = false,
  onOpenChange,
  align = "start",
  side = "bottom",
  className,
  heading,
  efforts = EFFORTS,
  effortLabel = "Effort",
  effortHint,
  toggles,
  more = [],
  keys = false,
  note,
  onToggle,
  moreNote,
  triggerLead,
  triggerLabel,
  labels: ownLabels,
}: ModelPickerProps) {
  const labels = { ...defaultLabels, ...ownLabels };
  const uid = useId();
  // More models open in a second card beside the menu, with a search field
  const [flyOpen, setFlyOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [flyActive, setFlyActive] = useState(0);
  const shownMore = more.filter((m) => m.name.toLowerCase().includes(query.trim().toLowerCase()));
  const models = baseModels;
  const anyRated = models.some((m) => m.speed !== undefined || m.quality !== undefined || m.cost !== undefined);
  const ownEffort = efforts !== EFFORTS;
  const [ownToggleOn, setToggleOn] = useState<Record<string, boolean>>(() =>
    Object.fromEntries((toggles ?? []).map((t) => [t.id, !!t.defaultOn])),
  );
  // A switch given `on` follows it; the others keep their own value
  const toggleOn: Record<string, boolean> = { ...ownToggleOn };
  for (const t of toggles ?? []) if (t.on !== undefined) toggleOn[t.id] = t.on;
  const flip = (id: string) => {
    const next = !toggleOn[id];
    setToggleOn((on) => ({ ...on, [id]: next }));
    onToggle?.(id, next);
  };
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Every value works on its own; pass the value and its callback to keep the truth outside
  const [innerValue, setInnerValue] = useState(defaultValue ?? models[0]?.id);
  const [innerThinking, setInnerThinking] = useState(defaultThinking);
  const [innerSearch, setInnerSearch] = useState(defaultWebSearch);
  const [innerEffort, setInnerEffort] = useState<ModelEffort>(ownEffort && defaultEffort === "medium" ? efforts[0].id : defaultEffort);
  const [innerOpen, setInnerOpen] = useState(defaultOpen);
  const chosenId = value ?? innerValue;
  const isThinking = thinking ?? innerThinking;
  const isSearching = webSearch ?? innerSearch;
  const effortNow = effort ?? innerEffort;
  const isOpen = open ?? innerOpen;

  // The chosen model may be one of the more models; then no row of the main list is checked
  const chosen = baseModels.concat(more).find((m) => m.id === chosenId) ?? models[0];
  const chosenIndex = models.findIndex((m) => m.id === chosen?.id);
  const startIndex = Math.max(0, chosenIndex);

  /** The row the arrows (or the pointer) are on, and whether someone is actually pointing at a row */
  const [active, setActive] = useState(startIndex);
  const [pointing, setPointing] = useState(false);
  /** A switch under the pointer or the focus – the last row then talks about it */
  const [hint, setHint] = useState<string | null>(null);

  const lit = models[pointing ? active : chosenIndex] ?? chosen;

  /* ---------- Opening and closing ---------- */

  const setOpen = (next: boolean, focus?: "list" | "trigger") => {
    if (next !== isOpen) {
      if (next) {
        setActive(startIndex);
        setPointing(false);
      } else {
        setHint(null);
        setFlyOpen(false);
        setQuery("");
      }
      setInnerOpen(next);
      onOpenChange?.(next);
    }
    // Focus only moves for people – a parent opening the menu through `open` leaves the focus where it is
    if (focus === "list") requestAnimationFrame(() => listRef.current?.focus({ preventScroll: true }));
    if (focus === "trigger") triggerRef.current?.focus({ preventScroll: true });
  };
  // The parent may open the menu itself – start on the chosen row
  const wasOpen = useRef(isOpen);
  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      setActive(startIndex);
      setPointing(false);
    }
    wasOpen.current = isOpen;
  }, [isOpen, startIndex]);

  // Near the edge of the screen the menu slides in just enough to stay whole
  const popRef = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  const [placedSide, setPlacedSide] = useState(side);
  // A switch's effect shows while the menu is open and the switch is on, and stays a moment to fade out
  const glowId = isOpen ? toggles?.find((t) => t.effect && toggleOn[t.id])?.id : undefined;
  const [glow, setGlow] = useState<{ id: string; leaving?: boolean } | null>(null);
  useEffect(() => {
    if (glowId) {
      setGlow({ id: glowId });
      return;
    }
    setGlow((g) => (g && !g.leaving ? { ...g, leaving: true } : g));
    const timer = window.setTimeout(() => setGlow(null), 420);
    return () => window.clearTimeout(timer);
  }, [glowId]);
  // The height the menu may take when neither side has room for all of it; its list of models scrolls
  const [room, setRoom] = useState<number | null>(null);
  const [flySide, setFlySide] = useState<"right" | "left">("right");
  useLayoutEffect(() => {
    if (!isOpen) return;
    const measure = () => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      const width = popRef.current?.offsetWidth ?? 0;
      if (!trigger || !width) return;
      const room = document.documentElement.clientWidth;
      const left = align === "end" ? trigger.right - width : trigger.left;
      const margin = 12;
      // The asked-for side unless the menu doesn't fit there and the other side has more room; measured at its full
      // height, without the limit an earlier measure set
      const pop = popRef.current;
      const limit = pop?.style.getPropertyValue("--ui-mdpc-room") ?? "";
      pop?.style.removeProperty("--ui-mdpc-room");
      const height = pop?.offsetHeight ?? 0;
      if (limit) pop?.style.setProperty("--ui-mdpc-room", limit);
      const above = trigger.top - 6 - margin;
      const below = document.documentElement.clientHeight - trigger.bottom - 6 - margin;
      const fits = (side === "top" ? above : below) >= height;
      const placed = fits ? side : side === "top" ? (below > above ? "bottom" : "top") : above > below ? "top" : "bottom";
      const avail = placed === "top" ? above : below;
      setPlacedSide(placed);
      setRoom(height > avail ? Math.max(200, avail) : null);
      const next =
        left < margin
          ? margin - left
          : left + width > room - margin
            ? Math.min(0, room - margin - (left + width))
            : 0;
      setShift(next);
      // The more models card (260px) goes right of the menu when it fits, else left; the row's chevron points there
      setFlySide(left + next + width + 6 + 260 <= room - margin ? "right" : "left");
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [isOpen, align, side]);

  // While open, a press outside closes it
  useEffect(() => {
    if (!isOpen) return;
    const down = (e: globalThis.PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", down);
    return () => document.removeEventListener("pointerdown", down);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const focusInside = () => rootRef.current?.contains(document.activeElement) ?? false;

  /* ---------- Changing things ---------- */

  const pickModel = (m: PickerModel | undefined) => {
    if (!m) return;
    setInnerValue(m.id);
    if (m.id !== chosenId) onChange?.(m.id);
    setOpen(false, focusInside() ? "trigger" : undefined);
  };
  const pick = (index: number) => pickModel(models[index]);

  /* ---------- The more models card ---------- */

  const moreRef = useRef<HTMLDivElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const flyRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const flyTimer = useRef(0);
  const [flyTop, setFlyTop] = useState(0);
  const openFly = (focus: boolean) => {
    window.clearTimeout(flyTimer.current);
    if (!flyOpen) setFlyActive(0);
    setFlyOpen(true);
    if (focus) requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
  };
  const closeFly = (focusRow?: boolean) => {
    window.clearTimeout(flyTimer.current);
    setFlyOpen(false);
    setQuery("");
    if (focusRow) moreBtnRef.current?.focus({ preventScroll: true });
  };
  // Pointing opens it after a beat and leaving closes it after a longer one, so the pointer can cross the gap
  const openFlySoon = () => {
    window.clearTimeout(flyTimer.current);
    flyTimer.current = window.setTimeout(() => openFly(false), 90);
  };
  const closeFlySoon = () => {
    window.clearTimeout(flyTimer.current);
    flyTimer.current = window.setTimeout(() => {
      if (!flyRef.current?.contains(document.activeElement)) closeFly();
    }, 220);
  };
  useEffect(() => () => window.clearTimeout(flyTimer.current), []);
  // Beside the menu on the side with room, level with the More models row and never lower than the menu
  useLayoutEffect(() => {
    if (!flyOpen) return;
    const pop = popRef.current;
    const row = moreRef.current;
    const fly = flyRef.current;
    if (!pop || !row || !fly) return;
    const box = pop.getBoundingClientRect();
    setFlySide(box.right + 6 + fly.offsetWidth <= document.documentElement.clientWidth - 12 ? "right" : "left");
    setFlyTop(Math.max(0, Math.min(row.offsetTop - 4, pop.offsetHeight - fly.offsetHeight)));
  }, [flyOpen, query]);
  const onFlyKey = (e: KeyboardEvent) => {
    const n = shownMore.length;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeFly(true);
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && n) {
      e.preventDefault();
      setFlyActive((a) => (((a + (e.key === "ArrowDown" ? 1 : -1)) % n) + n) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pickModel(shownMore[flyActive]);
    }
  };
  const toggleThinking = () => {
    setInnerThinking(!isThinking);
    onThinkingChange?.(!isThinking);
  };
  const toggleSearch = () => {
    setInnerSearch(!isSearching);
    onWebSearchChange?.(!isSearching);
  };
  const chooseEffort = (next: ModelEffort) => {
    setInnerEffort(next);
    if (next !== effortNow) onEffortChange?.(next);
  };

  // The rows get stable handlers, so pointing at one row re-renders only the rows that change
  const latest = useRef({ point: (_i: number) => {}, pick: (_i: number) => {} });
  latest.current.point = (i: number) => {
    setActive(i);
    setPointing(true);
  };
  latest.current.pick = (i: number) => pick(i);
  const onPoint = useCallback((i: number) => latest.current.point(i), []);
  const onPick = useCallback((i: number) => latest.current.pick(i), []);

  // A long list scrolls – the row the arrows are on stays in view
  useEffect(() => {
    const list = listRef.current;
    const row = list?.children[active] as HTMLElement | undefined;
    if (!isOpen || !list || !row) return;
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
  }, [active, isOpen]);

  /* ---------- Keyboard ---------- */

  const onTriggerKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true, "list");
    }
  };
  const onListKey = (e: KeyboardEvent) => {
    const n = models.length;
    if (!n) return;
    const move = (to: number) => {
      e.preventDefault();
      setActive(((to % n) + n) % n);
      setPointing(true);
    };
    if (e.key === "ArrowDown") move(active + 1);
    else if (e.key === "ArrowUp") move(active - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(n - 1);
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(active);
    }
  };
  // The fill sits under the chosen level – the levels are as wide as their words, so it is measured
  const segRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const btn = segRef.current?.querySelector<HTMLElement>(`[data-effort="${effortNow}"]`);
    if (btn) setThumb({ x: btn.offsetLeft, w: btn.offsetWidth });
  }, [effortNow, isOpen, isThinking]);
  const onEffortKey = (e: KeyboardEvent) => {
    const i = efforts.findIndex((x) => x.id === effortNow);
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = efforts[(i + step + efforts.length) % efforts.length];
    chooseEffort(next.id);
    rootRef.current?.querySelector<HTMLElement>(`[data-effort="${next.id}"]`)?.focus();
  };
  const onRootKey = (e: KeyboardEvent) => {
    // 1 to 4 pick the first rows, as their keys show, except while typing in the search field
    if (keys && isOpen && /^[1-4]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey && !(e.target instanceof HTMLInputElement)) {
      const index = Number(e.key) - 1;
      if (models[index]) {
        e.preventDefault();
        pick(index);
      }
      return;
    }
    if (e.key !== "Escape" || !isOpen) return;
    e.stopPropagation();
    setOpen(false, "trigger");
  };

  /* ---------- What the last row says ---------- */

  const factor = isThinking ? THINK_FACTOR[effortNow] : 1;
  const litLatency = finite(lit?.latencyMs);
  const litPrice = finite(lit?.pricePerM);
  const latency = (litLatency ?? 0) * factor;
  const price = litPrice ?? 0;
  const rolled = useRolling({ latency, price }, 560);
  const hasStats = litLatency !== undefined || litPrice !== undefined;

  let caption: ReactNode;
  let captionKey: string;
  let spoken: string;
  const pointedToggle = toggles?.find((t) => hint === `toggle:${t.id}`);
  if (pointedToggle) {
    caption = pointedToggle.hint ?? pointedToggle.label;
    captionKey = hint as string;
    spoken = caption as string;
  } else if (hint === "effort" && effortHint) {
    caption = effortHint;
    captionKey = "effort";
    spoken = effortHint;
  } else if (hint === "search") {
    caption = isSearching ? "Looks things up on the web when it helps" : "Answers from what it already knows";
    captionKey = `search-${isSearching}`;
    spoken = caption as string;
  } else if (!hasStats && note != null) {
    caption = note;
    captionKey = "note";
    spoken = typeof note === "string" ? note : "";
  } else if (!hasStats) {
    caption = lit?.description ?? lit?.name ?? "";
    captionKey = `plain-${lit?.id}`;
    spoken = `${lit?.name ?? ""}: ${caption as string}`;
  } else {
    const parts: ReactNode[] = [];
    const words: string[] = [];
    if (litLatency !== undefined) {
      parts.push(<span key="l">~<b>{seconds(rolled.latency ?? latency)}</b> first token</span>);
      words.push(`about ${seconds(latency)} to the first token`);
    }
    if (litPrice !== undefined) {
      parts.push(<span key="p"><b>{dollars(rolled.price ?? price, price)}</b> / M tokens</span>);
      words.push(`${dollars(price, price)} per million tokens`);
    }
    caption = parts.flatMap((p, i) => (i ? [<span key={`d${i}`} className="ui-mdpc__dot"> · </span>, p] : [p]));
    // One key for every model with numbers – the numbers roll instead of the line swapping
    captionKey = "stats";
    spoken = `${lit.name}: ${words.join(", ")}`;
  }

  // Ids by position – a model id may hold spaces or slashes, which an element id can't
  const activeId = models[active] ? `${uid}-opt-${active}` : undefined;

  return (
    <div
      ref={rootRef}
      className={["ui-mdpc", className].filter(Boolean).join(" ")}
      data-open={isOpen ? "" : undefined}
      data-align={align}
      data-side={placedSide}
      onKeyDown={onRootKey}
      onBlur={(e) => {
        if (isOpen && e.relatedTarget && !rootRef.current?.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <style href="ui-model-picker-clean" precedence="default">
        {css}
      </style>

      <button
        ref={triggerRef}
        type="button"
        className="ui-mdpc__trigger"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={`${uid}-menu`}
        aria-label={triggerLabel ?? `${labels.model}: ${chosen?.name ?? "none"}${isThinking ? ", extended thinking" : ""}${(toggles ?? [])
          .filter((t) => (t.flag || t.indicator) && toggleOn[t.id])
          .map((t) => `, ${t.label}`)
          .join("")}`}
        onClick={() => setOpen(!isOpen, isOpen ? undefined : "list")}
        onKeyDown={onTriggerKey}
      >
        {triggerLead}
        {chosen && <Glyph model={chosen} />}
        <span className="ui-mdpc__name" title={chosen?.name}>
          <Swap id={chosen?.id ?? "none"} glide>
            {chosen?.name ?? labels.choose}
          </Swap>
        </span>
        {toggles
          ?.filter((t) => t.flag)
          .map((t) => (
            <span key={t.id} className="ui-mdpc__flag" data-on={toggleOn[t.id] ? "" : undefined} aria-hidden="true">
              <span>{t.icon ?? <ThinkIcon />}</span>
            </span>
          ))}
        {/* Your own levels always show on the trigger, so the level in use is never a guess */}
        {ownEffort && (
          <span className="ui-mdpc__detail">
            <Swap id={effortNow} glide>
              {efforts.find((x) => x.id === effortNow)?.label}
            </Swap>
          </span>
        )}
        {toggles
          ?.filter((t) => t.indicator)
          .map((t) => (
            <span key={t.id} className="ui-mdpc__unfold" data-id={t.id} data-on={toggleOn[t.id] ? "" : undefined} aria-hidden="true">
              <span className="ui-mdpc__detail">· {toggleOn[t.id] && t.onLabel ? t.onLabel : t.label}</span>
            </span>
          ))}
        {/* A small bulb unfolds next to the name while extended thinking is on */}
        <span className="ui-mdpc__flag" data-on={isThinking ? "" : undefined} aria-hidden="true">
          <span>
            <ThinkIcon />
          </span>
        </span>
        <ChevronIcon />
      </button>

      <div
        id={`${uid}-menu`}
        ref={popRef}
        className="ui-mdpc__pop"
        style={shift || room ? ({ ...(shift ? { translate: `${shift}px 0` } : {}), ...(room ? { "--ui-mdpc-room": `${room}px` } : {}) } as CSSProperties) : undefined}
        role="dialog"
        aria-label={labels.settings}
        inert={!isOpen}
      >
        {glow && (
          <div className="ui-mdpc__glow" data-leaving={glow.leaving ? "" : undefined} aria-hidden="true">
            {toggles?.find((t) => t.id === glow.id)?.effect}
          </div>
        )}
        <div className="ui-mdpc__card">
          <div className="ui-mdpc__head" aria-hidden="true" data-keys={keys ? "" : undefined}>
            <span>{heading ?? labels.model}</span>
            {anyRated && (
              <span className="ui-mdpc__cols">
                {STRENGTHS.map((s) => (
                  <span key={s.key}>{labels[s.key]}</span>
                ))}
              </span>
            )}
          </div>

          {models.length === 0 && <div className="ui-mdpc__empty">{labels.noModels}</div>}
          <div
            ref={listRef}
            className="ui-mdpc__list"
            role="listbox"
            aria-label={labels.model}
            tabIndex={0}
            aria-activedescendant={isOpen ? activeId : undefined}
            data-pointing={pointing ? "" : undefined}
            data-unrated={anyRated ? undefined : ""}
            data-keys={keys ? "" : undefined}
            onKeyDown={onListKey}
            onPointerLeave={() => setPointing(false)}
            onPointerEnter={() => flyOpen && closeFlySoon()}
          >
            {models.map((m, i) => (
              <Option
                key={m.id}
                model={m}
                index={i}
                optionId={`${uid}-opt-${i}`}
                selected={i === chosenIndex}
                active={i === active}
                lit={m.id === lit?.id}
                varies={labels.varies}
                onPoint={onPoint}
                onPick={onPick}
              />
            ))}
          </div>
          {more.length > 0 && (
            <div ref={moreRef} className="ui-mdpc__more">
              <button
                ref={moreBtnRef}
                type="button"
                className="ui-mdpc__more-btn"
                aria-haspopup="dialog"
                aria-expanded={flyOpen}
                data-open={flyOpen ? "" : undefined}
                data-side={flySide}
                onClick={() => (flyOpen ? closeFly() : openFly(true))}
                onPointerEnter={(e) => e.pointerType === "mouse" && openFlySoon()}
                onPointerLeave={closeFlySoon}
                onKeyDown={(e) => {
                  const toward = flySide === "right" ? "ArrowRight" : "ArrowLeft";
                  if (e.key !== toward && e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  openFly(true);
                }}
              >
                <span>{labels.moreModels}</span>
                <span className="ui-mdpc__more-count">{more.length}</span>
                <ChevronIcon />
              </button>
            </div>
          )}

          {toggles ? (
            <div className="ui-mdpc__settings">
              {efforts.length > 0 && (
                <div
                  className="ui-mdpc__effort ui-mdpc__effort--own"
                  onPointerEnter={(e) => e.pointerType === "mouse" && setHint("effort")}
                  onPointerLeave={() => setHint(null)}
                >
                  <span className="ui-mdpc__effort-label" id={`${uid}-effort`}>
                    {effortLabel}
                  </span>
                  <div
                    ref={segRef}
                    className="ui-mdpc__segmented"
                    role="radiogroup"
                    aria-labelledby={`${uid}-effort`}
                    style={thumb ? { ["--x" as string]: `${thumb.x}px`, ["--w" as string]: `${thumb.w}px` } : undefined}
                    onKeyDown={onEffortKey}
                  >
                    <span className="ui-mdpc__thumb" aria-hidden="true" />
                    {efforts.map((x) => (
                      <button
                        key={x.id}
                        type="button"
                        role="radio"
                        aria-checked={x.id === effortNow}
                        tabIndex={x.id === effortNow ? 0 : -1}
                        data-effort={x.id}
                        className="ui-mdpc__seg-btn"
                        onClick={() => chooseEffort(x.id)}
                      >
                        {x.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {toggles.map((t) => (
                <Fragment key={t.id}>
                <button
                  type="button"
                  role="switch"
                  aria-checked={!!toggleOn[t.id]}
                  disabled={t.disabled}
                  className="ui-mdpc__toggle"
                  data-id={t.id}
                  onClick={() => flip(t.id)}
                  onPointerEnter={(e) => e.pointerType === "mouse" && setHint(`toggle:${t.id}`)}
                  onPointerLeave={() => setHint(null)}
                  onFocus={() => setHint(`toggle:${t.id}`)}
                  onBlur={() => setHint(null)}
                >
                  <span className="ui-mdpc__toggle-icon">{t.icon ?? <ThinkIcon />}</span>
                  <span className="ui-mdpc__toggle-label">{toggleOn[t.id] && t.onLabel ? t.onLabel : t.label}</span>
                  <span className="ui-mdpc__switch" aria-hidden="true" />
                </button>
                {t.reset && (
                  <button
                    type="button"
                    className="ui-mdpc__reset"
                    disabled={t.disabled}
                    onClick={(e) => {
                      // The row goes once reset, so focus stays in the menu on its switch.
                      (e.currentTarget.previousElementSibling as HTMLElement | null)?.focus();
                      t.reset?.onReset();
                    }}
                  >
                    {t.reset.label}
                  </button>
                )}
                </Fragment>
              ))}
            </div>
          ) : (
          <div className="ui-mdpc__settings">
            <button
              type="button"
              role="switch"
              aria-checked={isThinking}
              className="ui-mdpc__toggle"
              onClick={toggleThinking}
            >
              <span className="ui-mdpc__toggle-icon">
                <ThinkIcon />
              </span>
              <span className="ui-mdpc__toggle-label">Extended thinking</span>
              <span className="ui-mdpc__switch" aria-hidden="true" />
            </button>

            {/* Effort unfolds under thinking, in place */}
            <div className="ui-mdpc__fold" data-open={isThinking ? "" : undefined} inert={!isThinking}>
              <div className="ui-mdpc__clip">
                <div className="ui-mdpc__effort">
                  <span className="ui-mdpc__effort-label" id={`${uid}-effort`}>
                    Effort
                  </span>
                  <div
                    ref={segRef}
                    className="ui-mdpc__segmented"
                    role="radiogroup"
                    aria-labelledby={`${uid}-effort`}
                    style={thumb ? { ["--x" as string]: `${thumb.x}px`, ["--w" as string]: `${thumb.w}px` } : undefined}
                    onKeyDown={onEffortKey}
                  >
                    <span className="ui-mdpc__thumb" aria-hidden="true" />
                    {EFFORTS.map((x) => (
                      <button
                        key={x.id}
                        type="button"
                        role="radio"
                        aria-checked={x.id === effortNow}
                        tabIndex={x.id === effortNow ? 0 : -1}
                        data-effort={x.id}
                        className="ui-mdpc__seg-btn"
                        onClick={() => chooseEffort(x.id)}
                      >
                        {x.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <button
              type="button"
              role="switch"
              aria-checked={isSearching}
              className="ui-mdpc__toggle"
              onClick={toggleSearch}
              onPointerEnter={(e) => e.pointerType === "mouse" && setHint("search")}
              onPointerLeave={() => setHint(null)}
              onFocus={() => setHint("search")}
              onBlur={() => setHint(null)}
            >
              <span className="ui-mdpc__toggle-icon">
                <GlobeIcon />
              </span>
              <span className="ui-mdpc__toggle-label">Web search</span>
              <span className="ui-mdpc__switch" aria-hidden="true" />
            </button>
          </div>
          )}
        </div>

        {/* The last row: what the model you point at costs you */}
        <div className="ui-mdpc__foot">
          <span className="ui-mdpc__caption" aria-hidden="true">
            <Swap id={captionKey}>{caption}</Swap>
          </span>
          <span className="ui-mdpc__keys" aria-hidden="true">
            {keys ? <kbd>1–4</kbd> : <kbd>↑↓</kbd>}
            <kbd>↵</kbd>
          </span>
          <span className="ui-mdpc__sr" aria-live="polite">
            {isOpen ? spoken : ""}
          </span>
        </div>

        {flyOpen && (
          <div
            ref={flyRef}
            className="ui-mdpc__fly"
            data-side={flySide}
            style={{ top: flyTop }}
            role="dialog"
            aria-label={labels.moreModels}
            onPointerEnter={() => window.clearTimeout(flyTimer.current)}
            onPointerLeave={closeFlySoon}
          >
            <input
              ref={searchRef}
              className="ui-mdpc__search"
              placeholder={labels.searchModels}
              role="combobox"
              aria-label={labels.searchModels}
              aria-expanded="true"
              aria-controls={`${uid}-more`}
              aria-activedescendant={shownMore[flyActive] ? `${uid}-more-${flyActive}` : undefined}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setFlyActive(0);
              }}
              onKeyDown={onFlyKey}
            />
            <div id={`${uid}-more`} className="ui-mdpc__fly-list" role="listbox" aria-label={labels.moreModels}>
              {shownMore.length === 0 && <div className="ui-mdpc__empty">{labels.noMatch}</div>}
              {shownMore.map((m, i) => (
                <div
                  key={m.id}
                  id={`${uid}-more-${i}`}
                  role="option"
                  aria-selected={m.id === chosen?.id}
                  className="ui-mdpc__fly-row"
                  data-active={i === flyActive ? "" : undefined}
                  onPointerEnter={() => setFlyActive(i)}
                  onClick={() => pickModel(m)}
                >
                  <Glyph model={m} />
                  <span className="ui-mdpc__title-name" dir="auto" title={m.name}>
                    {m.name}
                  </span>
                  {m.id === chosen?.id && <CheckIcon />}
                </div>
              ))}
            </div>
            {moreNote && <div className="ui-mdpc__fly-note">{moreNote}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

const css = /* css */ `
/* Colors and motion as variables – override them on .ui-mdpc */
.ui-mdpc {
  --ui-mdpc-card: #ffffff;
  --ui-mdpc-strong: #000000;
  --ui-mdpc-ink: rgba(0, 0, 0, 0.88);
  --ui-mdpc-text: rgba(0, 0, 0, 0.61);
  --ui-mdpc-muted: rgba(0, 0, 0, 0.45);
  --ui-mdpc-faint: rgba(0, 0, 0, 0.27);
  --ui-mdpc-icon: rgba(0, 0, 0, 0.447);
  --ui-mdpc-line: rgba(0, 0, 0, 0.06);
  --ui-mdpc-line-strong: rgba(0, 0, 0, 0.1);
  --ui-mdpc-fill: rgba(0, 0, 0, 0.06);
  --ui-mdpc-wash: rgba(0, 0, 0, 0.03);
  --ui-mdpc-bar: rgba(0, 0, 0, 0.2);
  --ui-mdpc-bar-off: rgba(0, 0, 0, 0.06);
  --ui-mdpc-switch: rgba(0, 0, 0, 0.1);
  --ui-mdpc-knob: #ffffff;
  --ui-mdpc-accent: rgba(0, 96, 226, 0.765);
  --ui-mdpc-focus: rgba(0, 96, 226, 0.35);
  /* Strokes are shadows: a 0.5px hairline plus a soft lift */
  --ui-mdpc-shadow-tile: 0 0 0 0.5px rgba(0, 0, 0, 0.1), 0 1px 1px -1px rgba(0, 0, 0, 0.1);
  --ui-mdpc-shadow-pop: 0 0 0 0.5px rgba(0, 0, 0, 0.08), 0 12px 28px -10px rgba(0, 0, 0, 0.16), 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --ui-mdpc-ease: cubic-bezier(0.32, 0.72, 0.24, 1);
  position: relative;
  display: inline-block;
  max-width: 100%;
  min-width: 0;
  font-family: "Inter", "InterVariable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  line-height: 20px;
  font-weight: 400;
  color: var(--ui-mdpc-ink);
  text-align: left;
  -webkit-font-smoothing: antialiased;
}
.ui-mdpc *, .ui-mdpc *::before, .ui-mdpc *::after { box-sizing: border-box; }
:where(.ui-mdpc) button { appearance: none; margin: 0; padding: 0; border: 0; background: none; font: inherit; color: inherit; text-align: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }
.ui-mdpc button:focus-visible { outline: 2px solid var(--ui-mdpc-focus); outline-offset: 1px; }
.ui-mdpc svg { display: block; flex: none; }
.ui-mdpc b { font-weight: 500; color: var(--ui-mdpc-ink); }
.ui-mdpc__sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

/* ----- Trigger: a quiet button – glyph, name and a small chevron ----- */
.ui-mdpc__trigger { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; height: 28px; padding: 0 6px 0 6px; border-radius: 6px; font-weight: 500; color: var(--ui-mdpc-text); white-space: nowrap; transition: background-color 160ms ease, color 160ms ease; }
.ui-mdpc__trigger:hover, .ui-mdpc[data-open] .ui-mdpc__trigger { background: var(--ui-mdpc-wash); color: var(--ui-mdpc-ink); }
.ui-mdpc__trigger .ui-mdpc__glyph { width: 18px; height: 18px; border-radius: 5px; font-size: 10px; }
.ui-mdpc__trigger .ui-mdpc__glyph > svg { width: 10px; height: 10px; }
/* Kettu: the track may shrink below the gliding width, so a long name ends in an ellipsis rather than running under the effort in a narrow composer. */
.ui-mdpc__name { display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; }
.ui-mdpc__chevron { margin-left: -2px; color: var(--ui-mdpc-icon); transition: transform 300ms var(--ui-mdpc-ease); }
.ui-mdpc[data-open] .ui-mdpc__chevron { transform: rotate(180deg); }
.ui-mdpc__flag { display: grid; grid-template-columns: 0fr; margin-left: -6px; opacity: 0; color: var(--ui-mdpc-accent); transition: grid-template-columns 360ms var(--ui-mdpc-ease), margin 360ms var(--ui-mdpc-ease), opacity 220ms ease; }
.ui-mdpc__flag > span { min-width: 0; overflow: hidden; }
.ui-mdpc__flag svg { width: 14px; height: 14px; }
.ui-mdpc__flag[data-on] { grid-template-columns: 1fr; margin-left: -2px; opacity: 1; transition: grid-template-columns 360ms var(--ui-mdpc-ease), margin 360ms var(--ui-mdpc-ease), opacity 280ms ease 80ms; }

/* Glyph: a small white tile with a hairline */
.ui-mdpc__glyph { display: grid; flex: none; place-items: center; width: 20px; height: 20px; overflow: hidden; border-radius: 5px; background: var(--ui-mdpc-card); box-shadow: var(--ui-mdpc-shadow-tile); font-size: 10px; font-weight: 500; line-height: 1; color: var(--ui-mdpc-strong); }
.ui-mdpc__glyph > svg, .ui-mdpc__glyph > img { width: 12px; height: 12px; }

/* ----- Menu: one white popover, unfolds softly from the trigger ----- */
.ui-mdpc__pop {
  position: absolute;
  z-index: 30;
  top: calc(100% + 6px);
  left: 0;
  width: min(320px, calc(100vw - 32px));
  container-type: inline-size;
  border-radius: 10px;
  background: var(--ui-mdpc-card);
  box-shadow: var(--ui-mdpc-shadow-pop);
  transform-origin: top left;
  opacity: 0;
  visibility: hidden;
  transform: translateY(-4px) scale(0.96);
  transition: opacity 160ms ease, transform 220ms var(--ui-mdpc-ease), visibility 0s linear 220ms;
}
.ui-mdpc[data-align="end"] .ui-mdpc__pop { left: auto; right: 0; transform-origin: top right; }
.ui-mdpc[data-side="top"] .ui-mdpc__pop { top: auto; bottom: calc(100% + 6px); transform-origin: bottom left; transform: translateY(4px) scale(0.96); }
.ui-mdpc[data-side="top"][data-align="end"] .ui-mdpc__pop { transform-origin: bottom right; }
.ui-mdpc[data-open] .ui-mdpc__pop { opacity: 1; visibility: visible; transform: none; transition: opacity 200ms ease, transform 320ms var(--ui-mdpc-ease), visibility 0s; }

.ui-mdpc__card { padding: 4px; }
/* With too little room on either side the menu takes what there is, and only its list of models gives way and scrolls */
.ui-mdpc__pop { display: flex; flex-direction: column; max-height: var(--ui-mdpc-room, none); }
.ui-mdpc__card { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; }
.ui-mdpc__card > *, .ui-mdpc__foot { flex: none; }
.ui-mdpc__card > .ui-mdpc__list { flex: 0 1 auto; min-height: 48px; }
/* A switch's effect sits behind the menu's rows, clipped to its corners */
.ui-mdpc__glow { position: absolute; inset: 0; z-index: 0; overflow: hidden; border-radius: inherit; pointer-events: none; animation: ui-mdpc-glow-in 420ms ease both; transition: opacity 400ms ease; }
.ui-mdpc__glow[data-leaving] { opacity: 0; animation: none; }
.ui-mdpc__card, .ui-mdpc__foot { position: relative; z-index: 1; }
@keyframes ui-mdpc-glow-in { from { opacity: 0; } to { opacity: 1; } }
.ui-mdpc__head { display: flex; align-items: center; justify-content: space-between; gap: 12px; height: 28px; padding: 4px 8px 0; font-size: 10px; font-weight: 500; line-height: 16px; letter-spacing: 0.5px; text-transform: uppercase; color: var(--ui-mdpc-muted); }
.ui-mdpc__cols { display: grid; grid-template-columns: repeat(3, 40px); gap: 8px; }
.ui-mdpc__cols > span { display: flex; justify-content: center; white-space: nowrap; }

/* ----- Rows ----- */
.ui-mdpc__list { display: grid; gap: 0; border-radius: 6px; outline: none; position: relative; max-height: min(360px, 50vh); overflow-y: auto; overscroll-behavior: contain; }
/* No models: one quiet line instead of an empty menu */
.ui-mdpc__empty { padding: 14px 8px; font-size: 12px; line-height: 16px; color: var(--ui-mdpc-muted); text-align: center; }
.ui-mdpc__option { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 6px 8px; border-radius: 6px; cursor: pointer; transition: background-color 90ms ease-out, opacity 200ms ease; }
/* The fill appears crisply on the row under the pointer and fades out when the pointer leaves the list */
.ui-mdpc__list[data-pointing] .ui-mdpc__option[data-active] { background: var(--ui-mdpc-fill); }
.ui-mdpc__list:focus-visible { outline: none; }
.ui-mdpc__list:focus-visible .ui-mdpc__option[data-active] { background: var(--ui-mdpc-fill); box-shadow: inset 0 0 0 1px var(--ui-mdpc-focus); }
.ui-mdpc__list[data-pointing] .ui-mdpc__option:not([data-active]) { opacity: 0.55; }
.ui-mdpc__text { display: grid; flex: 1; min-width: 0; }
.ui-mdpc__title { display: flex; align-items: center; gap: 4px; min-width: 0; font-weight: 500; color: var(--ui-mdpc-strong); }
.ui-mdpc__title-name { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ui-mdpc__check { color: var(--ui-mdpc-accent); animation: ui-mdpc-pop 320ms var(--ui-mdpc-ease) both; }
.ui-mdpc__desc { overflow: hidden; font-size: 12px; line-height: 16px; color: var(--ui-mdpc-text); white-space: nowrap; text-overflow: ellipsis; }

/* Strength bars: five small segments each. The lit row fills them one after another, in the accent */
.ui-mdpc__bars { display: grid; flex: none; grid-template-columns: repeat(3, 40px); gap: 8px; }
.ui-mdpc__meter { display: grid; grid-template-columns: repeat(5, 1fr); gap: 2px; height: 4px; }
.ui-mdpc__seg { border-radius: 1px; background: var(--ui-mdpc-bar-off); transition: background-color 180ms ease, transform 260ms var(--ui-mdpc-ease); }
.ui-mdpc__seg[data-on] { background: var(--ui-mdpc-bar); }
.ui-mdpc__option[data-lit] .ui-mdpc__seg[data-on] { background: var(--ui-mdpc-accent); transition-delay: calc(var(--c) * 70ms + var(--s) * 45ms); animation: ui-mdpc-fill 360ms var(--ui-mdpc-ease) both; animation-delay: calc(var(--c) * 70ms + var(--s) * 45ms); }
.ui-mdpc__varies { flex: none; width: 136px; font-size: 12px; line-height: 16px; color: var(--ui-mdpc-muted); text-align: center; }

/* ----- Switches and effort ----- */
.ui-mdpc__settings { margin: 4px -4px 0; padding: 4px 4px 0; border-top: 0.5px solid var(--ui-mdpc-line); }
.ui-mdpc__toggle { display: flex; align-items: center; gap: 10px; width: 100%; height: 32px; padding: 0 8px; border-radius: 6px; color: var(--ui-mdpc-ink); transition: background-color 90ms ease-out; }
.ui-mdpc__toggle:hover { background: var(--ui-mdpc-fill); }
.ui-mdpc__toggle-icon { display: grid; flex: none; place-items: center; width: 20px; color: var(--ui-mdpc-icon); transition: color 200ms ease; }
.ui-mdpc__toggle[aria-checked="true"] .ui-mdpc__toggle-icon { color: var(--ui-mdpc-ink); }
.ui-mdpc__toggle-label { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
/* Switch: a soft square track – no full pill – that turns blue when on */
.ui-mdpc__switch { position: relative; flex: none; width: 26px; height: 16px; border-radius: 5px; background: var(--ui-mdpc-switch); transition: background-color 220ms ease; }
.ui-mdpc__switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 3.5px; background: var(--ui-mdpc-knob); box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.16); transition: transform 280ms var(--ui-mdpc-ease); }
.ui-mdpc__toggle[aria-checked="true"] .ui-mdpc__switch { background: var(--ui-mdpc-accent); }
.ui-mdpc__toggle[aria-checked="true"] .ui-mdpc__switch::after { transform: translateX(10px); }

.ui-mdpc__fold { display: grid; grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows 420ms var(--ui-mdpc-ease), opacity 220ms ease; }
.ui-mdpc__fold[data-open] { grid-template-rows: 1fr; opacity: 1; transition: grid-template-rows 420ms var(--ui-mdpc-ease), opacity 320ms ease 100ms; }
.ui-mdpc__clip { min-height: 0; overflow: hidden; }
/* Effort: the label lines up with the switch labels, the levels are tab buttons with a fill that slides */
.ui-mdpc__effort { display: flex; align-items: center; gap: 10px; padding: 2px 8px 6px 38px; }
.ui-mdpc__effort-label { flex: 1; min-width: 0; color: var(--ui-mdpc-text); }
/* Each level is as wide as its word; the fill is measured and glides from one to the next */
.ui-mdpc__segmented { position: relative; display: flex; flex: none; gap: 4px; }
.ui-mdpc__thumb { position: absolute; top: 0; bottom: 0; left: 0; width: var(--w, 0); border-radius: 5px; background: var(--ui-mdpc-fill); transform: translateX(var(--x, 0)); transition: transform 220ms var(--ui-mdpc-ease), width 220ms var(--ui-mdpc-ease); }
.ui-mdpc__seg-btn { position: relative; height: 22px; padding: 0 7px; border-radius: 5px; box-shadow: inset 0 0 0 0.5px var(--ui-mdpc-line); font-size: 12px; font-weight: 500; line-height: 16px; color: var(--ui-mdpc-text); text-align: center !important; transition: color 160ms ease, background-color 160ms ease; }
.ui-mdpc__seg-btn[aria-checked="true"] { color: var(--ui-mdpc-ink); }
.ui-mdpc__seg-btn[aria-checked="false"]:hover { background: var(--ui-mdpc-wash); color: var(--ui-mdpc-ink); }

/* Your own effort levels: the label on top, the levels across the menu */
.ui-mdpc__effort--own { flex-wrap: wrap; gap: 6px 10px; padding: 6px 8px 8px; }
.ui-mdpc__effort--own .ui-mdpc__effort-label { flex-basis: 100%; }
.ui-mdpc__effort--own .ui-mdpc__segmented { flex: 1; }
.ui-mdpc__effort--own .ui-mdpc__seg-btn { flex: 1; padding: 0 4px; }
.ui-mdpc__toggle:disabled { opacity: 0.45; cursor: default; }
.ui-mdpc__reset { display: block; width: 100%; height: 24px; margin-top: -2px; padding: 0 8px 0 38px; border-radius: 6px; font-size: 12px; line-height: 16px; text-align: left; color: var(--ui-mdpc-muted); }
.ui-mdpc__reset:hover { background: var(--ui-mdpc-fill); color: var(--ui-mdpc-ink); }
.ui-mdpc__reset:disabled { opacity: 0.45; cursor: default; }
.ui-mdpc__fly-note { margin: 4px -4px -4px; padding: 6px 12px 8px; border-top: 0.5px solid var(--ui-mdpc-line); font-size: 12px; line-height: 16px; color: var(--ui-mdpc-muted); }
.ui-mdpc__toggle:disabled:hover { background: none; }
/* No ratings anywhere: no "Varies" column either */
.ui-mdpc__list[data-unrated] .ui-mdpc__varies { display: none; }
.ui-mdpc__list[data-unrated] .ui-mdpc__option { min-height: 40px; }
/* Number keys on the first four rows */
.ui-mdpc__list[data-keys] { counter-reset: ui-mdpc-key; }
.ui-mdpc__list[data-keys] .ui-mdpc__option { counter-increment: ui-mdpc-key; }
.ui-mdpc__list[data-keys] .ui-mdpc__option::after { content: ""; flex: none; width: 16px; font-size: 11px; line-height: 16px; text-align: center; color: var(--ui-mdpc-faint); }
.ui-mdpc__list[data-keys] .ui-mdpc__option:nth-child(-n + 4)::after { content: counter(ui-mdpc-key); }
/* The key column (16px and its gap) also sits right of the column names, so they stay over their bars */
.ui-mdpc__head[data-keys] { padding-right: 34px; }
.ui-mdpc__detail { flex: none; margin-left: -2px; color: var(--ui-mdpc-muted); font-weight: 400; }
/* A switch's "· label" opens and closes in the flags' motion: its width glides from nothing, then the words fade in */
.ui-mdpc__unfold { display: grid; grid-template-columns: 0fr; margin-left: -6px; opacity: 0; transition: grid-template-columns 360ms var(--ui-mdpc-ease), margin 360ms var(--ui-mdpc-ease), opacity 220ms ease; }
.ui-mdpc__unfold > .ui-mdpc__detail { min-width: 0; overflow: hidden; margin-left: 0; }
.ui-mdpc__unfold[data-on] { grid-template-columns: 1fr; margin-left: -2px; opacity: 1; transition: grid-template-columns 360ms var(--ui-mdpc-ease), margin 360ms var(--ui-mdpc-ease), opacity 280ms ease 80ms; }
/* More models: one quiet row that turns into a search field */
.ui-mdpc__more { padding: 2px 0 0; }
.ui-mdpc__more-btn { display: flex; align-items: center; gap: 8px; width: 100%; height: 32px; padding: 0 8px; border-radius: 6px; color: var(--ui-mdpc-text); }
.ui-mdpc__more-btn:hover { background: var(--ui-mdpc-fill); color: var(--ui-mdpc-ink); }
.ui-mdpc__more-btn > span:first-child { flex: 1; text-align: left; }
.ui-mdpc__more-btn .ui-mdpc__chevron, .ui-mdpc[data-open] .ui-mdpc__more-btn .ui-mdpc__chevron { transform: rotate(-90deg); }
.ui-mdpc__more-count { font-size: 12px; color: var(--ui-mdpc-muted); font-variant-numeric: tabular-nums; }
.ui-mdpc__more-btn[data-open] { background: var(--ui-mdpc-fill); color: var(--ui-mdpc-ink); }
.ui-mdpc__more-btn[data-side="left"] .ui-mdpc__chevron, .ui-mdpc[data-open] .ui-mdpc__more-btn[data-side="left"] .ui-mdpc__chevron { transform: rotate(90deg); }
/* More models: a second card beside the menu */
.ui-mdpc__fly { position: absolute; z-index: 1; left: calc(100% + 6px); width: 260px; padding: 4px; border-radius: 10px; background: var(--ui-mdpc-card); box-shadow: var(--ui-mdpc-shadow-pop); animation: ui-mdpc-fly-in 200ms var(--ui-mdpc-ease) both; }
.ui-mdpc__fly[data-side="left"] { left: auto; right: calc(100% + 6px); animation-name: ui-mdpc-fly-in-left; }
.ui-mdpc__fly-list { display: grid; max-height: 240px; margin-top: 4px; overflow-y: auto; overscroll-behavior: contain; }
.ui-mdpc__fly-row { display: flex; align-items: center; gap: 10px; min-height: 32px; padding: 0 8px; border-radius: 6px; font-weight: 500; color: var(--ui-mdpc-strong); cursor: pointer; }
.ui-mdpc__fly-row[data-active] { background: var(--ui-mdpc-fill); }
.ui-mdpc__fly-row .ui-mdpc__title-name { flex: 1; }
@keyframes ui-mdpc-fly-in { from { opacity: 0; transform: translateX(-4px) scale(0.98); } }
@keyframes ui-mdpc-fly-in-left { from { opacity: 0; transform: translateX(4px) scale(0.98); } }
.ui-mdpc__search { width: 100%; height: 30px; margin: 0; padding: 0 8px; border: 0; border-radius: 6px; outline: 0; background: var(--ui-mdpc-wash); box-shadow: inset 0 0 0 0.5px var(--ui-mdpc-line-strong); font: inherit; font-size: 13px; color: var(--ui-mdpc-ink); }
.ui-mdpc__search::placeholder { color: var(--ui-mdpc-faint); }

/* ----- Last row: what the model you point at costs you ----- */
.ui-mdpc__foot { display: flex; align-items: center; gap: 8px; min-height: 36px; padding: 6px 8px 6px 12px; border-top: 0.5px solid var(--ui-mdpc-line); }
.ui-mdpc__caption { flex: 1; min-width: 0; overflow: hidden; font-size: 12px; line-height: 16px; color: var(--ui-mdpc-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.ui-mdpc__dot { color: var(--ui-mdpc-faint); }
.ui-mdpc__swap { display: grid; min-width: 0; }
/* Gliding: the box takes the new text's width over the flags' 360ms; each line keeps its own width inside it, so the
   old one fades out whole and the new one is measured as it is */
.ui-mdpc__swap[data-glide] { max-width: 100%; overflow: hidden; transition: width 360ms var(--ui-mdpc-ease); }
.ui-mdpc__swap[data-glide] > .ui-mdpc__swap-item { justify-self: start; }
.ui-mdpc__swap-item { grid-area: 1 / 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; animation: ui-mdpc-swap-in 320ms ease both; }
.ui-mdpc__swap-item[data-out] { animation: ui-mdpc-swap-out 220ms ease both; }
/* The caption may take two lines – a price or a long description is never cut off on one */
.ui-mdpc__caption .ui-mdpc__swap-item { display: -webkit-box; white-space: normal; text-overflow: clip; overflow-wrap: anywhere; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.ui-mdpc__keys { display: flex; flex: none; gap: 2px; }
.ui-mdpc__keys kbd { display: grid; place-items: center; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 5px; box-shadow: inset 0 0 0 0.5px var(--ui-mdpc-line-strong); font-family: inherit; font-size: 11px; font-weight: 500; line-height: 16px; color: var(--ui-mdpc-muted); }

@keyframes ui-mdpc-swap-in { from { opacity: 0; filter: blur(2px); } }
@keyframes ui-mdpc-swap-out { from { opacity: 1; } to { opacity: 0; filter: blur(2px); } }
@keyframes ui-mdpc-pop { from { opacity: 0; transform: scale(0.6); } }
@keyframes ui-mdpc-fill { 0% { transform: scaleY(1); } 45% { transform: scaleY(1.6); } 100% { transform: scaleY(1); } }

/* Narrow menus: the glyphs in the rows and the key hints give way, effort moves left */
@container (max-width: 300px) {
  .ui-mdpc__option .ui-mdpc__glyph { display: none; }
  .ui-mdpc__keys { display: none; }
  .ui-mdpc__effort { padding-left: 8px; }
}

@media (pointer: coarse) {
  .ui-mdpc__trigger { height: 34px; }
  .ui-mdpc__option { min-height: 52px; }
  .ui-mdpc__toggle { height: 40px; }
  .ui-mdpc__seg-btn { height: 30px; padding: 0 10px; }
  .ui-mdpc__keys { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  .ui-mdpc *, .ui-mdpc *::before, .ui-mdpc *::after { animation: none !important; transition: none !important; }
}

/* Dark mode: follows a .dark class or data-theme="dark" on any ancestor, e.g. <html> */
:where(.dark, [data-theme="dark"]) .ui-mdpc {
  --ui-mdpc-card: #1c1c1e;
  --ui-mdpc-strong: #ffffff;
  --ui-mdpc-ink: rgba(255, 255, 255, 0.9);
  --ui-mdpc-text: rgba(255, 255, 255, 0.62);
  --ui-mdpc-muted: rgba(255, 255, 255, 0.46);
  --ui-mdpc-faint: rgba(255, 255, 255, 0.3);
  --ui-mdpc-icon: rgba(255, 255, 255, 0.5);
  --ui-mdpc-line: rgba(255, 255, 255, 0.08);
  --ui-mdpc-line-strong: rgba(255, 255, 255, 0.12);
  --ui-mdpc-fill: rgba(255, 255, 255, 0.08);
  --ui-mdpc-wash: rgba(255, 255, 255, 0.04);
  --ui-mdpc-bar: rgba(255, 255, 255, 0.24);
  --ui-mdpc-bar-off: rgba(255, 255, 255, 0.08);
  --ui-mdpc-switch: rgba(255, 255, 255, 0.14);
  --ui-mdpc-knob: #ffffff;
  --ui-mdpc-accent: #4d8dff;
  --ui-mdpc-focus: rgba(77, 141, 255, 0.5);
  --ui-mdpc-shadow-tile: 0 0 0 0.5px rgba(255, 255, 255, 0.12), 0 1px 2px rgba(0, 0, 0, 0.4);
  --ui-mdpc-shadow-pop: 0 0 0 0.5px rgba(255, 255, 255, 0.12), 0 12px 28px -10px rgba(0, 0, 0, 0.6), 0 1px 2px 0 rgba(0, 0, 0, 0.4);
}
:where(.dark, [data-theme="dark"]) .ui-mdpc__glyph { background: #2a2a2d; }
`;
